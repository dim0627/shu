import { lookup, refLink, showBadge } from "./lookup.js";
import { markdown } from "./markdown.js";

const root = document.getElementById("root");

// Task text is written by agents and people, so it only ever goes in as text, never as HTML
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children.filter((c) => c !== null));
  return node;
}

function tree(nodes) {
  return nodes.map((n) =>
    typeof n === "string"
      ? n
      : el(n.tag, n.href ? { href: n.href, target: "_blank", rel: "noreferrer" } : {}, ...tree(n.children)),
  );
}

const prose = (text) => el("div", { className: "md" }, ...tree(markdown(text)));

const seal = () => el("div", { className: "seal", textContent: "朱" });

function copyButton(text, label = "Copy") {
  const button = el("button", { textContent: label, title: text });
  button.addEventListener("click", async () => {
    await navigator.clipboard.writeText(text);
    button.textContent = "Copied";
    button.classList.add("done");
  });
  return button;
}

// "2026-10-14T16:52:08+09:00" -> "10/14 16:52", in the offset the entry was written with
const shortTime = (at) => `${at.slice(5, 7)}/${at.slice(8, 10)} ${at.slice(11, 16)}`;

function refItem(ref) {
  const { kind, label, href } = refLink(ref);
  const name = href
    ? el("a", { className: "name", href, target: "_blank", rel: "noreferrer", textContent: label, title: href })
    : el("span", { className: "name", textContent: label });
  return el("li", {}, el("span", { className: "pill", textContent: kind }), name, copyButton(href ?? ref, "Copy"));
}

function heading(text, count) {
  return el("h2", {}, text, count === null ? null : el("span", { className: "count", textContent: count }));
}

function state(message, className = "") {
  root.replaceChildren(el("div", { className: `state ${className}` }, seal(), el("p", { textContent: message })));
}

function render(reply) {
  if (reply.error) return state(reply.error.message, "error");
  if (!reply.task) return state("No SHU task refs this page.");

  const { task, log, log_total, artifacts, path } = reply;
  const artifactDir = `${path}/artifacts`;
  const status = /^[a-z]+$/.test(task.status) ? task.status : "";

  root.replaceChildren(
    el(
      "header",
      {},
      el("img", { className: "logo", src: "icons/shu.svg", alt: "SHU" }),
      el(
        "div",
        { style: "min-width: 0" },
        el("h1", { textContent: task.title }),
        el(
          "div",
          { className: "meta" },
          el("span", { className: `pill status-${status}`, textContent: task.status }),
          el("span", { className: "pill", textContent: task.kind }),
          el("span", { className: "id", textContent: task.id }),
          copyButton(task.id, "Copy ID"),
        ),
      ),
    ),
    el(
      "main",
      {},
      task.note ? el("div", { className: "note", textContent: task.note }) : null,
      heading("Refs", task.refs.length ? `${task.refs.length}` : null),
      task.refs.length === 0
        ? el("div", { className: "none", textContent: "None" })
        : el("ul", { className: "files refs" }, ...task.refs.map(refItem)),
      heading("Artifacts", artifacts.length ? `${artifacts.length}` : null),
      artifacts.length === 0
        ? el("div", { className: "none", textContent: "None yet" })
        : el(
            "ul",
            { className: "files" },
            ...artifacts.map((name) =>
              el(
                "li",
                {},
                el("span", { className: "name", textContent: name }),
                copyButton(`${artifactDir}/${name}`, "Copy path"),
              ),
            ),
          ),
      heading("Latest log", log.length < log_total ? `${log.length} of ${log_total}` : null),
      log.length === 0
        ? el("div", { className: "none", textContent: "None yet" })
        : el(
            "ol",
            { className: "timeline" },
            ...log
              .toReversed()
              .map((e) =>
                el(
                  "li",
                  {},
                  el("div", { className: "at", textContent: `${shortTime(e.at)} · ${e.author}` }),
                  prose(e.message),
                ),
              ),
          ),
      task.body
        ? el("details", { open: true, style: "margin-top: 16px" }, el("summary", { textContent: "Body" }), prose(task.body))
        : null,
    ),
  );
}

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const reply = await lookup(tab?.url);
render(reply);
// The badge may predate a save made since; this answer is the newest
if (tab?.id !== undefined) showBadge(tab.id, reply).catch(() => {});
