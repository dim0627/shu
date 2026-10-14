import { lookup, showBadge } from "./lookup.js";

// The last answer per tab, so the second event of one page load does not ask the host again
const answers = new Map();

async function mark(tabId, url) {
  const reply = await lookup(url);
  // The tab may have moved on while the host answered
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab?.url !== url) return;
  answers.set(tabId, { url, reply });
  await showBadge(tabId, reply).catch(() => {});
}

async function markAll() {
  for (const tab of await chrome.tabs.query({})) if (tab.url) mark(tab.id, tab.url);
}

// GitHub and Linear change the URL without a page load, which arrives as changeInfo.url
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url) return mark(tabId, tab.url);
  if (changeInfo.status !== "complete") return;
  // A full load clears the badge after the URL event, so put the answer back
  const known = answers.get(tabId);
  if (known?.url === tab.url) showBadge(tabId, known.reply).catch(() => {});
  else mark(tabId, tab.url);
});

// The store changes outside the browser; coming back to a tab is when that shows
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab?.url) mark(tabId, tab.url);
});

chrome.tabs.onRemoved.addListener((tabId) => answers.delete(tabId));
chrome.runtime.onInstalled.addListener(markAll);
chrome.runtime.onStartup.addListener(markAll);
