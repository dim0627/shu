// Must match the name browser/install.sh registers
export const HOST = "io.github.dim0627.shu";

// Vermilion, the colour SHU (朱) is named after; --shu in popup.html is the same
const FOUND = "#e2401c";
const FAILED = "#5f5a55";

export function lookup(url) {
  // Spares starting the host for chrome:// and file:// tabs; host.py checks the same
  if (!/^https?:\/\//.test(url ?? "")) return Promise.resolve({ task: null });
  return chrome.runtime.sendNativeMessage(HOST, { url }).catch((e) => ({
    error: {
      code: "host",
      message: `${e.message}. If the host is not registered for this browser, run browser/install.sh`,
    },
  }));
}

export async function showBadge(tabId, reply) {
  const [text, color, title] = reply.error
    ? ["!", FAILED, `SHU: ${reply.error.message}`]
    : reply.task
      ? ["●", FOUND, `SHU: ${reply.task.title}`]
      : ["", FOUND, "SHU: no task"];
  await chrome.action.setBadgeBackgroundColor({ tabId, color });
  await chrome.action.setBadgeTextColor({ tabId, color: "#ffffff" });
  await chrome.action.setBadgeText({ tabId, text });
  await chrome.action.setTitle({ tabId, title });
}

// Only a GitHub page has a number that log entries and artifact names also use (#482).
// The ref check keeps a page of another repository from claiming the task's #482
export function pageNumber(url, refs) {
  const m = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/(?:pull|issues)\/(\d+)(?:[/?#]|$)/i.exec(url ?? "");
  if (!m) return null;
  const number = String(Number(m[3]));
  const ref = `github:${m[1]}/${m[2]}#${number}`.toLowerCase();
  return refs.includes(ref) ? number : null;
}

export const mentions = (text, number) => new RegExp(`#${number}(?!\\d)`).test(text);

// A stored ref is normalized, so the page it came from has to be rebuilt
export function refLink(ref) {
  const at = ref.indexOf(":");
  const kind = ref.slice(0, at);
  const value = ref.slice(at + 1);
  switch (kind) {
    case "github": {
      const [repo, number] = value.split("#");
      // The ref does not say pull request or issue; GitHub sends /issues/<n> of a pull request on to it
      return { kind, label: value, href: `https://github.com/${repo}/issues/${number}` };
    }
    case "linear":
      return { kind, label: value, href: `https://linear.app/issue/${value}` };
    case "notion":
      return { kind, label: value, href: `https://www.notion.so/${value}` };
    case "slack":
    case "url":
      return { kind, label: value.replace(/^https?:\/\//, ""), href: /^https?:\/\//.test(value) ? value : null };
    default:
      return { kind, label: value, href: null };
  }
}
