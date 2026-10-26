// Log entries and bodies are Markdown kept to what an entry needs: bullets, `code`, code blocks, and links.
// Anything else stays as written: entries hold text such as <!channel>, *, and snake_case that a full renderer
// would turn into HTML or emphasis. The result is a tree of strings and {tag, href, children}, which the popup
// builds with text nodes only.

const FENCE = /^ {0,3}```/;
const BULLET = /^( *)[-*] (.*)$/;
const LINK = /^\[([^[\]\n]+)\]\((https?:\/\/[^\s()<>]+)\)/i;
const URL_START = /^https?:\/\//i;
const URL_CHARS = /^[A-Za-z0-9\-._~:/?#@!$&'()*+,;=%]+/;

const node = (tag, children, href) => (href === undefined ? { tag, children } : { tag, href, children });

export function markdown(text) {
  const blocks = [];
  let paragraph = [];
  let items = null;
  let fence = null;

  const endParagraph = () => {
    if (paragraph.length) blocks.push(node("p", inline(paragraph.join("\n"))));
    paragraph = [];
  };
  const endList = () => {
    if (items) blocks.push(list(items));
    items = null;
  };

  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (fence) {
      if (FENCE.test(line)) {
        blocks.push(node("pre", [node("code", [fence.join("\n")])]));
        fence = null;
      } else fence.push(line);
      continue;
    }
    if (FENCE.test(line)) {
      endParagraph();
      endList();
      fence = [];
      continue;
    }
    if (line.trim() === "") {
      endParagraph();
      endList();
      continue;
    }
    const bullet = BULLET.exec(line);
    const indented = /^ {2}/.test(line);
    if (bullet && items && indented) {
      items.at(-1).sub.push({ lines: [bullet[2]], sub: [] });
    } else if (bullet) {
      endParagraph();
      items ??= [];
      items.push({ lines: [bullet[2]], sub: [] });
    } else if (items && indented) {
      const item = items.at(-1);
      (item.sub.at(-1) ?? item).lines.push(line.trim());
    } else {
      endList();
      paragraph.push(line);
    }
  }
  // An unclosed fence runs to the end, as in CommonMark
  if (fence) blocks.push(node("pre", [node("code", [fence.join("\n")])]));
  endParagraph();
  endList();
  return blocks;
}

function list(items) {
  return node(
    "ul",
    items.map((item) => {
      const children = inline(item.lines.join("\n"));
      if (item.sub.length) children.push(list(item.sub));
      return node("li", children);
    }),
  );
}

function inline(text, links = true) {
  const out = [];
  const push = (part) => {
    if (typeof part === "string" && typeof out.at(-1) === "string") out[out.length - 1] += part;
    else out.push(part);
  };

  for (let at = 0; at < text.length; ) {
    const rest = text.slice(at);
    if (rest[0] === "`") {
      const run = /^`+/.exec(rest)[0];
      const close = new RegExp(`(?<!\`)${run}(?!\`)`).exec(rest.slice(run.length));
      if (close) {
        push(node("code", [rest.slice(run.length, run.length + close.index)]));
        at += run.length * 2 + close.index;
      } else {
        // An unmatched run is text, so "a ``` in a sentence" stays as written
        push(run);
        at += run.length;
      }
      continue;
    }
    const link = links && rest[0] === "[" ? LINK.exec(rest) : null;
    if (link) {
      push(node("a", inline(link[1], false), link[2]));
      at += link[0].length;
      continue;
    }
    if (links && URL_START.test(rest) && !/\w/.test(text[at - 1] ?? "")) {
      const url = trimUrl(URL_CHARS.exec(rest)[0]);
      push(/^https?:\/\/./i.test(url) ? node("a", [url], url) : url);
      at += url.length;
      continue;
    }
    push(rest[0]);
    at += 1;
  }
  return out;
}

// Punctuation after a URL ends the sentence, not the URL; a ")" closes one only when the URL opened it
function trimUrl(url) {
  for (;;) {
    const last = url.at(-1);
    if (".,:;!?'*".includes(last)) url = url.slice(0, -1);
    else if (last === ")" && url.split("(").length < url.split(")").length) url = url.slice(0, -1);
    else return url;
  }
}
