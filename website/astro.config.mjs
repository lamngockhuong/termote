import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import starlightVersions from "starlight-versions";

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
      },
      title: "Termote",
      description: "Remote control CLI tools from mobile/desktop via PWA",
      // Prompt Owl, generated from assets/branding by `make brand-assets`
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
          ],
        },
        {
          label: "Usage",
          items: [
            { label: "Agent Chat", link: "/usage/agent-chat/" },
            { label: "Files and Changes", link: "/usage/files-changes/" },
            { label: "Gestures", link: "/usage/gestures/" },
            { label: "Herdr Plugin", link: "/usage/herdr-plugin/" },
            { label: "Keyboard", link: "/usage/keyboard/" },
            { label: "Pair a Device", link: "/usage/devices/" },
            { label: "Security Model", link: "/usage/security/", translations: { vi: "Mô hình bảo mật" } },
            { label: "Sessions", link: "/usage/sessions/" },
            { label: "Settings", link: "/usage/settings/" },
          ],
        },
      ],
    }),
  ],
});
