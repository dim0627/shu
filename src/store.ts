import { randomUUID } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { hasErrno, ShuError } from "./errors";
import { generateId, ID_PATTERN, ID_WORDS_PATTERN, idWords } from "./id";
import { parseTaskFile, type Task } from "./task";

const MAX_ID_ATTEMPTS = 20;

export interface LockOptions {
  retryMs: number;
  timeoutMs: number;
  staleMs: number;
}

// timeoutMs > staleMs so a waiter outlives a crashed holder's lock and can steal it
export const DEFAULT_LOCK: LockOptions = { retryMs: 20, timeoutMs: 15_000, staleMs: 10_000 };

export const tasksDir = (home: string) => join(home, "tasks");
export const taskDir = (home: string, id: string) => join(tasksDir(home), id);
export const taskFile = (home: string, id: string) => join(taskDir(home, id), "task.md");
export const logFile = (home: string, id: string) => join(taskDir(home, id), "log.md");
export const artifactsDir = (home: string, id: string) => join(taskDir(home, id), "artifacts");
export const taskLock = (home: string, id: string) => join(taskDir(home, id), ".lock");
export const globalLock = (home: string) => join(home, ".lock");

export const uniqueSuffix = () => `${process.pid}-${randomUUID()}`;

// A directory without task.md is mid-creation (mkdir done, file not yet written); treat it as absent
function listTaskIds(home: string): string[] {
  let names: string[];
  try {
    names = readdirSync(tasksDir(home));
  } catch (e) {
    if (hasErrno(e, "ENOENT")) return [];
    throw e;
  }
  return names.filter((name) => ID_PATTERN.test(name) && existsSync(taskFile(home, name))).sort();
}

export function readTask(home: string, id: string): Task {
  let text: string;
  try {
    text = readFileSync(taskFile(home, id), "utf8");
  } catch (e) {
    if (hasErrno(e, "ENOENT")) throw notFound(id);
    throw e;
  }
  return parseTaskFile(text, id);
}

export function loadTasks(home: string): Task[] {
  return listTaskIds(home).map((id) => readTask(home, id));
}

export function resolveId(home: string, input: string): string {
  if (ID_PATTERN.test(input)) {
    if (!existsSync(taskFile(home, input))) throw notFound(input);
    return input;
  }
  if (!ID_WORDS_PATTERN.test(input)) {
    throw new ShuError("invalid_input", `not a task ID: ${input}`);
  }
  const candidates = listTaskIds(home).filter((id) => idWords(id) === input);
  if (candidates.length === 0) throw notFound(input);
  if (candidates.length > 1) {
    throw new ShuError("ambiguous_id", `${input} matches several tasks: ${candidates.join(", ")}`, {
      candidates,
    });
  }
  return candidates[0];
}

function notFound(id: string): ShuError {
  return new ShuError("not_found", `task not found: ${id}`);
}

export function createTaskDir(home: string, now: Date, random: () => number): string {
  mkdirSync(tasksDir(home), { recursive: true });
  for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt++) {
    const id = generateId(now, random);
    try {
      mkdirSync(taskDir(home, id));
      return id;
    } catch (e) {
      if (!hasErrno(e, "EEXIST")) throw e;
    }
  }
  throw new ShuError("id_exhausted", `could not find a free ID in ${MAX_ID_ATTEMPTS} attempts`);
}

export function writeFileAtomic(path: string, content: string): void {
  const tmp = `${path}.tmp-${uniqueSuffix()}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

export function withLock<T>(path: string, fn: () => T, options: LockOptions = DEFAULT_LOCK): T {
  const token = acquire(path, options);
  try {
    return fn();
  } finally {
    release(path, token);
  }
}

function acquire(path: string, { retryMs, timeoutMs, staleMs }: LockOptions): string {
  const token = uniqueSuffix();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      writeFileSync(path, token, { flag: "wx" });
      return token;
    } catch (e) {
      if (!hasErrno(e, "EEXIST")) throw e;
    }
    if (stealIfStale(path, staleMs)) continue;
    if (Date.now() >= deadline) {
      throw new ShuError("lock_timeout", `could not acquire lock: ${path}`);
    }
    Bun.sleepSync(retryMs + Math.random() * retryMs);
  }
}

function stealIfStale(path: string, staleMs: number): boolean {
  const isStale = (file: string) => Date.now() - statSync(file).mtimeMs >= staleMs;
  const stolen = `${path}.stale-${uniqueSuffix()}`;
  try {
    if (!isStale(path)) return false;
    renameSync(path, stolen);
  } catch (e) {
    if (hasErrno(e, "ENOENT")) return false;
    throw e;
  }
  // Between stat and rename another process may have stolen and re-taken the lock; put a live one back
  const stoleLiveLock = !isStale(stolen);
  if (stoleLiveLock) {
    try {
      linkSync(stolen, path);
    } catch (e) {
      if (!hasErrno(e, "EEXIST")) throw e;
    }
  }
  unlinkSync(stolen);
  return !stoleLiveLock;
}

// If our lock was judged stale and stolen, the file now belongs to the thief; check before removing
function release(path: string, token: string): void {
  try {
    if (readFileSync(path, "utf8") === token) unlinkSync(path);
  } catch (e) {
    if (!hasErrno(e, "ENOENT")) throw e;
  }
}
