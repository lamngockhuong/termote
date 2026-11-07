import { defineRouteMiddleware } from "@astrojs/starlight/route-data";
import { ARCHIVED } from "./archived.mjs";

const SITE = "https://termote.ohnice.app";
const REPO = "https://github.com/lamngockhuong/termote";

// What the home page describes, for search engines and AI answers: the site,
// its author and the app
const homeGraph = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebSite",
      "@id": `${SITE}/#website`,
      url: `${SITE}/`,
      name: "Termote",
      inLanguage: ["en", "vi"],
      publisher: { "@id": `${SITE}/#author` },
    },
    {
      "@type": "Person",
      "@id": `${SITE}/#author`,
      name: "Lam Ngoc Khuong",
      url: "https://github.com/lamngockhuong",
    },
    {
      "@type": "SoftwareApplication",
      "@id": `${SITE}/#app`,
      name: "Termote",
      url: `${SITE}/`,
      description:
        "Open-source, self-hosted PWA to control Claude Code, Codex and tmux, Herdr or Zellij terminal sessions from a phone or another computer.",
      applicationCategory: "DeveloperApplication",
      operatingSystem: "Linux, macOS, Windows",
      license: `${REPO}/blob/main/LICENSE`,
      isAccessibleForFree: true,
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      downloadUrl: `${REPO}/releases`,
      image: `${SITE}/og-image.png`,
      author: { "@id": `${SITE}/#author` },
      sameAs: [REPO, "https://hub.docker.com/r/lamngockhuong/termote"],
    },
  ],
};

export const onRequest = defineRouteMiddleware((context) => {
  const route = context.locals.starlightRoute;
  const path = context.url.pathname;

  if (ARCHIVED.test(path)) {
    route.head.push({ tag: "meta", attrs: { name: "robots", content: "noindex, follow" }, content: "" });
  }

  if (path === "/" || path === "/vi/") {
    // The home page is the site, not an article, and its share card carries
    // the page title (frontmatter head) rather than the bare site name
    const title = route.head.find((entry) => entry.tag === "title")?.content;
    for (const entry of route.head) {
      if (entry.tag !== "meta" || !entry.attrs) continue;
      if (entry.attrs.property === "og:type") entry.attrs.content = "website";
      if (entry.attrs.property === "og:title" && title) entry.attrs.content = title;
    }
    route.head.push({
      tag: "script",
      attrs: { type: "application/ld+json" },
      content: JSON.stringify(homeGraph),
    });
  }
});
