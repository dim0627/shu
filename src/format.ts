import type { KindCount, TaskDetail, TaskSummary } from "./commands";
import type { LogEntry } from "./log";

// padEnd counts UTF-16 units, which misaligns full-width and combining characters
const widest = (texts: string[]) => Math.max(...texts.map((text) => Bun.stringWidth(text)));
const pad = (text: string, width: number) => text + " ".repeat(width - Bun.stringWidth(text));

const titled = (task: TaskSummary) => (task.note === "" ? task.title : `${task.title}  (${task.note})`);

export function formatList(tasks: TaskSummary[]): string {
  if (tasks.length === 0) return "No tasks";
  const width = (key: "id" | "status" | "kind") => widest(tasks.map((task) => task[key]));
  const [id, status, kind] = [width("id"), width("status"), width("kind")];
  return tasks
    .map((task) => [pad(task.id, id), pad(task.status, status), pad(task.kind, kind), titled(task)].join("  "))
    .join("\n");
}

export function formatKinds(kinds: KindCount[]): string {
  if (kinds.length === 0) return "No tasks";
  const width = widest(kinds.map(({ kind }) => kind));
  return kinds.map(({ kind, count }) => `${pad(kind, width)}  ${count}`).join("\n");
}

export function formatTask(task: TaskDetail): string {
  const lines = [
    `${task.id}  ${task.title}`,
    `kind: ${task.kind}  status: ${task.status}`,
    ...(task.note === "" ? [] : [`note: ${task.note}`]),
    `created: ${task.created}  updated: ${task.updated}`,
    ...task.refs.map((ref) => `ref: ${ref}`),
  ];
  if (task.body !== "") lines.push("", task.body);
  return lines.join("\n");
}

export function formatShow(task: TaskDetail, log: LogEntry[], artifacts: string[]): string {
  const sections = [formatTask(task)];
  if (log.length > 0) {
    sections.push(["# Log", ...log.map((e) => `## ${e.at} ${e.author}\n${e.message}`)].join("\n\n"));
  }
  if (artifacts.length > 0) {
    sections.push(["# Artifacts", ...artifacts.map((name) => `- ${name}`)].join("\n"));
  }
  return sections.join("\n\n");
}
