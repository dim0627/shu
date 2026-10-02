import type { KindCount, TaskDetail, TaskSummary } from "./commands";
import type { LogEntry } from "./log";

export function formatList(tasks: TaskSummary[]): string {
  if (tasks.length === 0) return "No tasks";
  const width = (key: "id" | "status" | "kind") => Math.max(...tasks.map((task) => task[key].length));
  const [id, status, kind] = [width("id"), width("status"), width("kind")];
  return tasks
    .map((task) =>
      [task.id.padEnd(id), task.status.padEnd(status), task.kind.padEnd(kind), task.title].join("  "),
    )
    .join("\n");
}

export function formatKinds(kinds: KindCount[]): string {
  if (kinds.length === 0) return "No tasks";
  const width = Math.max(...kinds.map(({ kind }) => kind.length));
  return kinds.map(({ kind, count }) => `${kind.padEnd(width)}  ${count}`).join("\n");
}

export function formatTask(task: TaskDetail): string {
  const lines = [
    `${task.id}  ${task.title}`,
    `kind: ${task.kind}  status: ${task.status}`,
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
