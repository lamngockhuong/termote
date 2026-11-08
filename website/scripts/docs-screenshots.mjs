// The phone screenshots of the docs (src/assets/screenshots/*.webp), taken
// from the interactive demo, whose sessions and files are made up: no real
// workspace, path or host ever shows. To take them again after the app's
// look changed:
//   pnpm --filter @termote/website build
//   cd pwa && pnpm exec vite build --mode demo --outDir ../website/<build dir>/demo
//   serve the build dir, then: node website/scripts/docs-screenshots.mjs http://127.0.0.1:<port>
// Playwright comes from the PWA's dev dependencies, sharp from the website's.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const { chromium } = createRequire(new URL("../../pwa/package.json", import.meta.url))("@playwright/test");

const base = process.argv[2];
if (!base) {
  console.error("usage: node website/scripts/docs-screenshots.mjs <site URL serving /demo/>");
  process.exit(2);
}
const out = fileURLToPath(new URL("../src/assets/screenshots/", import.meta.url));
const pane = "#/s/w1/w1%3At1/w1%3Ap1";

// name, deep link, what to do before the shot
const shots = [
  ["phone-terminal", `${pane}?view=terminal`, async () => {}],
  ["phone-chat", `${pane}?view=chat`, async () => {}],
  ["phone-files", `${pane}?view=files`, async () => {}],
  ["phone-changes", `${pane}?view=changes`, async () => {}],
  ["phone-sessions", `${pane}?view=chat`, async (page) => page.getByRole("button", { name: /^(Open sessions menu|Mở danh sách phiên)$/ }).click()],
  ["phone-keyboard", `${pane}?view=terminal`, async (page) => page.getByRole("button", { name: /^(Extra keys|Phím khác)$/ }).click()],
];

const browser = await chromium.launch();
for (const lang of ["en", "vi"]) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    locale: lang === "en" ? "en-US" : "vi-VN",
  });
  const page = await context.newPage();
  await page.goto(`${base}/demo/`, { waitUntil: "networkidle" });
  // The first visit's welcome screen, in the language of the shots
  await page.locator("button", { hasText: new RegExp(`^${lang.toUpperCase()}$`) }).click();
  await page.getByRole("button", { name: /Open the terminal|Mở terminal/ }).click();
  // No Host stats chip in the header: on a phone it pushes the session's name out of view
  await page.evaluate(() => {
    const settings = JSON.parse(localStorage.getItem("termote-settings") || "{}");
    localStorage.setItem("termote-settings", JSON.stringify({ ...settings, showHostChip: false }));
  });
  await page.close();
  // A fresh page for each shot: what the last one opened stays behind
  for (const [name, hash, before] of shots) {
    const shot = await context.newPage();
    await shot.goto(`${base}/demo/${hash}`, { waitUntil: "networkidle" });
    await shot.getByRole("button", { name: /Hide the demo notice|Ẩn thông báo demo/ }).click();
    await shot.waitForTimeout(800);
    await before(shot);
    await shot.waitForTimeout(500);
    const png = await shot.screenshot();
    await shot.close();
    const file = `${out}${name}${lang === "en" ? "" : ".vi"}.webp`;
    await sharp(png).resize({ width: 585 }).webp({ quality: 80 }).toFile(file);
    console.log(file);
  }
  await context.close();
}
await browser.close();
