import { ShuError } from "./errors";

const PREFIXED = /^(github|linear|slack|notion|url):(.+)$/s;
const GITHUB_SHORT = /^([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+)#(\d+)$/;
const GITHUB_PATH = /^\/([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+)\/(?:pull|issues)\/(\d+)(?:\/.*)?$/;
const LINEAR_KEY = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/;
const LINEAR_PATH = /^\/[^/]+\/issue\/([A-Za-z][A-Za-z0-9]*)-(\d+)(?:\/.*)?$/;
const SLACK_PATH = /^\/archives\/([A-Za-z0-9]+)\/p(\d+)\/?$/;
const SLACK_THREAD_TS = /^(\d+)\.(\d{6})$/;
const NOTION_HOST = /^(?:(?:[a-z0-9-]+\.)?notion\.(?:so|com)|[a-z0-9-]+\.notion\.site)$/;
const NOTION_ID = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const NOTION_SLUG_ID = /(?:^|-)([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export function normalizeRef(input: string): string {
  const raw = input.trim();
  const prefixed = PREFIXED.exec(raw);
  const normalized = detect(prefixed ? prefixed[2].trim() : raw);
  if (normalized === null) {
    throw new ShuError("invalid_ref", `cannot normalize ref: ${input}`);
  }
  if (prefixed && !normalized.startsWith(`${prefixed[1]}:`)) {
    throw new ShuError("invalid_ref", `ref kind does not match its value: ${input} (normal form is ${normalized})`);
  }
  return normalized;
}

// A url ref saved before its URL gained a kind of its own reads as that kind, so that a new kind
// does not turn the tasks already stored into invalid ones
export function readStoredRef(ref: string): string | null {
  const normalized = ref.startsWith("url:") ? detect(ref.slice("url:".length)) : null;
  if (normalized !== null && !normalized.startsWith("url:")) return normalized;
  try {
    return normalizeRef(ref) === ref ? ref : null;
  } catch {
    return null;
  }
}

function detect(raw: string): string | null {
  if (/^https?:\/\//i.test(raw)) return fromUrl(raw);
  const gh = GITHUB_SHORT.exec(raw);
  if (gh) return github(gh[1], gh[2], gh[3]);
  const lin = LINEAR_KEY.exec(raw);
  if (lin) return linear(lin[1], lin[2]);
  if (NOTION_ID.test(raw)) return notion(raw);
  return null;
}

function fromUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = url.hostname;
  if (host === "github.com" || host === "www.github.com") {
    const m = GITHUB_PATH.exec(url.pathname);
    if (m) return github(m[1], m[2], m[3]);
  }
  if (host === "linear.app") {
    const m = LINEAR_PATH.exec(url.pathname);
    if (m) return linear(m[1], m[2]);
  }
  if (host.endsWith(".slack.com")) {
    const m = SLACK_PATH.exec(url.pathname);
    if (m) return slack(host, m[1], m[2], url.searchParams.get("thread_ts"));
  }
  if (NOTION_HOST.test(host)) {
    // A page opened as a peek over a database is named by p; the path names the database
    const peeked = url.searchParams.get("p");
    const id = peeked !== null && NOTION_ID.test(peeked) ? peeked : NOTION_SLUG_ID.exec(lastSegment(url.pathname))?.[1];
    if (id !== undefined) return notion(id);
  }
  return `url:${url.href}`;
}

const lastSegment = (pathname: string) => pathname.replace(/\/+$/, "").split("/").at(-1) ?? "";

function positive(digits: string): string | null {
  const n = Number(digits);
  return Number.isSafeInteger(n) && n > 0 ? String(n) : null;
}

// GitHub treats owner/repo case-insensitively; lowercase so both spellings dedupe to one task
function github(owner: string, repo: string, digits: string): string | null {
  const number = positive(digits);
  return number && `github:${owner.toLowerCase()}/${repo.toLowerCase()}#${number}`;
}

function linear(key: string, digits: string): string | null {
  const number = positive(digits);
  return number && `linear:${key.toUpperCase()}-${number}`;
}

// The ID is all of a Notion URL that stays the same: the host, the workspace, and the title slug vary
function notion(id: string): string {
  return `notion:${id.replaceAll("-", "").toLowerCase()}`;
}

// thread_ts on a reply points at the thread parent; use it so any link into a thread finds the same task
function slack(host: string, channel: string, ts: string, threadTs: string | null): string {
  const thread = threadTs === null ? null : SLACK_THREAD_TS.exec(threadTs);
  const root = thread ? `${thread[1]}${thread[2]}` : ts;
  return `slack:https://${host}/archives/${channel}/p${root}`;
}
