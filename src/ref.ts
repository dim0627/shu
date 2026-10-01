import { ShuError } from "./errors";

const PREFIXED = /^(github|linear|slack|url):(.+)$/s;
const GITHUB_SHORT = /^([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+)#(\d+)$/;
const GITHUB_PATH = /^\/([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+)\/(?:pull|issues)\/(\d+)(?:\/.*)?$/;
const LINEAR_KEY = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/;
const LINEAR_PATH = /^\/[^/]+\/issue\/([A-Za-z][A-Za-z0-9]*)-(\d+)(?:\/.*)?$/;
const SLACK_PATH = /^\/archives\/([A-Za-z0-9]+)\/p(\d+)\/?$/;
const SLACK_THREAD_TS = /^(\d+)\.(\d{6})$/;

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
  return `url:${url.href}`;
}

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

// thread_ts on a reply points at the thread parent; use it so any link into a thread finds the same task
function slack(host: string, channel: string, ts: string, threadTs: string | null): string {
  const thread = threadTs === null ? null : SLACK_THREAD_TS.exec(threadTs);
  const root = thread ? `${thread[1]}${thread[2]}` : ts;
  return `slack:https://${host}/archives/${channel}/p${root}`;
}
