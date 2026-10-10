# Termote brand identity

## Intent

Termote gives a developer a quiet, continuous presence beside a terminal running elsewhere. The identity expresses that watchfulness without illustrating a terminal window, a network diagram, or an AI agent.

The brand line is: **Your Terminal, Anywhere.**

## Core metaphor: Prompt Owl

The mark is an abstract, geometric owl face. Its two eyes are terminal prompts: `> <`. This makes the command line part of the symbol rather than a decorative reference.

The owl signals observation, intelligence, night-time developer culture and near-silent operation. It is not a mascot. The desired read is technical symbol first, owl second, terminal connection third.

## Canonical assets

The editable brand source of truth is [assets/branding/termote](../assets/branding/termote/README.md):

- Use [`logo/horizontal-lockup.svg`](../assets/branding/termote/logo/horizontal-lockup.svg) for product headers, GitHub and documentation.
- Use [`logo/symbol.svg`](../assets/branding/termote/logo/symbol.svg) where Termote is already identifiable.
- Use the appropriate asset under [`icons/`](../assets/branding/termote/icons/) or [`variants/`](../assets/branding/termote/variants/) for platform and colour-context needs.

The PWA, the website and the README consume derived copies. They are deployment assets, not the editable brand source.

## Derived assets

Edit a source under `assets/branding/termote/`, then run `make brand-assets`
([`scripts/build-brand-assets.sh`](../scripts/build-brand-assets.sh); needs `rsvg-convert` and ImageMagick) and commit what it writes. A second run leaves no diff.

| Source                          | Output                                                                                                |
| ------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `icons/favicon.svg`             | `pwa/public/favicon.svg`, `pwa/public/favicon.ico` (16, 32, 48), `website/public/favicon.svg`         |
| `icons/app-icon-dark.svg`       | `pwa/public/pwa-192x192.png`, `pwa/public/pwa-512x512.png` (manifest `any`)                           |
| `icons/app-icon-maskable.svg`   | `pwa/public/pwa-maskable-512x512.png` (manifest `maskable`), `apple-touch-icon.png` (PWA and website) |
| `icons/app-icon-monochrome.svg` | `pwa/public/pwa-monochrome-512x512.png` (manifest `monochrome`)                                       |
| `icons/notification-badge.svg`  | `pwa/public/badge-96x96.png` (notification `badge`)                                                   |
| `logo/symbol-knockout.svg`      | `website/src/assets/brand/symbol-{light,dark}.svg` (site logo and hero)                               |
| `social/banner-github.svg`      | `social/banner-github.png`, `website/public/og-image.png`                                             |

Some copies are inline rather than generated, and a test holds each to the source path:
`pwa/src/components/brand-mark.tsx` (sidebar and header) and `server/brand.go` (the `/login` and
`/pair` pages and their favicon, served before sign-in while every icon file sits behind it).

The README shows `social/banner-readme-light.svg` or `-dark.svg` through `<picture>`. GitHub's
social preview is uploaded by hand: Settings → Social preview → `social/banner-github.png`.

Banners and other non-runtime images stay out of `pwa/public/`: everything there is precached by
the service worker and embedded in the binary.

## Visual rules

- Prefer the monochrome mark: ink `#101316` on white, or white on ink.
- Keep the `> <` eye geometry intact and keep enough empty space that the silhouette reads at a glance.
- Preserve the supplied title-case wordmark: `Termote`. Wordmark and tagline are outlined paths from Inter (Bold for the wordmark, Regular for the tagline; SIL Open Font License), so they render the same everywhere without a font.
- Use the tagline only with lockups that have sufficient room; it is not part of the standalone symbol or favicon.

## Do not

- Add circular eyes, feathers, wings, outlines, shadows, gradients or a badge/container around the symbol.
- Turn the owl into a cartoon, realistic bird, esports mascot, cat or fox silhouette.
- Recolour each eye independently or replace the prompt eyes with generic terminal/window icons.
- Stretch, rotate or redraw the silhouette.
