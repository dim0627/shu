import {
  appendFileSync,
  copyFileSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { hasErrno, ShuError } from "./errors";
import { buildEntry, DEFAULT_AUTHOR, formatEntry, type LogEntry, parseLog } from "./log";
import { normalizeRef } from "./ref";
import {
  artifactsDir,
  createTaskDir,
  globalLock,
  loadTasks,
  logFile,
  readTask,
  resolveId,
  taskDir,
  taskFile,
  taskLock,
  uniqueSuffix,
  withLock,
  writeFileAtomic,
} from "./store";
import {
  applyUpdate,
  differingFields,
  labelsOf,
  parseNote,
  parseSaveInput,
  type SaveInput,
  serializeTask,
  type SkippedField,
  type Status,
  STATUSES,
  type Task,
} from "./task";
import { trimBlankEdges } from "./text";
import { formatLocalIso } from "./time";

export interface Ctx {
  home: string;
  now: () => Date;
  random: () => number;
}

export type TaskSummary = Pick<
  Task,
  "id" | "title" | "kind" | "status" | "note" | "refs" | "ref_labels" | "created" | "updated"
>;
export type TaskDetail = TaskSummary & Pick<Task, "body">;
export type SaveResult = "created" | "updated" | "matched";
export type KindCount = { kind: string; count: number };
export type ArtifactSource = { path: string } | { data: Uint8Array };

const DEFAULT_STATUSES: Status[] = ["open", "waiting"];
const FIELDS = ["title", "kind", "status", "note", "body"] as const;

const unique = <T>(items: T[]) => [...new Set(items)];

function parseStatus(value: string): Status {
  if (!STATUSES.includes(value as Status)) {
    throw new ShuError("invalid_input", `status must be one of ${STATUSES.join(" / ")}: ${value}`);
  }
  return value as Status;
}

function summary({ id, title, kind, status, note, refs, ref_labels, created, updated }: Task): TaskSummary {
  return { id, title, kind, status, note, refs, ref_labels, created, updated };
}

function detail(task: Task): TaskDetail {
  return { ...summary(task), body: task.body };
}

export function list(
  ctx: Ctx,
  options: { statuses?: string[]; kinds?: string[]; all?: boolean } = {},
): { tasks: TaskSummary[] } {
  const { statuses = [], kinds = [], all = false } = options;
  if (all && statuses.length > 0) {
    throw new ShuError("invalid_input", "--all and --status cannot be used together");
  }
  const given = statuses.map(parseStatus);
  const wanted: readonly Status[] = all ? STATUSES : given.length > 0 ? given : DEFAULT_STATUSES;
  const tasks = loadTasks(ctx.home)
    .filter((task) => wanted.includes(task.status))
    .filter((task) => kinds.length === 0 || kinds.includes(task.kind))
    .sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated) || b.id.localeCompare(a.id));
  return { tasks: tasks.map(summary) };
}

export function kinds(ctx: Ctx): { kinds: KindCount[] } {
  const counts = new Map<string, number>();
  for (const { kind } of loadTasks(ctx.home)) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  const kinds = [...counts]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => b.count - a.count || (a.kind < b.kind ? -1 : 1));
  return { kinds };
}

// logLimit keeps the last entries; log_total still counts them all, so a shortened log does not
// read as the whole of it
export function show(
  ctx: Ctx,
  idInput: string,
  logLimit?: number,
): { task: TaskDetail; log: LogEntry[]; log_total: number; artifacts: string[] } {
  const id = resolveId(ctx.home, idInput);
  const log = parseLog(readOptional(logFile(ctx.home, id)));
  return {
    task: detail(readTask(ctx.home, id)),
    // slice(-0) would return every entry
    log: logLimit === undefined ? log : log.slice(Math.max(log.length - logLimit, 0)),
    log_total: log.length,
    artifacts: listArtifacts(ctx.home, id),
  };
}

function readOptional(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    if (hasErrno(e, "ENOENT")) return "";
    throw e;
  }
}

function listArtifacts(home: string, id: string): string[] {
  try {
    return readdirSync(artifactsDir(home, id), { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();
  } catch (e) {
    if (hasErrno(e, "ENOENT")) return [];
    throw e;
  }
}

export function save(
  ctx: Ctx,
  inputText: string,
  removeRefInputs: string[] = [],
): { result: SaveResult; task: TaskDetail; skipped: SkippedField[] } {
  const input = parseSaveInput(inputText);
  const given = (input.refs ?? []).map(({ ref, label }) => ({ ref: normalizeRef(ref), label }));
  const addRefs = unique(given.map(({ ref }) => ref));
  const labels: Record<string, string> = {};
  for (const { ref, label } of given) {
    if (label === undefined) continue;
    if (ref in labels && labels[ref] !== label) {
      throw new ShuError("invalid_input", `ref ${ref} is given with two different labels`);
    }
    labels[ref] = label;
  }
  const removeRefs = unique(removeRefInputs.map(normalizeRef));
  const both = addRefs.find((ref) => removeRefs.includes(ref));
  if (both !== undefined) {
    throw new ShuError("invalid_input", `the same ref is in both refs and --remove-ref: ${both}`);
  }

  const run = () => {
    const target = findTarget(ctx.home, input.id, addRefs);
    if (!target) {
      if (removeRefs.length > 0) {
        throw new ShuError("invalid_input", "--remove-ref needs an existing task: give its id or one of its refs");
      }
      const result: SaveResult = "created";
      return { result, task: detail(createTask(ctx, input, addRefs, labels)), skipped: [] };
    }
    // Input without an id may have been written to create a task, so on a match it must not overwrite one
    const matched = target.result === "matched";
    const task = updateTask(ctx, target.id, matched ? {} : input, addRefs, removeRefs, {
      skipUnchanged: matched,
      labels,
    });
    return { result: target.result, task: detail(task), skipped: matched ? differingFields(task, input) : [] };
  };

  // A save that leaves refs alone cannot affect dedupe, so it skips the global lock
  if (addRefs.length === 0 && removeRefs.length === 0) return run();
  mkdirSync(ctx.home, { recursive: true });
  return withLock(globalLock(ctx.home), run);
}

function findTarget(
  home: string,
  idInput: string | undefined,
  refs: string[],
): { id: string; result: "updated" | "matched" } | null {
  const owners = refs.length === 0 ? [] : loadTasks(home).filter((task) => task.refs.some((ref) => refs.includes(ref)));

  if (idInput !== undefined) {
    const id = resolveId(home, idInput);
    const candidates = owners.filter((task) => task.id !== id).map((task) => task.id);
    if (candidates.length > 0) {
      throw new ShuError("ref_conflict", `refs belong to other tasks: ${candidates.join(", ")}`, {
        candidates,
      });
    }
    return { id, result: "updated" };
  }
  if (owners.length > 1) {
    const candidates = owners.map((task) => task.id);
    throw new ShuError("ref_conflict", `refs belong to several tasks: ${candidates.join(", ")}`, {
      candidates,
    });
  }
  return owners.length === 1 ? { id: owners[0].id, result: "matched" } : null;
}

function updateTask(
  ctx: Ctx,
  id: string,
  input: SaveInput,
  addRefs: string[],
  removeRefs: string[],
  { skipUnchanged = false, labels = {} as Record<string, string> } = {},
): Task {
  const { home } = ctx;
  return withLock(taskLock(home, id), () => {
    // Read the clock only once the lock is held: a save that waited must not write an older `updated`
    const updated = formatLocalIso(ctx.now());
    const task = readTask(home, id);
    const next = applyUpdate(task, input, addRefs, removeRefs, updated, labels);
    // Running a sync or a status change again must not reorder the list, so one that changes nothing writes nothing
    const sameRefs =
      next.refs.length === task.refs.length &&
      next.refs.every((ref, i) => ref === task.refs[i] && next.ref_labels[ref] === task.ref_labels[ref]);
    const unchanged = sameRefs && FIELDS.every((key) => next[key] === task[key]);
    if (skipUnchanged && unchanged) return task;
    writeFileAtomic(taskFile(home, id), serializeTask(next));
    return next;
  });
}

function createTask(ctx: Ctx, input: SaveInput, refs: string[], labels: Record<string, string>): Task {
  if (input.title === undefined || input.kind === undefined) {
    throw new ShuError("invalid_input", "title and kind are required to create a task");
  }
  const now = ctx.now();
  const stamp = formatLocalIso(now);
  const task: Task = {
    id: createTaskDir(ctx.home, now, ctx.random),
    title: input.title,
    kind: input.kind,
    status: input.status ?? "open",
    note: input.note ?? "",
    refs,
    ref_labels: labelsOf(refs, labels),
    created: stamp,
    updated: stamp,
    body: trimBlankEdges(input.body ?? ""),
    front: "",
  };
  writeFileAtomic(taskFile(ctx.home, task.id), serializeTask(task));
  return task;
}

export function setStatus(
  ctx: Ctx,
  statusInput: string,
  idInputs: string[],
  noteInput?: string,
): { tasks: TaskSummary[] } {
  const status = parseStatus(statusInput);
  const input = { status, ...(noteInput !== undefined && { note: parseNote(noteInput) }) };
  const ids = unique(idInputs.map((input) => resolveId(ctx.home, input)));
  // A broken task.md must fail before the first write
  for (const id of ids) readTask(ctx.home, id);
  return { tasks: ids.map((id) => summary(updateTask(ctx, id, input, [], [], { skipUnchanged: true }))) };
}

export function find(ctx: Ctx, refInput: string): { task: TaskDetail } {
  const ref = normalizeRef(refInput);
  const owners = loadTasks(ctx.home).filter((task) => task.refs.includes(ref));
  if (owners.length === 0) throw new ShuError("not_found", `no task has ref ${ref}`);
  if (owners.length > 1) {
    const candidates = owners.map((task) => task.id);
    throw new ShuError("ref_conflict", `ref ${ref} belongs to several tasks: ${candidates.join(", ")}`, {
      candidates,
    });
  }
  return { task: detail(owners[0]) };
}

// The task comes back with the entry so that the writer sees the note the entry may have outdated
export function log(
  ctx: Ctx,
  idInput: string,
  message: string,
  author: string = DEFAULT_AUTHOR,
  noteInput?: string,
): { id: string; entry: LogEntry; task: TaskSummary } {
  const id = resolveId(ctx.home, idInput);
  const entry = buildEntry(formatLocalIso(ctx.now()), author, message);
  const note = noteInput === undefined ? undefined : parseNote(noteInput);
  // One append-mode write per entry keeps concurrent appends from interleaving
  const append = (entry: LogEntry) => appendFileSync(logFile(ctx.home, id), formatEntry(entry));
  if (note === undefined) {
    // A task.md that cannot be read fails before anything is written
    const task = readTask(ctx.home, id);
    append(entry);
    return { id, entry, task: summary(task) };
  }
  // The lock comes first so that a lock_timeout leaves nothing written, and a retry no duplicate entry
  return withLock(taskLock(ctx.home, id), () => {
    const stamped = { ...entry, at: formatLocalIso(ctx.now()) };
    const task = readTask(ctx.home, id);
    append(stamped);
    // Written even when the note is unchanged: `updated` equal to the entry's time says the note was checked against it
    const next = applyUpdate(task, { note }, [], [], stamped.at);
    writeFileAtomic(taskFile(ctx.home, id), serializeTask(next));
    return { id, entry: stamped, task: summary(next) };
  });
}

export function artifact(
  ctx: Ctx,
  idInput: string,
  source: ArtifactSource,
  options: { name?: string; force?: boolean } = {},
): { id: string; name: string; path: string } {
  const id = resolveId(ctx.home, idInput);
  const name = options.name ?? ("path" in source ? basename(source.path) : undefined);
  if (name === undefined) {
    throw new ShuError("invalid_input", "--name is required when reading from standard input");
  }
  if (name === "" || name === "." || name === ".." || /[/\\\0]/.test(name)) {
    throw new ShuError("invalid_input", `not a valid artifact file name: ${name}`);
  }
  if ("path" in source && !isFile(source.path)) {
    throw new ShuError("invalid_input", `file not found: ${source.path}`);
  }

  const dir = artifactsDir(ctx.home, id);
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, name);
  const existing = otherSpelling(dir, name);
  if (existing !== undefined && !options.force) {
    throw new ShuError("artifact_exists", `an artifact named ${existing} already exists (use --force to overwrite)`);
  }
  // Write fully next to artifacts/ first so a half-written file is never visible there
  const tmp = join(taskDir(ctx.home, id), `.tmp-${uniqueSuffix()}`);
  try {
    if ("path" in source) copyFileSync(source.path, tmp);
    else writeFileSync(tmp, source.data);
    if (options.force) {
      // rename keeps the spelling of the entry it replaces, so give the old entry the new name first
      if (existing !== undefined) renameSync(join(dir, existing), dest);
      renameSync(tmp, dest);
    } else {
      // rename overwrites silently; link fails if the name is taken
      linkSync(tmp, dest);
    }
  } catch (e) {
    if (hasErrno(e, "EEXIST")) {
      throw new ShuError("artifact_exists", `an artifact named ${name} already exists (use --force to overwrite)`);
    }
    throw e;
  } finally {
    rmSync(tmp, { force: true });
  }
  return { id, name, path: dest };
}

// On a case-insensitive file system, the same file can already exist under another spelling
function otherSpelling(dir: string, name: string): string | undefined {
  const inode = (path: string) => statSync(path, { throwIfNoEntry: false })?.ino;
  const target = inode(join(dir, name));
  if (target === undefined) return undefined;
  return readdirSync(dir).find(
    (entry) => entry !== name && entry.toLowerCase() === name.toLowerCase() && inode(join(dir, entry)) === target,
  );
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function path(ctx: Ctx, idInput: string): { id: string; path: string } {
  const id = resolveId(ctx.home, idInput);
  return { id, path: taskDir(ctx.home, id) };
}
