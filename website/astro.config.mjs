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
            { label: "Gestures", link: "/usage/gestures/" },
            { label: "Keyboard", link: "/usage/keyboard/" },
            { label: "Sessions", link: "/usage/sessions/" },
            { label: "Settings", link: "/usage/settings/" },
          ],
        },
      ],
    }),
  ],
});
