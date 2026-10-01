import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { hasErrno, ShuError } from "./errors";
import { generateId, ID_PATTERN, ID_WORDS_PATTERN, idWords } from "./id";
import { parseTaskFile, type Task } from "./task";

const MAX_ID_ATTEMPTS = 20;
const RELEASE_ATTEMPTS = 50;

export interface LockOptions {
  retryMs: number;
  timeoutMs: number;
  staleMs: number;
}

// timeoutMs > staleMs so a waiter outlives a crashed holder's lock and can take it over
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

const held: { path: string; token: string }[] = [];

export function withLock<T>(path: string, fn: () => T, options: LockOptions = DEFAULT_LOCK): T {
  const token = acquire(path, options);
  held.push({ path, token });
  try {
    return fn();
  } finally {
    held.pop();
    release(path, token, options.staleMs);
  }
}

function acquire(path: string, { retryMs, timeoutMs, staleMs }: LockOptions): string {
  const token = uniqueSuffix();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (createExclusive(path, token) || takeOverIfStale(path, token, staleMs)) return token;
    if (Date.now() >= deadline) {
      throw new ShuError("lock_timeout", `could not acquire lock: ${path}`);
    }
    keepHeldLocksFresh();
    Bun.sleepSync(retryMs + Math.random() * retryMs);
  }
}

function createExclusive(path: string, token: string): boolean {
  try {
    writeFileSync(path, token, { flag: "wx" });
    return true;
  } catch (e) {
    if (hasErrno(e, "EEXIST")) return false;
    throw e;
  }
}

function lockState(path: string, staleMs: number): { token: string; stale: boolean } | null {
  try {
    const stale = Date.now() - statSync(path).mtimeMs >= staleMs;
    return { token: readFileSync(path, "utf8"), stale };
  } catch (e) {
    if (hasErrno(e, "ENOENT")) return null;
    throw e;
  }
}

const guardOf = (path: string) => `${path}.steal`;

// Only the process that creates the guard may touch a lock it does not hold, and the new lock is
// renamed over the stale one, so the lock path is never empty for a third process to slip into.
function takeOverIfStale(path: string, token: string, staleMs: number): boolean {
  if (!lockState(path, staleMs)?.stale) return false;
  const guard = guardOf(path);
  if (!createExclusive(guard, token)) {
    if (lockState(guard, staleMs)?.stale) rmSync(guard, { force: true });
    return false;
  }
  // Another process may have taken the lock over between the first check and the guard
  if (!lockState(path, staleMs)?.stale) {
    rmSync(guard, { force: true });
    return false;
  }
  try {
    renameSync(guard, path);
  } catch (e) {
    if (!hasErrno(e, "ENOENT")) throw e;
  }
  return lockState(path, staleMs)?.token === token;
}

// A holder that waits for another lock would otherwise look dead and have its own lock taken over
function keepHeldLocksFresh(): void {
  const now = new Date();
  for (const { path, token } of held) {
    try {
      if (readFileSync(path, "utf8") === token) utimesSync(path, now, now);
    } catch (e) {
      if (!hasErrno(e, "ENOENT")) throw e;
    }
  }
}

// The guard keeps a takeover from swapping the lock in between the ownership check and the unlink
function release(path: string, token: string, staleMs: number): void {
  const guard = guardOf(path);
  for (let attempt = 0; attempt < RELEASE_ATTEMPTS; attempt++) {
    if (createExclusive(guard, token)) {
      try {
        if (lockState(path, staleMs)?.token === token) unlinkSync(path);
      } finally {
        rmSync(guard, { force: true });
      }
      return;
    }
    if (lockState(guard, staleMs)?.stale) rmSync(guard, { force: true });
    else Bun.sleepSync(1);
  }
}
