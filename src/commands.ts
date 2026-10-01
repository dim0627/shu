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
  parseSaveInput,
  type SaveInput,
  serializeTask,
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

export type TaskSummary = Pick<Task, "id" | "title" | "kind" | "status" | "refs" | "created" | "updated">;
export type TaskDetail = TaskSummary & Pick<Task, "body">;
export type SaveResult = "created" | "updated" | "matched";
export type ArtifactSource = { path: string } | { data: Uint8Array };

const DEFAULT_STATUSES: Status[] = ["open", "waiting"];

const unique = <T>(items: T[]) => [...new Set(items)];

function summary({ id, title, kind, status, refs, created, updated }: Task): TaskSummary {
  return { id, title, kind, status, refs, created, updated };
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
  const unknown = statuses.find((status) => !STATUSES.includes(status as Status));
  if (unknown !== undefined) {
    throw new ShuError("invalid_input", `status must be one of ${STATUSES.join(" / ")}: ${unknown}`);
  }
  const wanted: readonly string[] = all ? STATUSES : statuses.length > 0 ? statuses : DEFAULT_STATUSES;
  const tasks = loadTasks(ctx.home)
    .filter((task) => wanted.includes(task.status))
    .filter((task) => kinds.length === 0 || kinds.includes(task.kind))
    .sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated) || b.id.localeCompare(a.id));
  return { tasks: tasks.map(summary) };
}

export function show(ctx: Ctx, idInput: string): { task: TaskDetail; log: LogEntry[]; artifacts: string[] } {
  const id = resolveId(ctx.home, idInput);
  return {
    task: detail(readTask(ctx.home, id)),
    log: parseLog(readOptional(logFile(ctx.home, id))),
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
): { result: SaveResult; task: TaskDetail } {
  const input = parseSaveInput(inputText);
  const addRefs = unique((input.refs ?? []).map(normalizeRef));
  const removeRefs = unique(removeRefInputs.map(normalizeRef));
  const both = addRefs.find((ref) => removeRefs.includes(ref));
  if (both !== undefined) {
    throw new ShuError("invalid_input", `the same ref is in both refs and --remove-ref: ${both}`);
  }

  const run = () => {
    const target = findTarget(ctx.home, input.id, addRefs);
    if (!target && removeRefs.length > 0) {
      throw new ShuError("invalid_input", "--remove-ref needs an existing task: give its id or one of its refs");
    }
    const task = target
      ? updateTask(ctx, target.id, input, addRefs, removeRefs)
      : createTask(ctx, input, addRefs);
    const result: SaveResult = target?.result ?? "created";
    return { result, task: detail(task) };
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

function updateTask(ctx: Ctx, id: string, input: SaveInput, addRefs: string[], removeRefs: string[]): Task {
  const { home } = ctx;
  return withLock(taskLock(home, id), () => {
    // Read the clock only once the lock is held: a save that waited must not write an older `updated`
    const updated = formatLocalIso(ctx.now());
    const next = applyUpdate(readTask(home, id), input, addRefs, removeRefs, updated);
    writeFileAtomic(taskFile(home, id), serializeTask(next));
    return next;
  });
}

function createTask(ctx: Ctx, input: SaveInput, refs: string[]): Task {
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
    refs,
    created: stamp,
    updated: stamp,
    body: trimBlankEdges(input.body ?? ""),
    front: "",
  };
  writeFileAtomic(taskFile(ctx.home, task.id), serializeTask(task));
  return task;
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

export function log(
  ctx: Ctx,
  idInput: string,
  message: string,
  author: string = DEFAULT_AUTHOR,
): { id: string; entry: LogEntry } {
  const id = resolveId(ctx.home, idInput);
  const entry = buildEntry(formatLocalIso(ctx.now()), author, message);
  // One append-mode write per entry keeps concurrent appends from interleaving
  appendFileSync(logFile(ctx.home, id), formatEntry(entry));
  return { id, entry };
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
