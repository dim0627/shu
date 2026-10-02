import { type Document, isMap, isScalar, parseDocument, type YAMLMap } from "yaml";
import { ShuError } from "./errors";
import { normalizeRef } from "./ref";
import { trimBlankEdges } from "./text";
import { isIso8601 } from "./time";

export const STATUSES = ["todo", "open", "waiting", "done", "dropped"] as const;
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
  // The front matter as it was read; rewriting from it keeps unknown fields, comments and formatting
  front: string;
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
const FRONT_KEYS = ["id", "title", "kind", "status", "refs", "created", "updated"] as const;
const FRONTMATTER = /^---\r?\n((?:[\s\S]*?\r?\n)?)---[ \t]*(?:\r?\n|$)([\s\S]*)$/;
// Without intAsBigInt an unknown integer field beyond 2^53 would lose digits when written back
const YAML_OPTIONS = { intAsBigInt: true };

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

export function parseTaskFile(text: string, id: string): Task {
  const invalid = (reason: string) =>
    new ShuError("invalid_task", `task.md of task ${id} is invalid: ${reason}`, { id });

  const m = FRONTMATTER.exec(text);
  if (!m) throw invalid("no front matter");
  const doc = parseDocument(m[1], YAML_OPTIONS);
  if (doc.errors.length > 0) throw invalid(`cannot parse YAML (${doc.errors[0].message})`);
  const front: unknown = doc.toJS();
  if (!isRecord(front)) throw invalid("front matter must be a mapping");

  const { id: fileId, title, kind, status, created, updated } = front;
  const refs = front.refs ?? [];
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

  return { id, title, kind, status, refs, created, updated, body: trimBlankEdges(m[2]), front: m[1] };
}

export function serializeTask(task: Task): string {
  const doc: Document = parseDocument(task.front, YAML_OPTIONS);
  const map = isMap(doc.contents) ? doc.contents : (doc.createNode({}) as YAMLMap);
  doc.contents = map;
  for (const key of FRONT_KEYS) {
    if (key === "refs" && task.refs.length === 0) map.delete(key);
    else place(doc, map, key, task[key]);
  }
  const body = task.body === "" ? "" : `\n${task.body}\n`;
  return `---\n${doc.toString({ lineWidth: 0 })}---\n${body}`;
}

// A field that is not there yet goes right after the fields that precede it in FRONT_KEYS
function place(doc: Document, map: YAMLMap, key: (typeof FRONT_KEYS)[number], value: string | string[]): void {
  const node = Array.isArray(value) ? doc.createNode(value) : value;
  if (map.has(key)) {
    map.set(key, node);
    return;
  }
  const before: readonly string[] = FRONT_KEYS.slice(0, FRONT_KEYS.indexOf(key));
  const last = map.items.findLastIndex((pair) => isScalar(pair.key) && before.includes(String(pair.key.value)));
  map.items.splice(last + 1, 0, doc.createPair(key, node));
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

export type SkippedField = "title" | "kind" | "status" | "body";

export function differingFields(task: Task, input: SaveInput): SkippedField[] {
  const given = {
    title: input.title,
    kind: input.kind,
    status: input.status,
    body: input.body === undefined ? undefined : trimBlankEdges(input.body),
  };
  return (Object.keys(given) as SkippedField[]).filter(
    (key) => given[key] !== undefined && given[key] !== task[key],
  );
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
    body: input.body === undefined ? task.body : trimBlankEdges(input.body),
    refs: [...new Set([...task.refs, ...addRefs])].filter((ref) => !removeRefs.includes(ref)),
    updated,
  };
}
