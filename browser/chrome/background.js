import { lookup } from "./lookup.js";

async function mark(tabId, url) {
  const reply = await lookup(url);
  // The tab may have moved on while the host answered
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab?.url !== url) return;
  if (reply.error) {
    await chrome.action.setBadgeText({ tabId, text: "!" });
    await chrome.action.setTitle({ tabId, title: `SHU: ${reply.error.message}` });
  } else if (reply.task) {
    await chrome.action.setBadgeText({ tabId, text: "●" });
    await chrome.action.setTitle({ tabId, title: `SHU: ${reply.task.title}` });
  } else {
    await chrome.action.setBadgeText({ tabId, text: "" });
    await chrome.action.setTitle({ tabId, title: "SHU: no task" });
  }
}

// GitHub and Linear change the URL without a page load, which arrives as changeInfo.url
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === "complete") mark(tabId, tab.url);
});
