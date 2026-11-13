#!/usr/bin/env node
// Checks a built website (a dist directory) against the sources of the tag
// it was built from, so that the code and the install pointers it serves are
// this project's own. The site is built by its dependencies' code; the
// deploy job, which runs none, runs this from the tag before it publishes.
//
// Pages are read the way a browser reads them (a tokenizer after the HTML
// specification: tags, attributes, comments, raw text, character
// references), and what the check does not model is refused rather than
// guessed at (an element whose raw text a page can end elsewhere, a frame or
// an object, a DOCTYPE or a charset it does not read, a reference it does
// not decode...; docs/security-invariants.md, Website, lists them). Then,
// each an allow list:
//
// - Every line of code a file shows (a <pre> or <code>, a copy button's
//   data-code, a markdown fence or inline code span) must be a whole line of
//   the tag's sources (website/src, website/public, the agent guide,
//   llms.txt, astro.config.mjs), or a whole code span or code line of them;
//   whitespace is collapsed, nothing else is changed.
// - Every link to an install script, the agent guide or an llms file, in an
//   attribute or a markdown link (relative and protocol-relative ones
//   resolved against the page's own address or its first <base>) or written
//   out, must be exactly one of INSTALL or a script of a release on GitHub
//   (RAW); a meta refresh may only stay on the site.
//
// Prose is not held to the tag: a sentence outside code that pipes a
// download into a shell (a fetch word and |, iex, $( or <()), or runs it as a
// file after it (&& sh /tmp/i, ; chmod +x), is refused only when it names no
// address, or one other than INSTALL, RAW or this computer's, a host without
// a scheme, a backslash, a proxy, a curl option that redirects the download,
// or what hides an address (a variable, base64, a concatenated string, a host
// as one number); a package run (npx, uvx...) is refused outright. A file that is not UTF-8 text (a UTF-16 byte
// order mark, a NUL byte) or of a type it does not read is refused. Scripts
// and style sheets do not count as shown: a script or a CSS rule a
// dependency injected can still change what a page shows.
//
// Usage: node scripts/check-site-installs.mjs <site dir> <source dir>
//   <source dir> holds the tag's sources at their repository paths.
// Exit: 0 clean, 1 a line or a link outside the allow lists, 2 usage or I/O error.
import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";

const SITE = "https://termote.ohnice.app/";
const INSTALL = new Set(
  ["install.sh", "install.ps1", "agents.md", "llms.txt", "llms-full.txt", "llms-small.txt"].map((f) => SITE + f),
);
const RAW =
  /^https:\/\/raw\.githubusercontent\.com\/lamngockhuong\/termote\/(?:release\/0\.x|v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\/scripts\/(?:install|get)\.(?:sh|ps1)$/;
const LOCAL_RE = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\//;
// Read as markup, or as text (markdown); scripts, style sheets and binary
// files are not read; any other type is refused, not guessed at (.xsl,
// .rss: a browser may render them).
const MARKUP = new Set([".html", ".htm", ".xhtml", ".xht", ".shtml", ".svg", ".xml", ".mathml"]);
// A file with no extension (CNAME, a LICENSE) is served as a download, but a
// page can point an agent at one: read as text.
const TEXT = new Set(["", ".md", ".txt", ".vtt", ".json", ".webmanifest"]);
// Parsed as XML by a browser: no raw text, a tag may close itself.
const XML = new Set([".xhtml", ".xht", ".svg", ".xml", ".mathml"]);
const SKIPPED = new Set([
  ...[".js", ".mjs", ".cjs", ".css", ".map", ".wasm", ".zip", ".gz", ".br", ".zst"],
  ...[".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico", ".bmp", ".tif", ".tiff"],
  ...[".mp4", ".webm", ".mp3", ".ogg", ".wav", ".woff", ".woff2", ".ttf", ".otf", ".eot"],
  ...[".pf_fragment", ".pf_index", ".pf_meta", ".pf_filter", ".pagefind"],
  ...[".bcmap", ".pfb", ".icc"], // the PDF viewer's character maps, fonts, colour profiles
]);
// The files deploy copies from the tag over the build's and compares byte
// for byte (CI compares them with the checkout): not read here, an
// installer is not a page.
const FROM_TAG = new Set(["install.sh", "install.ps1", "agents.md", "llms.txt", "llms-full.txt", "llms-small.txt"]);
// The paths the deploy job's sparse checkout of the tag holds
// (.github/workflows/deploy-website.yml): keep the two lists alike.
const SOURCES = ["website/src", "website/public", "website/llms.txt", "website/astro.config.mjs", "server/agent-guide.md"];
const SOURCE_TEXT = new Set([".md", ".mdx", ".astro", ".ts", ".tsx", ".js", ".mjs", ".json", ".txt", ".vtt", ".yml", ".yaml"]);
const POINTER_RE = /(\.(sh|bash|zsh|ps1|psm1|cmd|bat|py)|\/agents\.md|\/llms[^/]*\.txt)$/i;
const LINK_ATTRS = new Set([
  "href",
  "src",
  "action",
  "formaction",
  "data",
  "poster",
  "xlink:href",
  "cite",
  "ping",
  "background",
  "manifest",
]);
const URL_RE = /(?:https?:)?\/\/(?:\[[0-9a-f:.]+\]|[a-z0-9%])[^\s"'<>`()[\]{}|]*/gi;
const FETCH_RE =
  /\b(?:curl|wget2?|fetch|aria2c|lwp-download|scp|irm|iwr|Invoke-RestMethod|Invoke-WebRequest|DownloadString|DownloadFile|DownloadData|WebClient|Start-BitsTransfer|bitsadmin|certutil|urlopen|urllib|requests\.get|httpx|git\s+clone|Get-Content)\b/gi;
// A command that downloads a package and runs it, or installs one by name
// (its install scripts run, and so does the program the next line starts),
// with no URL to hold to the allow list: refused in prose wherever it is not
// a line of the sources. An install names a package after its options.
const RUNNER_RE =
  /\b(?:(?:npx|pnpx|bunx|uvx|uv\s+tool\s+run|bun\s+x|(?:pnpm|yarn)\s+dlx|npm\s+(?:exec|x)|(?:npm|pnpm|yarn|bun)\s+(?:create|init)|pipx\s+run|deno\s+run|(?:docker|podman)\s+run)\s+\S|go\s+(?:run|install)\s+\S+@\S|(?:(?:npm|pnpm|yarn|bun)(?:\s+-\S+|\s+global)*\s+(?:install|i|add)|pip[\d.]*\s+install|pipx\s+install|uv\s+(?:tool|pip)\s+install|brew\s+install|cargo\s+install|gem\s+install|(?:winget|scoop|choco)\s+install|Install-(?:Module|Script|Package|PSResource))(?:\s+-\S+)*\s+[\w@~./:\\"']|mshta\s+\S*(?:https?:|\\\\)|msiexec\s+\/\w+\s+\S*(?:https?:|\\\\))/gi;
// what goes on with a package name, or names another after a space
const NAME_GOES_ON = /^(?:[\w@~./:\\"'-]|\s+[\w@~./:\\"'])/;

// inSourceCode: the run or install m of the line n lies whole inside one of
// code, this file's code lines of the sources, where it appears in n and
// ends where no name goes on (`brew install tmux`, not `… tmux-x` nor
// `… tmux x`, which installs x as well).
function inSourceCode(n, m, code) {
  for (const c of code) {
    for (let at = n.indexOf(c); at >= 0; at = n.indexOf(c, at + 1)) {
      const end = at + c.length;
      if (at <= m.index && m.index + m[0].length <= end && !NAME_GOES_ON.test(n.slice(end))) return true;
    }
  }
  return false;
}

// A pipe into a shell or an interpreter (after sudo, env or a variable set
// for it), a download evaluated, or a file run after it (`&& sh /tmp/i`,
// `; chmod +x i`, `&& ./i`, `; . ~/i`, `exec(`); a table's | is not one.
const SINK_RE =
  /\|&?\s*(?:(?:sudo|doas|env|command|exec|nohup|\S*\/env)\b[^|\n]{0,80}?\s|\w+=\S*\s+){0,6}\S*?(?:sh|bash|zsh|dash|ksh|fish|pwsh|powershell|python[\d.]*|perl|ruby|node|iex|Invoke-Expression)\b|\biex\b|Invoke-Expression|\$\(|<\(|`\s*(?:curl|wget2?|irm|iwr|Invoke-WebRequest|Invoke-RestMethod)\b[^`]*\/\/|(?:&&|\|\||;)\s*(?:(?:sudo|doas)\s+)?(?:(?:sh|bash|zsh|dash|ksh|fish|pwsh|powershell|python[\d.]*|perl|ruby|node|source)\s+[^\s|&;]|\.\s+[~./]|\.{0,2}\/[^\s/]|chmod\b)|\b(?:exec|eval)\s*\(|&\s*(?:\(\s*)?\$|Start-Process\b/i;
// What leads a download elsewhere beside an allowed URL: a host with no
// scheme, a backslash, a curl option that redirects or configures it.
const ELSEWHERE_RE = new RegExp(
  [
    "\\\\", // a backslash
    "(?:^|[\\s=(@\"'`;,|&<>])(?!\\.\\.\\.\\/)[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.(?:[a-z]{2,}|xn--[a-z0-9-]+)(?:[:/]|\\s|$)", // a host
    "\\d{1,3}(?:\\.\\d{1,3}){3}|\\[[0-9a-f:.]+\\]", // an IP address, a letter before it or not (-x192.0.2.1)
    "\\s(?:--resolve|--connect-to|--proxy\\S*|--socks\\S*|--preproxy|--dns-\\S*|--doh-url|--config)\\b|\\s-[a-zA-Z]*[xK]", // curl options, in a cluster too
    "\\b(?:https?|all|ftp|no)_proxy=", // a proxy set for the command
    // what hides an address or a command from the check: a variable (but
    // the installer's own $env:TERMOTE_…, taken out before, but the one
    // that skips its signature check) or a
    // substitution other than a download's, base64, a string built by
    // concatenation, a format, a join or a replace, a host as one number
    "\\$[{A-Za-z_]|\\$\\((?!\\s*(?:curl|wget2?|irm|iwr)\\b)",
    "['\")]\\s*-(?:f|join|replace)\\b|\\s-join\\b|\\.replace\\(|\\[char\\]",
    "\\bbase64\\b|FromBase64|-EncodedCommand\\b|\\s-enc\\b",
    "['\"]\\s*\\+\\s*['\"]",
    "(?:^|[\\s\"'=(@])(?:0x[0-9a-f]+|\\d{5,})(?=[/:\\s\"')]|$)",
    // the installer told to skip its signature check (a downgrade to a
    // release the project no longer signs for)
    "TERMOTE_SKIP_SIGNATURE_CHECK",
  ].join("|"),
  "i",
);

const NAMED = { quot: '"', apos: "'", lt: "<", gt: ">", nbsp: "\u00a0", amp: "&", QUOT: '"', LT: "<", GT: ">", AMP: "&" };
const C1 = "€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ"; // &#128;-&#159;
// Character references as a browser decodes them, in one pass. A name it
// does not decode is reported: it stands for a character the check cannot
// see (`&verbar;` is a pipe).
function decode(s, out, inAttr) {
  return s.replace(/&(?:#[xX]([0-9a-fA-F]+);?|#(\d+);?|([A-Za-z][A-Za-z0-9]*)(;?))/g, (m, hex, dec, name, semi, at) => {
    if (name) {
      // In an attribute, a name with no ; before = or a letter or digit is
      // left as written (?a=1&b=2), as a browser leaves it.
      if (!semi && inAttr && /[=A-Za-z0-9]/.test(s[at + m.length] ?? "")) return m;
      if (NAMED[name] && (semi || name !== "apos")) return NAMED[name];
      // with its ; or without (a browser decodes &shy and its like without)
      out?.push(`a character reference the check does not decode: &${name}${semi}`);
      return m;
    }
    const n = hex ? Number.parseInt(hex, 16) : Number(dec);
    if (n >= 0x80 && n <= 0x9f) return C1[n - 0x80];
    if (n === 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return "\ufffd";
    // a carriage return from a reference shows as a space, not a line break:
    // kept apart from the file's own line ends (refused in code)
    if (n === 13) return "\u2028";
    return String.fromCodePoint(n);
  });
}

const lines = (s) => s.split(/\r\n?|\n/);
const collapse = (s) => s.replace(/\s+/g, " ").trim();

// The code a markdown text shows: fenced blocks (CommonMark: a closing fence
// carries no info string), after any indent or quote marks (a list item's,
// a quote's), and inline code spans, which may run over line breaks.
// `strict` takes a fence only at the top level, 0-3 spaces in.
// `lenient` (the sources) also gives a fenced block as one line, as
// llms-small.txt writes it. An indented block is not taken for code (a list
// item's paragraph is indented too): its lines are prose to the check.
// The width of a line's leading whitespace in columns, a tab to the next
// multiple of four.
function columns(ws) {
  let col = 0;
  for (const c of ws) col = c === "\t" ? col + 4 - (col % 4) : col + 1;
  return col;
}

// What is left of line inside a container of `quotes` quote marks and an
// item indented `indent` columns, or null when the line does not carry them
// (it ends the container). A line of only quote marks and blanks is blank.
function insideContainer(line, quotes, indent) {
  let i = 0;
  for (let q = 0; q < quotes; q++) {
    const m = /^ {0,3}>[ ]?/.exec(line.slice(i));
    if (!m) return line.trim() === "" ? "" : null;
    i += m[0].length;
  }
  const rest = line.slice(i);
  if (rest.trim() === "") return "";
  const ws = /^[ \t]*/.exec(rest)[0];
  if (columns(ws) < indent) return null;
  // drop `indent` columns of the whitespace
  let col = 0;
  let j = 0;
  while (j < ws.length && col < indent) col = ws[j++] === "\t" ? col + 4 - (col % 4) : col + 1;
  return " ".repeat(col - indent) + rest.slice(j);
}

function markdownCode(raw, lenient, strict) {
  const code = [];
  const prose = [];
  let fence = null;
  let quotes = 0;
  let indent = 0;
  let marked = false;
  let reread = false;
  let block = [];
  const all = lines(raw);
  for (let k = 0; k < all.length; k++) {
    const line = all[k];
    if (fence) {
      // A fence in a list item or a quote: its lines carry the quote marks
      // and the item's indent; a line that does not ends the container, and
      // the fence with it, and is read again outside it.
      let body = line;
      let reopen = false;
      if (!lenient && !strict && (quotes || indent)) {
        body = insideContainer(line, quotes, indent);
        if (body === null && (quotes || marked)) {
          fence = null;
          k--;
          continue;
        }
        if (body === null) {
          // An indent with no marker on the fence's line: a list item's
          // (a line less indented ends it) or the fence's own (it does not).
          // Read both ways: the line stays code, and a fence on it both
          // closes this one and opens the next.
          body = line.replace(/^[ \t]*/, "");
          reopen = true;
        }
      }
      const close = body.match(lenient ? /^[ \t>]*(`{3,}|~{3,})[ \t]*$/ : /^ {0,3}(`{3,}|~{3,})[ \t]*$/);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) {
        if (lenient) code.push(collapse(block.join(" ")));
        fence = null;
        if (reopen) {
          k--;
          reread = true;
        }
      } else {
        code.push(body);
        block.push(body);
      }
      continue;
    }
    // the lead: quote marks, then list markers and their indent; a line read
    // again after it closed a fence opens one only as a top-level fence
    const again = reread;
    reread = false;
    const open = again
      ? line.match(/^([ \t]*)(`{3,}(?!.*`)|~{3,})/)
      : strict
      ? line.match(/^( {0,3})(`{3,}(?!.*`)|~{3,})/)
      : (line.match(/^((?:[ \t>]|[-*+][ \t]|\d{1,9}[.)][ \t])*)(`{3,}(?!.*`)|~{3,})/) ??
        (lenient ? line.match(/^(\s*)(`{3,}|~{3,})/) : null));
    if (open) {
      const marks = /^(?:[ \t]*>)*/.exec(open[1])[0];
      quotes = (marks.match(/>/g) ?? []).length;
      // after the marks' own space, the item's markers and indent, in columns
      const item = quotes ? open[1].slice(marks.length).replace(/^ /, "") : open[1];
      indent = again ? 0 : columns(item.replace(/[^\t]/g, " "));
      marked = /[-*+\d]/.test(item);
      fence = open[2];
      block = [];
      prose.push("");
    } else prose.push(line);
  }
  // A code span never crosses a paragraph (a blank line or a fence ends it).
  const paragraphs = prose.join("\n").split(/\n[ \t>]*\n/);
  const rest = [];
  const whole = [];
  for (const para of paragraphs) {
    let kept = "";
    let at = 0;
    // A paragraph that may start an HTML block (its backticks are then
    // text) is read both ways: its spans are code, and it is read whole as
    // HTML as well.
    if (!lenient && /^(?:[ \t]*>)*[ ]{0,3}<(?:[A-Za-z][\w-]*|\/[A-Za-z]|!--|\?|![A-Za-z])/.test(para.replace(/^\n+/, ""))) {
      whole.push(para);
    }
    for (const span of codeSpans(para)) {
      // Three backticks or more is a block an llms-small.txt wrote on one
      // line: its first word is the language, not code, when it is one a
      // fence of the sources names.
      const word = /^([\w+-]*)\s/.exec(span.body)?.[1];
      const body = span.ticks >= 3 && LANGUAGES.has(word) ? span.body.slice(word.length + 1) : span.body;
      code.push(collapse(body.replace(/\\\|/g, "|")));
      kept += para.slice(at, span.start);
      at = span.end;
    }
    rest.push(kept + para.slice(at));
  }
  // The prose is what is left, its code taken out.
  return { code, prose: [...rest, ...whole].join("\n\n") };
}

// Inline code spans as CommonMark finds them: a run of backticks not
// escaped by a backslash opens one, closed by the next run of the same
// length; a run with no match is text.
function codeSpans(text) {
  const spans = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === "\\") {
      i += 2;
      continue;
    }
    if (text[i] !== "`") {
      i++;
      continue;
    }
    let n = 0;
    while (text[i + n] === "`") n++;
    let j = i + n;
    let close = -1;
    while (j < text.length) {
      const k = text.indexOf("`", j);
      if (k < 0) break;
      let m = 0;
      while (text[k + m] === "`") m++;
      if (m === n) {
        close = k;
        break;
      }
      j = k + m;
    }
    if (close < 0) {
      i += n;
      continue;
    }
    spans.push({ ticks: n, body: text.slice(i + n, close), start: i, end: close + n });
    i = close + n;
  }
  return spans;
}

// Markdown link targets: [text](target), <scheme://...>, [ref]: target.
// A destination is <...> up to its > (spaces allowed) or a run with balanced
// parentheses, as CommonMark reads it.
const DEST = String.raw`<([^>\n]*)>|((?:[^\s()]|\((?:[^\s()]|\([^\s()]*\))*\))+)`;
const markdownLinks = (raw) =>
  [
  ...[...raw.matchAll(new RegExp(String.raw`\]\(\s*(?:${DEST})`, "g"))].map((m) => m[1] ?? m[2]),
  ...[...raw.matchAll(/<((?:https?:)?\/\/[^>\s]+)>/g)].map((m) => m[1]),
  ...[...raw.matchAll(new RegExp(String.raw`^(?:[ \t]*>)*[ \t]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)*\[[^\]]+\]:\s*(?:${DEST})`, "gm"))].map(
    (m) => m[1] ?? m[2],
  ),
  ].map((d) => decode(d.replace(/\\([!-/:-@[-`{-~])/g, "$1"))); // escapes undone, references decoded

// The languages the sources' fences name (```bash), filled by sourceSet.
const LANGUAGES = new Set();

// The tag's sources: every line, every code line and code span (a span
// wrapped over two lines as one), and what a <kbd> holds (an llms file
// writes it as code), collapsed.
function sourceSet(root) {
  const set = new Set();
  const add = (s) => {
    const c = collapse(s);
    if (c) set.add(c);
  };
  for (const s of SOURCES) {
    const p = join(root, s);
    const files = extname(s) ? [p] : walk(p, (f) => SOURCE_TEXT.has(extname(f).toLowerCase()));
    for (const f of files) {
      const raw = readFileSync(f, "utf8");
      for (const l of lines(raw)) add(l);
      if (/\.mdx?$/i.test(f)) {
        for (const m of raw.matchAll(/^\s*(?:`{3,}|~{3,})([\w+-]+)/gm)) LANGUAGES.add(m[1]);
        for (const c of markdownCode(raw, true).code) for (const l of [c, ...lines(c)]) add(l);
        for (const k of raw.matchAll(/<kbd>([^<]*)<\/kbd>/gi)) add(k[1]);
      }
    }
  }
  return set;
}

// HTML's whitespace: not \s, which also takes U+00A0, U+3000 and the like.
const WS = /[\t\n\f\r ]/;
const BLOCK_END = new Set(["div", "p", "li", "pre", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "dt", "dd"]);
// Only these are skipped as raw text (their bodies still read for links and
// downloads); a <template> holds markup, as a browser parses it.
const RAW_TEXT = new Set(["script", "style"]);
// Inside code, only these: elements that show their text as it is (an
// <img alt>, an <input value>, a <ruby> or a <bdo> would show other text).
const IN_CODE = new Set(
  ["span", "div", "code", "pre", "br", "wbr", "b", "i", "em", "strong", "mark", "kbd", "samp", "var", "a"].concat(
    ["sub", "sup", "small", "s", "u", "del", "ins"],
  ),
);
// Refused, not modelled: raw text whose end a page can move (iframe,
// noscript, noembed, noframes, a browser's choice of which to show), or that
// runs to the end of the page (plaintext, xmp, listing).
const REFUSED = new Set([
  ...["plaintext", "xmp", "listing", "iframe", "noscript", "noembed", "noframes"],
  ...["object", "embed", "frame", "frameset", "portal", "fencedframe"],
]);
// Inside <svg> or <math>, where HTML resumes at these and a <style> or
// <script> there may be raw text or not: refused, not modelled. An svg
// <title> or <desc> is read as markup, which only reads more than is shown.
// HTML elements that end <svg> or <math> where they start (the browser
// goes back to HTML): refused there rather than followed.
const BREAKOUT = new Set(
  ["b", "big", "blockquote", "body", "br", "center", "code", "dd", "div", "dl", "dt", "em", "embed", "font"].concat(
    ["h1", "h2", "h3", "h4", "h5", "h6", "head", "hr", "i", "img", "li", "listing", "menu", "meta", "nobr", "ol"],
    ["p", "pre", "ruby", "s", "small", "span", "strong", "strike", "sub", "sup", "table", "tt", "u", "ul", "var"],
  ),
);
const FOREIGN_REFUSED = new Set([
  "style",
  "script",
  "textarea",
  "foreignobject",
  "annotation-xml",
  "mi",
  "mo",
  "mn",
  "ms",
  "mtext",
]);

// The tag at html[i] (a "<" and a letter, or "</" and a letter): its name,
// its attributes (separated by whitespace or /, a name up to whitespace, /,
// > or =, a value quoted or running to whitespace or >), whether it closes
// itself, and where it ends. An end tag's attributes are read the same way,
// so a quoted > does not end it.
function tagAt(html, i, out, xml) {
  const tag = /^<(\/?)([A-Za-z][^\t\n\f\r />]*)/.exec(html.slice(i, i + 256));
  if (!tag) return null;
  const attrs = [];
  let selfClosing = false;
  i += tag[0].length;
  for (;;) {
    selfClosing = false;
    while (i < html.length && /[\t\n\f\r /]/.test(html[i])) selfClosing = html[i++] === "/";
    if (i >= html.length || html[i] === ">") break;
    const an = /^[^\t\n\f\r />][^\t\n\f\r />=]*/.exec(html.slice(i, i + 256));
    i += an[0].length;
    let j = i;
    while (j < html.length && WS.test(html[j])) j++;
    let value = "";
    if (html[j] === "=") {
      j++;
      while (j < html.length && WS.test(html[j])) j++;
      const q = html[j];
      if (q === '"' || q === "'") {
        const close = html.indexOf(q, j + 1);
        value = html.slice(j + 1, close < 0 ? html.length : close);
        j = close < 0 ? html.length : close + 1;
      } else {
        let k = j;
        while (k < html.length && !/[\t\n\f\r >]/.test(html[k])) k++;
        value = html.slice(j, k);
        j = k;
      }
      i = j;
    }
    attrs.push([an[0].toLowerCase(), decode(value, out, true)]);
  }
  // In an XML file a prefix names a namespace (h:base is an XHTML base): the
  // local name is the element. In HTML, x:code is an element of its own.
  const name = xml ? tag[2].toLowerCase().replace(/^[^:]*:/, "") : tag[2].toLowerCase();
  return { end: tag[1] === "/", name, attrs, selfClosing, next: Math.min(html.length, i + 1) };
}

// A meta refresh's address, as the specification parses its content: a
// delay, ; or , then an optional url=, then the address, one leading quote
// stripped and the address cut at its match, if any.
function refreshTarget(content) {
  const m = /^\s*[\d.]*\s*[;,]?\s*(?:url\s*=\s*)?([\s\S]*)$/i.exec(content);
  let to = m ? m[1] : "";
  if (to[0] === '"' || to[0] === "'") {
    const close = to.indexOf(to[0], 1);
    to = to.slice(1, close < 0 ? undefined : close);
  }
  return to.trim();
}

// What a page shows, read as the HTML specification tokenizes it: its text
// (whitespace collapsed outside <pre>, a block's end a line break, a table
// cell's " | "), its code (inside <pre> or <code>, data-code), its attribute
// values, and its links and refreshes resolved against the page's own
// address (docURL) or its first <base>. Inside <svg> or <math> nothing is
// taken for raw text, as there (a <style> there is markup, and a <pre> in
// it shows).
function readMarkup(html, out, docURL, xml, keepLines) {
  const view = { text: "", code: [], attrs: [], links: [], refreshes: [], base: docURL };
  const open = {};
  let pre = 0;
  let code = 0;
  const foreignStack = [];
  let foreignText = 0;
  let codeBuf = "";
  let based = false;
  const emit = (s, raw) => {
    if (!raw && (pre > 0 || code > 0) && /[\v\f\u007f\u0085\u2028\u2029]/.test(s)) {
      out.push("code holding a line break the check does not split at");
    }
    const t =
      raw || pre > 0
        ? s
        : keepLines // a text file's lines stay lines (a caption per line)
          ? s.replace(/[\t\f ]+/g, " ").replace(/\u007f/g, "")
          : s.replace(/[\t\n\f\r ]+/g, " ").replace(/\u007f/g, "");
    view.text += t;
    if (pre > 0 || code > 0) codeBuf += t;
  };
  const endCode = () => {
    if (pre === 0 && code === 0) {
      view.code.push(codeBuf);
      codeBuf = "";
    }
  };
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      emit(decode(html.slice(i), out));
      break;
    }
    emit(decode(html.slice(i, lt), out));
    i = lt;
    const rest = html.slice(i, i + 9);
    if (rest.startsWith("<!--")) {
      // <!--> and <!---> end at once; otherwise --> or --!>
      const abrupt = /^<!---?>/.exec(rest);
      const m = /--!?>/.exec(html.slice(i + 4));
      i = abrupt ? i + abrupt[0].length : m ? i + 4 + m.index + m[0].length : html.length;
      continue;
    }
    if (/^<!\[CDATA\[/i.test(rest)) {
      out.push("a CDATA section (not read the way every reader reads it)");
      i = html.indexOf(">", i) + 1 || html.length;
      continue;
    }
    if (/^<\?xml-stylesheet/i.test(html.slice(i, i + 20))) {
      out.push("an xml-stylesheet instruction (a transform builds what is shown)");
    }
    // XML ends an instruction at ?> and a DOCTYPE after its literals and its
    // internal subset: only the plain forms are read, the rest refused.
    const decl = /^<\?xml[\t\n\r ][^<>]*\?>/.exec(html.slice(i, i + 200));
    if (decl && /encoding\s*=\s*["'](?!utf-?8["'])/i.test(decl[0])) out.push("an XML encoding other than UTF-8");
    if (xml && rest.startsWith("<?") && !decl) {
      out.push("a processing instruction (not read the way every reader reads it)");
    }
    if (/^<!doctype/i.test(rest) && !/^<!doctype[\t\n\f\r ]+html[\t\n\f\r ]*>/i.test(html.slice(i, i + 40))) {
      out.push("a DOCTYPE other than <!DOCTYPE html>");
    }
    if (/^<[!?]/.test(rest) || /^<\/[^A-Za-z>]/.test(rest)) {
      i = html.indexOf(">", i) + 1 || html.length; // a bogus comment or a DOCTYPE
      continue;
    }
    if (rest.startsWith("</>")) {
      i += 3;
      continue;
    }
    const t = tagAt(html, i, out, xml);
    if (!t) {
      emit("<"); // a < that starts no tag is text
      i++;
      continue;
    }
    const { end, name, attrs } = t;
    i = t.next;
    if (end) {
      if (name === "pre" && pre > 0) {
        pre--;
        endCode();
      } else if (name === "code" && code > 0) {
        code--;
        endCode();
      } else if ((name === "title" || name === "desc") && foreignText > 0) {
        foreignText--;
      } else if (name === "svg" || name === "math") {
        // a browser ignores an end tag that does not close the innermost one
        if (foreignStack.at(-1) === name) foreignStack.pop();
        else out.push(`a </${name}> that closes no <${name}>`);
      }
      // a block's end breaks the line only when that block is open: a
      // browser ignores a stray </div>
      if (open[name] > 0) {
        open[name]--;
        if (name === "td" || name === "th") emit(" | ", true);
        else if (BLOCK_END.has(name)) emit("\n", true);
      }
      continue;
    }
    const attr = (n) => attrs.find(([an]) => an === n)?.[1];
    if (name === "base" && attr("href") !== undefined && !based) {
      // the first <base> with an href counts, resolved against the page
      based = true;
      view.base = resolve(attr("href"), docURL);
      if (!view.base.startsWith(SITE)) out.push(`base off the site: ${attr("href")}`);
    }
    for (const [an, av] of attrs) {
      view.attrs.push(av);
      if (an === "data-code") view.code.push(av.replace(/\u007f/g, "\n")); // the copy button's line separator
      if (LINK_ATTRS.has(an)) view.links.push(av.trim());
      if (an === "srcset") for (const part of av.split(",")) view.links.push(part.trim().split(/\s+/)[0]);
    }
    const charset =
      attr("charset") ??
      (attr("http-equiv")?.trim().toLowerCase() === "content-type" ? /charset=([^;\s]+)/i.exec(attr("content") ?? "")?.[1] : undefined);
    if (name === "meta" && charset !== undefined && !/^utf-?8$/i.test(charset.trim())) {
      out.push(`a charset other than UTF-8: ${charset}`);
    }
    if (name === "meta" && attr("http-equiv")?.trim().toLowerCase() === "refresh") {
      const to = refreshTarget(attr("content") ?? "");
      if (to) view.refreshes.push(to);
    }
    if (REFUSED.has(name)) out.push(`a <${name}> element (not read the way every reader reads it)`);
    if (foreignStack.length > 0 && !xml && (FOREIGN_REFUSED.has(name) || BREAKOUT.has(name))) {
      out.push(`a <${name}> inside <svg> or <math>`);
    }
    // an svg <title> or <desc> holds HTML in a browser: text only, here
    if (foreignText > 0 && !xml) out.push(`a <${name}> inside an svg <title> or <desc>`);
    if (foreignStack.length > 0 && !xml && (name === "title" || name === "desc") && !t.selfClosing) foreignText++;
    if (xml && name === "foreignobject") out.push("a <foreignObject> (HTML inside an XML file)");
    if (attr("xml:base") !== undefined) out.push("an xml:base attribute");
    if (name === "br" || BLOCK_END.has(name)) emit("\n", true); // a block breaks the line where it starts too
    if (BLOCK_END.has(name) || name === "td" || name === "th") open[name] = (open[name] ?? 0) + 1;
    if ((name === "svg" || name === "math") && !t.selfClosing) foreignStack.push(name);
    // What changes the text a line of code shows without a script or a style
    // sheet: refused inside code.
    // a style in code may set custom properties (--0:#fff, as Expressive
    // Code does) and nothing that hides or moves text
    const styleHides = (attr("style") ?? "").split(";").some((d) => d.trim() && !/^--[\w-]+\s*:/.test(d.trim()));
    if ((pre > 0 || code > 0) && (attr("hidden") !== undefined || styleHides || !IN_CODE.has(name))) {
      out.push(`a <${name}> that changes what a line of code shows`);
    }
    if (name === "pre") pre++;
    if (name === "code") code++;
    if (!xml && foreignStack.length === 0 && (RAW_TEXT.has(name) || name === "textarea" || name === "title")) {
      const close = new RegExp(`</${name}(?=[\\t\\n\\f\\r />])`, "i").exec(html.slice(i));
      const body = html.slice(i, close ? i + close.index : html.length);
      // a script's escaped states (<!-- ... <script>) move its end: refused
      if (name === "script" && body.includes("<!--")) out.push("a script holding <!-- (its end is not read here)");
      if (name === "textarea" || name === "title") emit(decode(body, out), name === "textarea");
      // A script's or a style's body shows nothing, but a command or an
      // install link written in it is read like an attribute's text.
      else view.attrs.push(body);
      i = close ? tagAt(html, i + close.index, out, xml).next : html.length;
    }
  }
  if (pre > 0 || code > 0) view.code.push(codeBuf);
  // Links and refreshes resolve against the page's base once it is read: a
  // <base> applies to the links before it too.
  view.links = view.links.map((l) => resolve(l, view.base));
  view.refreshes = view.refreshes.map((to) => resolve(to, view.base));
  return view;
}

// A link resolved against base, or kept as written when no browser would
// follow it (it does not parse).
function resolve(link, base) {
  try {
    return new URL(link, base).href;
  } catch {
    return link;
  }
}

const installLink = (url) => INSTALL.has(url) || RAW.test(url);

// A link to an install script, the agent guide or an llms file, by its
// pathname decoded (`install%2Esh` is served as install.sh).
function pointer(url) {
  let path = url.pathname;
  try {
    path = decodeURIComponent(path);
  } catch {}
  return POINTER_RE.test(path);
}

// rel is the file's path in the site: the page's own address resolves its
// relative links (docs/x/index.html is served as docs/x/).
function problems(rel, raw, sources) {
  const out = [];
  const docURL = new URL(`./${rel.split(sep).join("/").replace(/(^|\/)index\.html?$/i, "$1")}`, SITE).href;
  raw = raw.replace(/^\ufeff/, ""); // a UTF-8 byte order mark, as a reader drops it
  const ext = extname(rel).toLowerCase();
  let view;
  if (MARKUP.has(ext)) {
    view = readMarkup(raw, out, docURL, XML.has(ext));
  } else if (!TEXT.has(ext)) {
    return [`a file type the check does not read (${ext})`];
  } else if (ext === "") {
    // served as a download: plain text to whoever reads it, no markdown
    view = { text: raw, code: [], attrs: [], links: [], refreshes: [], base: docURL };
  } else {
    // Markdown. A fence after an indent or quote marks is a fence to one
    // reader and not to another: both readings' code is held to the sources.
    // What is left of each reading, its code taken out, is read as HTML too
    // (a <pre> written in a markdown file shows as one), refusals included.
    const loose = markdownCode(raw, false, false);
    const strict = markdownCode(raw, false, true);
    const found = [];
    // An HTML block that starts with <pre>, <script>, <style> or <textarea>
    // runs to its end tag, blank lines and backticks included: read whole.
    const blocks = [...raw.matchAll(/^(?:[ \t]*>)*[ ]{0,3}<(pre|script|style|textarea)\b[\s\S]*?(?:<\/\1\s*>|$(?![\s\S]))/gim)].map((m) => m[0]);
    const inHtml = [loose.prose, strict.prose, ...blocks].map((t) => readMarkup(t, found, docURL, false, true));
    // markdown decodes a reference only with its ; (Q&A is text)
    out.push(...found.filter((p) => !/does not decode: &[A-Za-z][A-Za-z0-9]*$/.test(p)));
    view = {
      text: raw,
      code: [...loose.code, ...strict.code, ...inHtml.flatMap((v) => v.code)],
      // its HTML's text (references decoded) and attributes are read as prose too
      attrs: inHtml.flatMap((v) => [v.text, ...v.attrs]),
      links: [...markdownLinks(raw), ...inHtml.flatMap((v) => v.links)],
      refreshes: [],
      base: docURL,
    };
  }
  // this file's code lines that are the sources' own
  const sourceCode = new Set();
  for (const c of view.code) {
    if (/[\v\f\u0085\u2028\u2029\u007f]/.test(c)) out.push("code holding a line break the check does not split at");
    for (const line of lines(c)) {
      const n = collapse(line);
      if (n && !sources.has(n)) out.push(`code not in the tag's sources: ${n.slice(0, 160)}`);
      else if (n) sourceCode.add(n);
    }
  }
  for (const to of view.refreshes) {
    let href;
    try {
      href = new URL(to, view.base).href;
    } catch {
      href = to;
    }
    if (!href.startsWith(SITE)) out.push(`refresh to ${to}`);
    else if (pointer(new URL(href)) && !installLink(href)) out.push(`refresh to an install link ${to}`);
  }
  for (const link of view.links) {
    let url;
    try {
      url = new URL(link, view.base);
    } catch {
      continue; // not a URL a browser follows
    }
    url.hash = ""; // a fragment names a place in the same file
    if (pointer(url) && !installLink(url.href)) out.push(`install link to ${link}`);
  }
  for (const t of [view.text, ...view.attrs]) {
    for (const m of t.matchAll(URL_RE)) {
      const written = m[0].replace(/[.,;:!?]+$/, "");
      let url;
      try {
        url = new URL(written.startsWith("//") ? `https:${written}` : written);
      } catch {
        continue;
      }
      if (pointer(url) && !installLink(written)) out.push(`install link to ${written}`);
    }
    // A line ending in ( \ | && || goes on on the next one, and so does one
    // before a line starting with | (iex ( / irm …, curl … | / sh).
    const joined = t.replace(/([(\\|]|&&)[ \t]*(?:\r\n?|\n)/g, "$1 ").replace(/(?:\r\n?|\n)(?=[ \t]*\|)/g, " ");
    for (const line of lines(joined)) {
      for (const m of line.matchAll(FETCH_RE)) {
        // The whole line, or in a long one (an llms-small.txt page is one
        // line) from before the fetch word to the first sink after it.
        let window = line;
        if (line.length > 500) {
          // from an unclosed $( <( or iex ( before the fetch word, if any
          const before = line.slice(0, m.index);
          const opens = [...before.matchAll(/\$\(|<\(|\biex\s*\(/gi)].map((o) => o.index);
          const open = opens.findLast((o) => !before.slice(o).includes(")"));
          const from = open !== undefined ? Math.min(open, Math.max(0, m.index - 300)) : Math.max(0, m.index - 300);
          const sink = SINK_RE.exec(line.slice(m.index));
          window = line.slice(from, Math.max(m.index + 300, sink ? m.index + sink.index + sink[0].length : 0));
        }
        if (!SINK_RE.test(window)) continue;
        const urls = [...window.matchAll(URL_RE)].map((u) => u[0].replace(/[.,;:!?]+$/, ""));
        let rest = window.replace(/\$env:TERMOTE_(?!SKIP_SIGNATURE_CHECK\b)\w+/gi, " ");
        for (const u of urls) rest = rest.replace(u, " ");
        const named =
          urls.length > 0 && urls.every((u) => installLink(u) || LOCAL_RE.test(u)) && !ELSEWHERE_RE.test(rest);
        if (!named && !sources.has(collapse(line))) {
          out.push(`download into a shell: ${collapse(window).slice(0, 160)}`);
        }
      }
    }
    // a line as written (a copy button's lines apart), before any joining;
    // a run or an install inside a code span of the sources (`brew install
    // tmux` in a sentence) is that code's, held to the tag above
    for (const line of lines(t.replace(/\u007f/g, "\n"))) {
      const n = collapse(line);
      if (sources.has(n)) continue;
      for (const m of n.matchAll(RUNNER_RE)) {
        if (!inSourceCode(n, m, sourceCode)) {
          out.push(`a package run or install from prose: ${m[0].slice(0, 160)}`);
        }
      }
    }
  }
  return out;
}

// Every file under dir that keep accepts; anything neither a file nor a
// folder (a link) is an error, not a file left unread.
function* walk(dir, keep) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p, keep);
    else if (!e.isFile()) throw new Error(`${p}: neither a file nor a folder`);
    else if (keep(p)) yield p;
  }
}

const [site, root] = process.argv.slice(2);
if (!site || !root || process.argv.length > 4) {
  console.error("usage: check-site-installs.mjs <site dir> <source dir>");
  process.exit(2);
}
// A message holds text the build wrote: no control character reaches the
// log, where a line starting :: is a workflow command.
const safe = (s) => s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, "?");
let sources;
let files;
try {
  sources = sourceSet(root);
  files = [
    ...walk(site, (f) => !SKIPPED.has(extname(f).toLowerCase()) && !FROM_TAG.has(relative(site, f))),
  ];
} catch (err) {
  console.error(`check-site-installs: ${safe(err.message)}`);
  process.exit(2);
}
let bad = 0;
for (const f of files) {
  const name = safe(relative(site, f));
  try {
    const buf = readFileSync(f);
    const found = new Set();
    if ((buf[0] === 0xfe && buf[1] === 0xff) || (buf[0] === 0xff && buf[1] === 0xfe) || buf.includes(0)) {
      found.add("not UTF-8 text (a UTF-16 byte order mark or a NUL byte)");
    } else {
      for (const p of problems(relative(site, f), buf.toString("utf8"), sources)) found.add(p);
    }
    for (const p of found) console.log(`check-site-installs: ${name}: ${safe(p)}`);
    bad += found.size;
  } catch (err) {
    console.error(`check-site-installs: ${name}: ${safe(err.message)}`);
    process.exit(2);
  }
}
if (files.length === 0) {
  console.error(`check-site-installs: no page read under ${safe(site)}`);
  process.exit(2);
}
console.error(`${bad ? `${bad} problems` : "clean"}, ${files.length} files read`);
process.exit(bad ? 1 : 0);
