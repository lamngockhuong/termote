import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import starlight from "@astrojs/starlight";
import starlightLlmsTxt from "starlight-llms-txt";
import starlightVersions from "starlight-versions";
import { ARCHIVED, MOVED } from "./src/archived.mjs";

// Page views and three events (src/scripts/track-events.js), counted by
// GoatCounter: no cookie, nothing personal, never on localhost. Not in the
// demo (/demo/), which is the PWA's own page. The script is pinned by its
// hash: a new version of count.js is a change here.
const GOATCOUNTER = "https://termote.goatcounter.com/count";
const GOATCOUNTER_SCRIPT = "https://gc.zgo.at/count.v4.js";
const GOATCOUNTER_SRI = "sha384-nRw6qfbWyJha9LhsOtSb2YJDyZdKvvCFh0fJYlkquSFjUxp9FVNugbfy8q1jdxI+";
const trackEvents = readFileSync(new URL("./src/scripts/track-events.js", import.meta.url), "utf8");

const SITE = "https://termote.ohnice.app";

// The date of the last commit to a page's source, for the sitemap's lastmod:
// a build date would mark every page changed on every release. Needs the
// full history (deploy-website.yml checks out with fetch-depth 0); undefined
// for a page with no source here, such as the demo.
function lastCommitDate(pathname) {
  const slug = pathname.replace(/^\/|\/$/g, "") || "index";
  const base = fileURLToPath(new URL(`./src/content/docs/${slug}`, import.meta.url));
  const file = [".mdx", ".md", "/index.mdx", "/index.md"].map((ext) => base + ext).find(existsSync);
  if (!file) return undefined;
  const date = execFileSync("git", ["log", "-1", "--format=%cI", "--", file], { encoding: "utf8" }).trim();
  return date || undefined;
}

export default defineConfig({
  site: SITE,
  integrations: [
    // Starlight adds no sitemap of its own when one is here; the i18n block
    // keeps its hreflang alternates (en, vi)
    sitemap({
      i18n: { defaultLocale: "en", locales: { en: "en", vi: "vi" } },
      // Not the archived docs, nor the pages that only send a reader on
      filter: (page) => !ARCHIVED.test(new URL(page).pathname) && !MOVED.test(new URL(page).pathname),
      // The interactive demo: the PWA's demo build, which deploy-website.yml
      // copies into the site after this build
      customPages: [`${SITE}/demo/`],
      serialize(item) {
        const lastmod = lastCommitDate(new URL(item.url).pathname);
        return lastmod ? { ...item, lastmod } : item;
      },
    }),
    starlight({
      plugins: [
        // The root docs are the current release (1.0 or later); 0.x is archived under
        // /0.x/ and kept out of search (src/route-data.ts, the sitemap filter).
        starlightVersions({
          current: { label: "Latest" },
          versions: [{ slug: "0.x" }],
        }),
        // /llms.txt, /llms-full.txt and /llms-small.txt of the current docs;
        // a coding agent that sets Termote up reads /agents.md first.
        starlightLlmsTxt({
          description:
            "Termote serves a PWA that controls terminal sessions (tmux, Herdr, Zellij, herdr-core) of a machine from a phone or another computer.",
          details:
            "Coding agents asked to install, start or check Termote: follow [the agent guide](https://termote.ohnice.app/agents.md). Once installed, `termote help agent` prints the guide for the installed version.",
          // llms-full.txt cannot leave pages out (starlight-llms-txt 0.12.0):
          // the archived 0.x docs go last there, and out of llms-small.txt.
          exclude: ["0.x/**"],
          demote: ["0.x/**"],
        }),
      ],
      components: {
        Footer: "./src/components/Footer.astro",
        // The owl drawn inline, to blink on hover
        SiteTitle: "./src/components/SiteTitle.astro",
      },
      title: "Termote",
      // The home page's description, for pages without one of their own
      description:
        "Open-source, self-hosted PWA to control Claude Code, Codex and your tmux, Herdr or Zellij sessions from your phone or another computer.",
      // Prompt Owl, generated from assets/branding by `make brand-assets`.
      // The header draws it inline (src/components/SiteTitle.astro), which
      // does not read this option; kept so dropping the override brings the
      // image logo back.
      logo: {
        light: "./src/assets/brand/symbol-light.svg",
        dark: "./src/assets/brand/symbol-dark.svg",
        alt: "",
      },
      customCss: ["./src/styles/custom.css"],
      // noindex for the archived 0.x docs, JSON-LD on the home page
      routeMiddleware: "./src/route-data.ts",
      // The date of the page's last commit, from git (full history in CI)
      lastUpdated: true,
      // "Edit page" opens the page's source on main
      editLink: { baseUrl: "https://github.com/lamngockhuong/termote/edit/main/website/" },
      favicon: "/favicon.svg",
      head: [
        { tag: "link", attrs: { rel: "apple-touch-icon", href: "/apple-touch-icon.png" } },
        { tag: "meta", attrs: { property: "og:image", content: "https://termote.ohnice.app/og-image.png" } },
        { tag: "meta", attrs: { property: "og:image:type", content: "image/png" } },
        { tag: "meta", attrs: { property: "og:image:width", content: "1280" } },
        { tag: "meta", attrs: { property: "og:image:height", content: "640" } },
        { tag: "meta", attrs: { property: "og:image:alt", content: "Termote: Your Terminal, Anywhere." } },
        { tag: "meta", attrs: { name: "twitter:card", content: "summary_large_image" } },
        { tag: "meta", attrs: { name: "twitter:image", content: "https://termote.ohnice.app/og-image.png" } },
        {
          tag: "script",
          attrs: {
            "data-goatcounter": GOATCOUNTER,
            async: true,
            src: GOATCOUNTER_SCRIPT,
            integrity: GOATCOUNTER_SRI,
            crossorigin: "anonymous",
          },
        },
        { tag: "script", content: trackEvents },
        // Fetch an internal page when the pointer rests on its link or a
        // finger touches it, so it opens at once; not the demo, a whole app
        {
          tag: "script",
          attrs: { type: "speculationrules" },
          content: JSON.stringify({
            prefetch: [
              {
                where: { and: [{ href_matches: "/*" }, { not: { href_matches: "/demo/*" } }] },
                eagerness: "moderate",
              },
            ],
          }),
        },
      ],
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/lamngockhuong/termote",
        },
      ],
      defaultLocale: "root",
      locales: {
        root: { label: "English", lang: "en" },
        vi: { label: "Tiếng Việt", lang: "vi" },
      },
      sidebar: [
        { label: "Getting Started", link: "/getting-started/" },
        {
          label: "Installation",
          items: [
            { label: "Container", link: "/installation/docker/" },
            { label: "Native", link: "/installation/native/" },
            { label: "Install with an agent", link: "/installation/agent/", translations: { vi: "Cài bằng agent" } },
            { label: "Tailscale", link: "/installation/tailscale/" },
            { label: "Cloudflare Tunnel", link: "/installation/cloudflare/" },
          ],
        },
        {
          label: "Guides",
          translations: { vi: "Hướng dẫn" },
          items: [
            {
              label: "Claude Code from Your Phone",
              link: "/guides/claude-code-from-phone/",
              translations: { vi: "Claude Code từ điện thoại" },
            },
            {
              label: "Remote Control Alternatives",
              link: "/guides/remote-control-alternatives/",
              translations: { vi: "Lựa chọn thay Remote Control" },
            },
          ],
        },
        {
          label: "Usage",
          items: [
            { label: "Agent Chat", link: "/usage/agent-chat/" },
            { label: "Agent Overview", link: "/usage/overview/", translations: { vi: "Tổng quan agent" } },
            { label: "Files", link: "/usage/files/" },
            { label: "Editing Files", link: "/usage/file-editing/", translations: { vi: "Sửa file" } },
            { label: "File Previews", link: "/usage/file-previews/", translations: { vi: "Xem trước file" } },
            { label: "Changes", link: "/usage/changes/" },
            { label: "Gestures", link: "/usage/gestures/" },
            { label: "Herdr Plugin", link: "/usage/herdr-plugin/" },
            { label: "Keyboard", link: "/usage/keyboard/" },
            {
              label: "Keyboard Shortcuts",
              link: "/usage/keyboard-shortcuts/",
              translations: { vi: "Phím tắt và bảng lệnh" },
            },
            { label: "Machines", link: "/usage/machines/", translations: { vi: "Máy" } },
            { label: "Pair a Device", link: "/usage/devices/" },
            { label: "Prompt Templates", link: "/usage/prompt-templates/", translations: { vi: "Mẫu prompt" } },
            { label: "Security Model", link: "/usage/security/", translations: { vi: "Mô hình bảo mật" } },
            { label: "Sessions", link: "/usage/sessions/" },
            { label: "Settings", link: "/usage/settings/" },
            { label: "Tasks", link: "/usage/tasks/", translations: { vi: "Task" } },
          ],
        },
        { label: "About", link: "/about/", translations: { vi: "Giới thiệu" } },
        {
          label: "Changelog",
          link: "https://github.com/lamngockhuong/termote/releases",
          translations: { vi: "Nhật ký thay đổi" },
        },
      ],
    }),
  ],
});
