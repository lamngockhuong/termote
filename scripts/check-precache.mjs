// Fails when the service worker of a PWA build installs a document viewer upfront: pdf.js,
// SheetJS, mammoth or anything under assets/doc/ (character maps, fonts, the viewers) must be
// fetched the first time a document is opened, never precached by every device.
//
// Usage: node scripts/check-precache.mjs <path to sw.js>
import { readFileSync } from "node:fs";

const FORBIDDEN = [/assets\/doc\//, /pdf/i, /xlsx/i, /docx/i, /mammoth/i, /document-preview/];

// The URLs of workbox's precache manifest: precacheAndRoute([{url:"…",revision:…},…])
export function precacheUrls(sw) {
  const start = sw.indexOf("precacheAndRoute(");
  if (start < 0) throw new Error("no precacheAndRoute in the service worker");
  const end = sw.indexOf("]", start);
  if (end < 0) throw new Error("precache manifest not closed");
  return [...sw.slice(start, end).matchAll(/url:\s*"([^"]+)"/g)].map((m) => m[1]);
}

// Vite's content hash before the extension (name-DoCX48Fu.js): random letters that can spell
// "docx" or "pdf", so a name is matched without it.
const HASH = /-[\w-]{8}(\.\w+)$/;

export function forbiddenUrls(urls) {
  return urls.filter((u) => FORBIDDEN.some((re) => re.test(u.replace(HASH, "$1"))));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: node scripts/check-precache.mjs <sw.js>");
    process.exit(2);
  }
  const urls = precacheUrls(readFileSync(file, "utf8"));
  const bad = forbiddenUrls(urls);
  if (urls.length === 0 || bad.length > 0) {
    console.error(urls.length === 0 ? "precache manifest is empty" : `precached upfront:\n  ${bad.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`precache: ${urls.length} entries, no document viewer`);
}
