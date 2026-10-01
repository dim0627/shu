import { ShuError } from "./errors";
import { trimBlankEdges } from "./text";
import { ISO_8601_PATTERN, isIso8601 } from "./time";

export interface LogEntry {
  at: string;
  author: string;
  message: string;
}

export const DEFAULT_AUTHOR = "unknown";

const HEADING = new RegExp(`^## (${ISO_8601_PATTERN})(?:[ \\t]+(.*))?$`);

function parseHeading(line: string): { at: string; author: string } | null {
  const m = HEADING.exec(line);
  if (!m || !isIso8601(m[1])) return null;
  return { at: m[1], author: m[2]?.trim() || DEFAULT_AUTHOR };
}

const formatHeading = (at: string, author: string) => `## ${at} ${author}`;

export function buildEntry(at: string, author: string, message: string): LogEntry {
  const entry = {
    at,
    author: author.trim(),
    message: trimBlankEdges(message.replace(/\r\n?/g, "\n")),
  };
  // The heading must read back exactly as written, or the entry is lost on the next read
  if (entry.author === "" || parseHeading(formatHeading(at, entry.author))?.author !== entry.author) {
    throw new ShuError("invalid_input", "author must be a non-empty single-line string");
  }
  if (entry.message === "") {
    throw new ShuError("invalid_input", "log message is empty");
  }
  // A line shaped like an entry heading would be split into a separate entry when read back
  if (entry.message.split("\n").some((line) => parseHeading(line) !== null)) {
    throw new ShuError(
      "invalid_input",
      "a message line cannot have the form of a log entry heading (## <timestamp> ...)",
    );
  }
  return entry;
}

export function formatEntry(entry: LogEntry): string {
  return `${formatHeading(entry.at, entry.author)}\n${entry.message}\n\n`;
}

export function parseLog(text: string): LogEntry[] {
  const entries: { at: string; author: string; lines: string[] }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const heading = parseHeading(line);
    if (heading) {
      entries.push({ ...heading, lines: [] });
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
