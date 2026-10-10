# Termote · Prompt Owl

Final vector direction based on the approved `> <` eye motif and the supplied master horizontal logo. The mark is deliberately flat, monochrome-first, and uses no bitmap, gradient, shadow, or stroke-dependent detail.

## Structure

- `logo/` — primary brand marks: standalone symbol, wordmark, horizontal and vertical lockups.
- `icons/` — dark/light app icons, the full-bleed maskable icon, the monochrome (alpha-only) icon, the notification badge and the SVG favicon.
- `variants/` — monochrome marks plus dark/light presentation lockups.
- `social/` — GitHub social preview (`banner-github.svg` and its PNG) and the README banners for light and dark pages.
- `logo/symbol-knockout.svg` — the symbol as one path with the eyes and beak cut out, in `currentColor`, for inline use on any surface.

## Application assets

`make brand-assets` regenerates every derived copy (PWA icons, favicons, website logo, social PNG); see [docs/brand-identity.md](../../../docs/brand-identity.md#derived-assets) for the source-to-output map.

## Usage

Use `logo/symbol.svg` where the product is already known. Use `logo/horizontal-lockup.svg` for GitHub, documentation and product headers. The `> <` eyes are the protected signature: do not replace them with circular eyes, add feathers, outlines, gradients, or a container badge.

The wordmark preserves the supplied `Termote` casing. All text is outlined from Inter (Bold wordmark, Regular tagline; SIL Open Font License), so no file depends on an installed font.
