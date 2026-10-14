import { lookup } from "./lookup.js";

// Vermilion, the colour SHU (朱) is named after
const FOUND = "#e2401c";
const FAILED = "#5f5a55";

async function badge(tabId, text, color, title) {
  await chrome.action.setBadgeBackgroundColor({ tabId, color });
  await chrome.action.setBadgeTextColor({ tabId, color: "#ffffff" });
  await chrome.action.setBadgeText({ tabId, text });
  await chrome.action.setTitle({ tabId, title });
}

async function mark(tabId, url) {
  const reply = await lookup(url);
  // The tab may have moved on while the host answered
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab?.url !== url) return;
  if (reply.error) await badge(tabId, "!", FAILED, `SHU: ${reply.error.message}`);
  else if (reply.task) await badge(tabId, "●", FOUND, `SHU: ${reply.task.title}`);
  else await badge(tabId, "", FOUND, "SHU: no task");
}

// GitHub and Linear change the URL without a page load, which arrives as changeInfo.url
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === "complete") mark(tabId, tab.url);
});
