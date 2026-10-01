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
  normalizeBody,
  parseSaveInput,
  type SaveInput,
  serializeTask,
  type Status,
  STATUSES,
  type Task,
} from "./task";
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
  const now = ctx.now();

  const run = () => {
    const target = findTarget(ctx.home, input.id, addRefs);
    const task = target
      ? updateTask(ctx.home, target.id, input, addRefs, removeRefs, now)
      : createTask(ctx, input, addRefs, now);
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
    const other = owners.find((task) => task.id !== id);
    if (other) {
      throw new ShuError("ref_conflict", `a ref belongs to another task: ${other.id}`, {
        candidates: [other.id],
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
  home: string,
  id: string,
  input: SaveInput,
  addRefs: string[],
  removeRefs: string[],
  now: Date,
): Task {
  return withLock(taskLock(home, id), () => {
    const next = applyUpdate(readTask(home, id), input, addRefs, removeRefs, formatLocalIso(now));
    writeFileAtomic(taskFile(home, id), serializeTask(next));
    return next;
  });
}

function createTask(ctx: Ctx, input: SaveInput, refs: string[], now: Date): Task {
  if (input.title === undefined || input.kind === undefined) {
    throw new ShuError("invalid_input", "title and kind are required to create a task");
  }
  const stamp = formatLocalIso(now);
  const task: Task = {
    id: createTaskDir(ctx.home, now, ctx.random),
    title: input.title,
    kind: input.kind,
    status: input.status ?? "open",
    refs,
    created: stamp,
    updated: stamp,
    body: normalizeBody(input.body ?? ""),
    extra: {},
  };
  writeFileAtomic(taskFile(ctx.home, task.id), serializeTask(task));
  return task;
}

export function find(ctx: Ctx, refInput: string): { task: TaskDetail } {
  const ref = normalizeRef(refInput);
  const task = loadTasks(ctx.home).find((candidate) => candidate.refs.includes(ref));
  if (!task) throw new ShuError("not_found", `no task has ref ${ref}`);
  return { task: detail(task) };
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

  mkdirSync(artifactsDir(ctx.home, id), { recursive: true });
  const dest = join(artifactsDir(ctx.home, id), name);
  // Write fully next to artifacts/ first so a half-written file is never visible there
  const tmp = join(taskDir(ctx.home, id), `.tmp-${uniqueSuffix()}`);
  try {
    if ("path" in source) copyFileSync(source.path, tmp);
    else writeFileSync(tmp, source.data);
    if (options.force) {
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
