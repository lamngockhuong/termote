#!/usr/bin/env node
// Checks a built website (a dist directory) for install commands and
// install pointers that lead anywhere but this project's own files: every
// command that fetches something and pipes it into a shell (`curl … | sh`,
// `irm … | iex`, `iex (irm …)`) and every link to an install script, the
// agent guide or an llms.txt must name a URL under ALLOWED. The site is
// built by its dependencies' code; the deploy job, which runs none, runs
// this from the tag before it publishes. It reads only .html, .txt and .md
// files: a script a dependency injected into a page can still change what
// the page shows once it runs (docs/security-invariants.md, Website).
//
// Usage: node scripts/check-site-installs.mjs <site dir>
// Exit: 0 clean, 1 a command or a link outside ALLOWED, 2 usage or I/O error.
import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";

const ALLOWED = ["https://termote.ohnice.app/", "https://raw.githubusercontent.com/lamngockhuong/termote/"];
const TEXT = new Set([".html", ".htm", ".txt", ".md"]);
const URL_RE = /https?:\/\/[^\s"'<>`()\\[\]{}|]+/gi;
const POINTER_RE = /(\.(sh|bash|ps1)|\/agents\.md|\/llms[^/]*\.txt)$/i;
const PIPE_RE = /\|\s*(?:sudo\s+(?:-\S+\s+)*)?(?:sh|bash|zsh|dash|iex|Invoke-Expression)\b/gi;
const FETCH_RE = /\b(?:curl|wget|irm|iwr|Invoke-RestMethod|Invoke-WebRequest)\b/gi;
const EVAL_RE = /\b(?:iex|Invoke-Expression)\s*\(/gi;

const allowed = (url) => ALLOWED.some((p) => url.startsWith(p));

function decode(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

// The forms a page's text takes: its markup with entities decoded (links,
// a copy button's data-code with U+007F between lines), and its text with
// the tags taken out, a block's end as a line break (a highlighted code
// line is a run of spans).
function views(file, raw) {
  if (!/\.html?$/i.test(file)) return [raw];
  const text = raw
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "\n")
    .replace(/<\/(div|p|li|pre|tr|h[1-6]|blockquote)>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "");
  return [decode(raw).replace(/\u007f/g, "\n"), decode(text)];
}

function problems(text) {
  const out = [];
  for (const m of text.matchAll(URL_RE)) {
    const url = m[0].replace(/[.,;:!?]+$/, "");
    if (POINTER_RE.test(url.split(/[?#]/)[0]) && !allowed(url)) out.push(`install link to ${url}`);
  }
  for (const m of text.matchAll(PIPE_RE)) {
    const line = text.slice(text.lastIndexOf("\n", m.index) + 1, m.index);
    const fetches = [...line.matchAll(FETCH_RE)];
    if (fetches.length === 0) continue; // not a download piped into a shell
    const cmd = line.slice(fetches.at(-1).index);
    const urls = cmd.match(URL_RE) ?? [];
    if (urls.length === 0 ? !cmd.includes(".../") : !urls.every(allowed)) {
      out.push(`command piping a download into a shell: ${cmd.trim().slice(0, 160)}`);
    }
  }
  for (const m of text.matchAll(EVAL_RE)) {
    const arg = text.slice(m.index, text.indexOf(")", m.index) + 1 || m.index + 300);
    const urls = arg.match(URL_RE) ?? [];
    if (FETCH_RE.test(arg) && (urls.length === 0 || !urls.every(allowed))) {
      out.push(`command evaluating a download: ${arg.trim().slice(0, 160)}`);
    }
    FETCH_RE.lastIndex = 0;
  }
  return out;
}

function* files(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* files(p);
    else if (e.isFile() && TEXT.has(extname(e.name).toLowerCase())) yield p;
  }
}

const site = process.argv[2];
if (!site || process.argv.length > 3) {
  console.error("usage: check-site-installs.mjs <site dir>");
  process.exit(2);
}
let read = 0;
let bad = 0;
try {
  for (const f of files(site)) {
    read++;
    const seen = new Set();
    for (const v of views(f, readFileSync(f, "utf8"))) {
      for (const p of problems(v)) {
        if (seen.has(p)) continue;
        seen.add(p);
        console.log(`${relative(site, f)}: ${p}`);
        bad++;
      }
    }
  }
} catch (err) {
  console.error(`check-site-installs: ${err.message}`);
  process.exit(2);
}
if (read === 0) {
  console.error(`check-site-installs: no page read under ${site}`);
  process.exit(2);
}
console.error(`${bad ? `${bad} problems` : "clean"}, ${read} files read`);
process.exit(bad ? 1 : 0);
