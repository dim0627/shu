import { lookup } from "./lookup.js";

const root = document.getElementById("root");

// Task text is written by agents and people, so it only ever goes in as text, never as HTML
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children.filter((c) => c !== null));
  return node;
}

function copyButton(text) {
  const button = el("button", { textContent: "Copy" });
  button.addEventListener("click", async () => {
    await navigator.clipboard.writeText(text);
    button.textContent = "Copied";
  });
  return button;
}

function render(reply) {
  root.className = "";
  if (reply.error) {
    root.replaceChildren(el("div", { className: "error", textContent: reply.error.message }));
    return;
  }
  if (!reply.task) {
    root.className = "empty";
    root.textContent = "No SHU task refs this page.";
    return;
  }
  const { task, log, log_total, artifacts, path } = reply;
  const artifactDir = `${path}/artifacts`;
  root.replaceChildren(
    el("h1", { textContent: task.title }),
    el("div", { className: "meta" }, `${task.id} · ${task.status} · ${task.kind}`, copyButton(task.id)),
    task.note ? el("div", { className: "note", textContent: task.note }) : null,
    el("h2", { textContent: `Artifacts (${artifacts.length})` }),
    artifacts.length === 0
      ? el("div", { className: "empty", textContent: "None" })
      : el("ul", {}, ...artifacts.map((name) => el("li", {}, name, copyButton(`${artifactDir}/${name}`)))),
    el("h2", { textContent: log.length < log_total ? `Log (last ${log.length} of ${log_total})` : "Log" }),
    log.length === 0
      ? el("div", { className: "empty", textContent: "None" })
      : el(
          "div",
          {},
          ...log.map((e) =>
            el(
              "div",
              { className: "entry" },
              el("div", { className: "at", textContent: `${e.at} ${e.author}` }),
              el("pre", { textContent: e.message }),
            ),
          ),
        ),
    task.body ? el("h2", { textContent: "Body" }) : null,
    task.body ? el("pre", { className: "body", textContent: task.body }) : null,
  );
}

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
render(await lookup(tab?.url));
