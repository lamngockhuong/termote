import { readFileSync } from "node:fs";
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import starlightVersions from "starlight-versions";

// Page views and three events (src/scripts/track-events.js), counted by
// GoatCounter: no cookie, nothing personal, never on localhost. Not in the
// demo (/demo/), which is the PWA's own page. The script is pinned by its
// hash: a new version of count.js is a change here.
const GOATCOUNTER = "https://termote.goatcounter.com/count";
const GOATCOUNTER_SCRIPT = "https://gc.zgo.at/count.v4.js";
const GOATCOUNTER_SRI = "sha384-nRw6qfbWyJha9LhsOtSb2YJDyZdKvvCFh0fJYlkquSFjUxp9FVNugbfy8q1jdxI+";
const trackEvents = readFileSync(new URL("./src/scripts/track-events.js", import.meta.url), "utf8");

export default defineConfig({
  site: "https://termote.ohnice.app",
  integrations: [
    starlight({
      plugins: [
        // The root docs are the current (1.x) release; 0.x is archived under /0.x/.
        starlightVersions({
          current: { label: "1.x" },
          versions: [{ slug: "0.x" }],
        }),
      ],
      components: {
        Footer: "./src/components/Footer.astro",
        // The owl drawn inline, to blink on hover
        SiteTitle: "./src/components/SiteTitle.astro",
      },
      title: "Termote",
      description: "Remote control CLI tools from mobile/desktop via PWA",
      // Prompt Owl, generated from assets/branding by `make brand-assets`.
      // The header draws it inline (src/components/SiteTitle.astro), which
      // does not read this option; kept so dropping the override brings the
      // image logo back.
      logo: {
        light: "./src/assets/brand/symbol-light.svg",
        dark: "./src/assets/brand/symbol-dark.svg",
        alt: "",
      },
      favicon: "/favicon.svg",
      head: [
        { tag: "link", attrs: { rel: "apple-touch-icon", href: "/apple-touch-icon.png" } },
        { tag: "meta", attrs: { property: "og:image", content: "https://termote.ohnice.app/og-image.png" } },
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
            { label: "Tailscale", link: "/installation/tailscale/" },
            { label: "Cloudflare Tunnel", link: "/installation/cloudflare/" },
          ],
        },
        {
          label: "Usage",
          items: [
            { label: "Agent Chat", link: "/usage/agent-chat/" },
            { label: "Agent Overview", link: "/usage/overview/", translations: { vi: "Tổng quan agent" } },
            { label: "Files and Changes", link: "/usage/files-changes/" },
            { label: "Gestures", link: "/usage/gestures/" },
            { label: "Herdr Plugin", link: "/usage/herdr-plugin/" },
            { label: "Keyboard", link: "/usage/keyboard/" },
            {
              label: "Keyboard Shortcuts",
              link: "/usage/keyboard-shortcuts/",
              translations: { vi: "Phím tắt và bảng lệnh" },
            },
            { label: "Pair a Device", link: "/usage/devices/" },
            { label: "Prompt Templates", link: "/usage/prompt-templates/", translations: { vi: "Mẫu prompt" } },
            { label: "Security Model", link: "/usage/security/", translations: { vi: "Mô hình bảo mật" } },
            { label: "Sessions", link: "/usage/sessions/" },
            { label: "Settings", link: "/usage/settings/" },
            { label: "Tasks", link: "/usage/tasks/", translations: { vi: "Task" } },
          ],
        },
      ],
    }),
  ],
});
