import { parse, stringify } from "yaml";
import { ShuError } from "./errors";
import { normalizeRef } from "./ref";
import { isIso8601 } from "./time";

export const STATUSES = ["open", "waiting", "done", "dropped"] as const;
export type Status = (typeof STATUSES)[number];

export interface Task {
  id: string;
  title: string;
  kind: string;
  status: Status;
  refs: string[];
  created: string;
  updated: string;
  body: string;
  extra: Record<string, unknown>;
}

export interface SaveInput {
  id?: string;
  title?: string;
  kind?: string;
  status?: Status;
  refs?: string[];
  body?: string;
}

const INPUT_KEYS = ["id", "title", "kind", "status", "refs", "body"];
const FRONTMATTER = /^---\r?\n((?:[\s\S]*?\r?\n)?)---[ \t]*(?:\r?\n|$)([\s\S]*)$/;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isLine = (v: unknown): v is string =>
  typeof v === "string" && v.trim() !== "" && !/[\r\n]/.test(v);
const isStatus = (v: unknown): v is Status => STATUSES.includes(v as Status);
const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((item) => typeof item === "string");
const isTimestamp = (v: unknown): v is string => typeof v === "string" && isIso8601(v);

function isNormalizedRef(ref: string): boolean {
  try {
    return normalizeRef(ref) === ref;
  } catch {
    return false;
  }
}

export function normalizeBody(body: string): string {
  return body.replace(/^(?:[ \t]*\r?\n)+/, "").replace(/\s+$/, "");
}

export function parseTaskFile(text: string, id: string): Task {
  const invalid = (reason: string) =>
    new ShuError("invalid_task", `task.md of task ${id} is invalid: ${reason}`, { id });

  const m = FRONTMATTER.exec(text);
  if (!m) throw invalid("no front matter");
  let front: unknown;
  try {
    front = parse(m[1]);
  } catch (e) {
    throw invalid(`cannot parse YAML (${(e as Error).message})`);
  }
  if (!isRecord(front)) throw invalid("front matter must be a mapping");

  const { id: fileId, title, kind, status, refs: rawRefs, created, updated, ...extra } = front;
  const refs = rawRefs ?? [];
  if (fileId !== id) throw invalid("id does not match the directory name");
  if (!isLine(title)) throw invalid("title must be a non-empty single-line string");
  if (!isLine(kind)) throw invalid("kind must be a non-empty single-line string");
  if (!isStatus(status)) throw invalid(`status must be one of ${STATUSES.join(" / ")}`);
  if (!isStringArray(refs)) throw invalid("refs must be an array of strings");
  if (new Set(refs).size !== refs.length) throw invalid("refs contains duplicates");
  const denormalized = refs.find((ref) => !isNormalizedRef(ref));
  if (denormalized !== undefined) throw invalid(`refs contains a non-normalized ref (${denormalized})`);
  if (!isTimestamp(created)) throw invalid("created must be an ISO 8601 timestamp");
  if (!isTimestamp(updated)) throw invalid("updated must be an ISO 8601 timestamp");

  return { id, title, kind, status, refs, created, updated, body: normalizeBody(m[2]), extra };
}

export function serializeTask(task: Task): string {
  const front = {
    id: task.id,
    title: task.title,
    kind: task.kind,
    status: task.status,
    ...(task.refs.length > 0 ? { refs: task.refs } : {}),
    created: task.created,
    updated: task.updated,
    ...task.extra,
  };
  const body = task.body === "" ? "" : `\n${task.body}\n`;
  return `---\n${stringify(front, { lineWidth: 0 })}---\n${body}`;
}

export function parseSaveInput(text: string): SaveInput {
  const invalid = (reason: string) => new ShuError("invalid_input", `invalid save input: ${reason}`);

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw invalid("standard input is not JSON");
  }
  if (!isRecord(data)) throw invalid("expected a JSON object");
  const unknown = Object.keys(data).filter((key) => !INPUT_KEYS.includes(key));
  if (unknown.length > 0) {
    throw invalid(`unknown field ${unknown.join(", ")} (allowed: ${INPUT_KEYS.join(", ")})`);
  }

  const { id, title, kind, status, refs, body } = data;
  if (id !== undefined && !isLine(id)) throw invalid("id must be a string");
  if (title !== undefined && !isLine(title)) throw invalid("title must be a non-empty single-line string");
  if (kind !== undefined && !isLine(kind)) throw invalid("kind must be a non-empty single-line string");
  if (status !== undefined && !isStatus(status)) {
    throw invalid(`status must be one of ${STATUSES.join(" / ")}`);
  }
  if (refs !== undefined && !isStringArray(refs)) throw invalid("refs must be an array of strings");
  if (body !== undefined && typeof body !== "string") throw invalid("body must be a string");

  return {
    ...(id !== undefined && { id }),
    ...(title !== undefined && { title: title.trim() }),
    ...(kind !== undefined && { kind: kind.trim() }),
    ...(status !== undefined && { status }),
    ...(refs !== undefined && { refs }),
    ...(body !== undefined && { body }),
  };
}

export function applyUpdate(
  task: Task,
  input: SaveInput,
  addRefs: string[],
  removeRefs: string[],
  updated: string,
): Task {
  return {
    ...task,
    title: input.title ?? task.title,
    kind: input.kind ?? task.kind,
    status: input.status ?? task.status,
    body: input.body === undefined ? task.body : normalizeBody(input.body),
    refs: [...new Set([...task.refs, ...addRefs])].filter((ref) => !removeRefs.includes(ref)),
    updated,
  };
}
