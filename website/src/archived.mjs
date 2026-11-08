// The archived 0.x docs, in every locale: noindex (src/route-data.ts) and out
// of the sitemap (astro.config.mjs), their links still followed
export const ARCHIVED = /^\/(?:vi\/)?0\.x\//;

// Pages that moved and now only send a reader on (src/pages): out of the
// sitemap, noindex
export const MOVED = /^\/(?:vi\/)?usage\/files-changes\/$/;
