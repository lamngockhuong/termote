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
      sameAs: [`${SITE}/about/`, "https://khuong.dev/en/about/", "https://www.linkedin.com/in/lamngockhuong"],
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

type Route = App.Locals["starlightRoute"];
type SidebarEntry = Route["sidebar"][number];

// The sidebar group that holds the current page, and the page's own link
function findCurrent(entries: SidebarEntry[], group?: SidebarEntry): { group?: SidebarEntry; link?: SidebarEntry } {
  for (const entry of entries) {
    if (entry.type === "link" && entry.isCurrent) return { group, link: entry };
    if (entry.type === "group") {
      const found = findCurrent(entry.entries, entry);
      if (found.link) return found;
    }
  }
  return {};
}

function firstLink(entry: SidebarEntry): string | undefined {
  if (entry.type === "link") return entry.href;
  for (const child of entry.entries) {
    const href = firstLink(child);
    if (href) return href;
  }
  return undefined;
}

// A docs page: where it sits in the site (home, sidebar group, page) and the
// article itself, tied to the home page's site, author and app by @id
function docsGraph(route: Route, path: string) {
  const url = `${SITE}${path}`;
  const home = route.locale ? `${SITE}/${route.locale}/` : `${SITE}/`;
  const { group, link } = findCurrent(route.sidebar);
  const crumbs: { name: string; item: string }[] = [{ name: "Termote", item: home }];
  const groupHref = group && firstLink(group);
  if (group && groupHref) crumbs.push({ name: group.label, item: `${SITE}${groupHref}` });
  crumbs.push({ name: link?.label ?? route.entry.data.title, item: url });

  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "BreadcrumbList",
        itemListElement: crumbs.map((crumb, i) => ({
          "@type": "ListItem",
          position: i + 1,
          name: crumb.name,
          // The last item is the page itself
          ...(i < crumbs.length - 1 ? { item: crumb.item } : {}),
        })),
      },
      {
        "@type": "TechArticle",
        "@id": `${url}#article`,
        url,
        headline: route.entry.data.title,
        description: route.entry.data.description,
        inLanguage: route.lang,
        // The "Last updated" date of the page; left out without git history
        // rather than claiming the build date
        ...(route.lastUpdated ? { dateModified: route.lastUpdated.toISOString() } : {}),
        author: { "@id": `${SITE}/#author` },
        publisher: { "@id": `${SITE}/#author` },
        isPartOf: { "@id": `${SITE}/#website` },
        about: { "@id": `${SITE}/#app` },
      },
    ],
  };
}

export const onRequest = defineRouteMiddleware((context) => {
  const route = context.locals.starlightRoute;
  const path = context.url.pathname;

  if (ARCHIVED.test(path)) {
    route.head.push({ tag: "meta", attrs: { name: "robots", content: "noindex, follow" }, content: "" });
  }

  // A page whose frontmatter sets its <title> shares that title, not the
  // short one of the sidebar and the H1
  const ownTitle = route.entry.data.head.find((entry) => entry.tag === "title")?.content;
  if (ownTitle) {
    for (const entry of route.head) {
      if (entry.tag === "meta" && entry.attrs?.property === "og:title") entry.attrs.content = ownTitle;
    }
  }

  const isHome = path === "/" || path === "/vi/";
  if (!isHome && !ARCHIVED.test(path) && route.entry.data.template === "doc" && route.id !== "404") {
    route.head.push({
      tag: "script",
      attrs: { type: "application/ld+json" },
      content: JSON.stringify(docsGraph(route, path)),
    });
  }

  if (isHome) {
    // The home page is the site, not an article
    for (const entry of route.head) {
      if (entry.tag === "meta" && entry.attrs?.property === "og:type") entry.attrs.content = "website";
    }
    route.head.push({
      tag: "script",
      attrs: { type: "application/ld+json" },
      content: JSON.stringify(homeGraph),
    });
  }
});
