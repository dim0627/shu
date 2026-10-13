import { ShuError } from "./errors";

const PREFIXED = /^(github|linear|slack|notion|url):(.+)$/s;
const GITHUB_SHORT = /^([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+)#(\d+)$/;
const GITHUB_PATH = /^\/([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+)\/(?:pull|issues)\/(\d+)(?:\/.*)?$/;
const LINEAR_KEY = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/;
const LINEAR_PATH = /^\/[^/]+\/issue\/([A-Za-z][A-Za-z0-9]*)-(\d+)(?:\/.*)?$/;
const SLACK_PATH = /^\/archives\/([A-Za-z0-9]+)\/p(\d+)\/?$/;
const SLACK_THREAD_TS = /^(\d+)\.(\d{6})$/;
// Other subdomains (the API, the calendar) carry IDs that are not pages
const NOTION_HOST = /^(?:(?:(?:www|app)\.)?notion\.(?:so|com)|[a-z0-9-]+\.notion\.site)$/;
const NOTION_ID_FORMS = "[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const NOTION_ID = new RegExp(`^(?:${NOTION_ID_FORMS})$`, "i");
const NOTION_SLUG_ID = new RegExp(`(?:^|-)(${NOTION_ID_FORMS})$`, "i");

export function normalizeRef(input: string): string {
  const raw = input.trim();
  const prefixed = PREFIXED.exec(raw);
  const value = prefixed ? prefixed[2].trim() : raw;
  // A bare ID has no shape of its own (any UUID or 32-digit hash would pass), so it needs the kind
  const normalized = prefixed?.[1] === "notion" && NOTION_ID.test(value) ? notion(value) : detect(value);
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
  if (ref.startsWith("url:")) {
    const value = ref.slice("url:".length);
    const normalized = /^https?:\/\//.test(value) ? fromUrl(value) : null;
    if (normalized === null) return null;
    if (normalized.startsWith("url:")) return normalized === ref ? ref : null;
    // Only a URL in the form it was stored in is excused, not any spelling of it
    return new URL(value).href === value ? normalized : null;
  }
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
    const inPath = NOTION_SLUG_ID.exec(lastSegment(url.pathname))?.[1];
    // A page opened as a peek over a database is named by p; the path names the database
    const peeked = url.searchParams.get("p");
    if (inPath !== undefined) return notion(peeked !== null && NOTION_ID.test(peeked) ? peeked : inPath);
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
