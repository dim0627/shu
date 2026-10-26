// Log entries and bodies are Markdown kept to what an entry needs: bullets, `code`, code blocks, links, **bold**,
// and headings, shown as a bold line. Anything else stays as written: entries hold text such as <!channel>, *, and
// snake_case that a full renderer would turn into HTML or emphasis. The result is a tree of strings and {tag, href, children}, which the popup
// builds with text nodes only.

// As in CommonMark, an info string holds no backtick, so ```npm ci``` at the start of a line is inline code
const FENCE = /^ {0,3}(`{3,})[^`]*$/;
const HEADING = /^ {0,3}#{1,6} +(.+?)(?: +#+)? *$/;
const BULLET = /^( *)[-*] (.*)$/;
const LINK = /^\[([^[\]\n]+)\]\((https?:\/\/(?:[^\s()<>]|\([^\s()<>]*\))+)\)/i;
// A "**" next to a "/" is a glob such as test/**/*.test.js, not bold
const STRONG = /^\*\*([^\s*/](?:[^\n]*?[^\s*/])?)\*\*(?![\w*])/;
const URL_START = /^https?:\/\//i;
const URL_CHARS = /^[A-Za-z0-9\-._~:/?#@!$&'()*+,;=%]+/;

const node = (tag, children, href) => (href === undefined ? { tag, children } : { tag, href, children });

export function markdown(text) {
  const blocks = [];
  let paragraph = [];
  let items = null;
  let base = 0;
  let gap = false;
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
      // As in CommonMark, only a bare run at least as long as the opener closes it, so ```ts inside stays code
      const close = /^ {0,3}(`{3,})\s*$/.exec(line);
      if (close && close[1].length >= fence.length) {
        blocks.push(node("pre", [node("code", [fence.lines.join("\n")])]));
        fence = null;
      } else fence.lines.push(line);
      continue;
    }
    const open = FENCE.exec(line);
    if (open) {
      endParagraph();
      endList();
      fence = { length: open[1].length, lines: [] };
      continue;
    }
    if (line.trim() === "") {
      // A blank line ends a paragraph but not a list: the next bullet or indented line carries it on
      endParagraph();
      gap = items !== null;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      endParagraph();
      endList();
      blocks.push(node("p", [node("strong", inline(heading[1]))]));
      continue;
    }
    // Only leading tabs are expanded, so a tab inside the text is kept
    const spaced = line.replace(/^[ \t]+/, (ws) => ws.replaceAll("\t", "    "));
    const indent = /^ */.exec(spaced)[0].length;
    const bullet = BULLET.exec(spaced);
    // Nesting is relative to the list's first bullet, so a list indented as a whole stays flat
    if (bullet && items && indent >= base + 2) {
      items.at(-1).sub.push({ offset: indent + 2, lines: [bullet[2]] });
    } else if (bullet) {
      endParagraph();
      if (!items) base = indent;
      items ??= [];
      items.push({ offset: indent + 2, lines: [bullet[2]], sub: [] });
    } else if (items && indent >= base + 2) {
      const item = items.at(-1);
      const sub = item.sub.at(-1);
      const target = sub && indent >= sub.offset ? sub : item;
      if (gap) target.lines.push("");
      target.lines.push(spaced.slice(target.offset));
    } else {
      endList();
      paragraph.push(line);
    }
    gap = false;
  }
  // An unclosed fence runs to the end, as in CommonMark
  if (fence) blocks.push(node("pre", [node("code", [fence.lines.join("\n")])]));
  endParagraph();
  endList();
  return blocks;
}

function list(items) {
  return node(
    "ul",
    items.map((item) => {
      const children = inline(item.lines.join("\n"));
      if (item.sub?.length) children.push(list(item.sub));
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
    const strong = rest.startsWith("**") && !/[\w*/]/.test(text[at - 1] ?? "") ? STRONG.exec(rest) : null;
    if (strong) {
      push(node("strong", inline(strong[1], links)));
      at += strong[0].length;
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
