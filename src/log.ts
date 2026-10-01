import { ShuError } from "./errors";

export interface LogEntry {
  at: string;
  author: string;
  message: string;
}

export const DEFAULT_AUTHOR = "unknown";

const HEADER =
  /^## (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))(?:[ \t]+(.*))?$/;

export function buildEntry(at: string, author: string, message: string): LogEntry {
  const entry = {
    at,
    author: author.trim(),
    message: message.replace(/^(?:[ \t]*\r?\n)+/, "").replace(/\s+$/, ""),
  };
  if (entry.author === "" || /[\r\n]/.test(entry.author)) {
    throw new ShuError("invalid_input", "author must be a non-empty single-line string");
  }
  if (entry.message === "") {
    throw new ShuError("invalid_input", "log message is empty");
  }
  // A line shaped like an entry heading would be split into a separate entry when read back
  if (entry.message.split(/\r?\n/).some((line) => HEADER.test(line))) {
    throw new ShuError(
      "invalid_input",
      "a message line cannot have the form of a log entry heading (## <timestamp> ...)",
    );
  }
  return entry;
}

export function formatEntry(entry: LogEntry): string {
  return `## ${entry.at} ${entry.author}\n${entry.message}\n\n`;
}

export function parseLog(text: string): LogEntry[] {
  const entries: { at: string; author: string; lines: string[] }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = HEADER.exec(line);
    if (m) {
      entries.push({ at: m[1], author: m[2]?.trim() || DEFAULT_AUTHOR, lines: [] });
    } else {
      entries.at(-1)?.lines.push(line);
    }
  }
  return entries.map(({ at, author, lines }) => ({
    at,
    author,
    message: lines.join("\n").replace(/\s+$/, ""),
  }));
}
