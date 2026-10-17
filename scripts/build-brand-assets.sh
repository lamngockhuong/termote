#!/bin/bash
# Regenerates every derived brand asset (PWA icons, favicons, social images)
# from the editable sources in assets/branding/termote. Run after a source
# changes: `make brand-assets`. Needs rsvg-convert and ImageMagick (magick);
# CI never runs it, the outputs are committed.
set -eo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/assets/branding/termote"
PWA="$ROOT/pwa/public"
WEB="$ROOT/website/public"

for tool in rsvg-convert magick; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "error: $tool not found (install librsvg and ImageMagick)" >&2
    exit 1
  fi
done

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# png <source.svg> <size|WxH> <output.png>: rendered, then written without
# timestamps or other metadata so a second run leaves no diff
png() {
  local w="${2%x*}" h="${2#*x}"
  rsvg-convert -w "$w" -h "$h" "$1" -o "$TMP/out.png"
  magick "$TMP/out.png" -strip -define png:exclude-chunks=date,time "$3"
}

cp "$SRC/icons/favicon.svg" "$PWA/favicon.svg"
cp "$SRC/icons/favicon.svg" "$WEB/favicon.svg"

for s in 16 32 48; do
  rsvg-convert -w "$s" -h "$s" "$SRC/icons/favicon.svg" -o "$TMP/fav-$s.png"
done
magick "$TMP/fav-16.png" "$TMP/fav-32.png" "$TMP/fav-48.png" -strip "$PWA/favicon.ico"

png "$SRC/icons/app-icon-dark.svg" 192 "$PWA/pwa-192x192.png"
png "$SRC/icons/app-icon-dark.svg" 512 "$PWA/pwa-512x512.png"
# Full bleed: Android masks it to its own shape, iOS rounds the corners itself
png "$SRC/icons/app-icon-maskable.svg" 512 "$PWA/pwa-maskable-512x512.png"
png "$SRC/icons/app-icon-maskable.svg" 180 "$PWA/apple-touch-icon.png"
png "$SRC/icons/app-icon-monochrome.svg" 512 "$PWA/pwa-monochrome-512x512.png"
png "$SRC/icons/notification-badge.svg" 96 "$PWA/badge-96x96.png"

# Website: the symbol in a fixed colour per theme (Starlight logo, hero),
# the eyes cut out so the page shows through, and the home-screen icon
mkdir -p "$ROOT/website/src/assets/brand"
sed 's/currentColor/#101316/' "$SRC/logo/symbol-knockout.svg" >"$ROOT/website/src/assets/brand/symbol-light.svg"
sed 's/currentColor/#F0F3F6/' "$SRC/logo/symbol-knockout.svg" >"$ROOT/website/src/assets/brand/symbol-dark.svg"
cp "$PWA/apple-touch-icon.png" "$WEB/apple-touch-icon.png"

# The homepage hero's owl blinks now and then, as the intro video's does:
# the same path cut at each Z, the eyes cut out through a mask whose eyes
# squash on their centre line. Its own style runs inside an <img>, and stops
# for reduced motion. Keyframes match the PWA's (pwa/src/index.css).
D="$(sed -nE 's/.* d="([^"]+)".*/\1/p' "$SRC/logo/symbol-knockout.svg")"
FACE="${D%%Z*}Z"
REST="${D#*Z}"
EYES="${REST%%Z*}Z"
REST="${REST#*Z}"
EYES="$EYES${REST%%Z*}Z"
BEAK="${REST#*Z}"
# One path of exactly four subpaths (face, two eyes, beak), on one line
if [ "$(printf %s "$D" | tr -cd Z | wc -c)" -ne 4 ] || [ "$D" != "${D%%$'\n'*}" ] || [ "$FACE$EYES$BEAK" != "$D" ]; then
  echo "error: symbol-knockout.svg is no longer a face, two eyes and a beak" >&2
  exit 1
fi
# blink_svg <fill> <output.svg>
blink_svg() {
  cat >"$2" <<SVG
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 332 298" role="img" aria-label="Termote">
  <style>
    .owl-eyes { transform-box: view-box; transform-origin: 0 0; animation: owl-blink 7s ease-in-out infinite; }
    @keyframes owl-blink { 0%, 4%, 8%, 100% { transform: translateY(135px) scaleY(1) translateY(-135px); } 6% { transform: translateY(135px) scaleY(0.12) translateY(-135px); } }
    @media (prefers-reduced-motion: reduce) { .owl-eyes { animation: none; } }
  </style>
  <defs>
    <mask id="owl-eyes-mask">
      <rect width="332" height="298" fill="#fff"/>
      <path class="owl-eyes" fill="#000" d="$EYES"/>
    </mask>
  </defs>
  <path fill="$1" fill-rule="evenodd" d="$FACE$BEAK" mask="url(#owl-eyes-mask)"/>
</svg>
SVG
}
blink_svg "#101316" "$ROOT/website/src/assets/brand/symbol-blink-light.svg"
blink_svg "#F0F3F6" "$ROOT/website/src/assets/brand/symbol-blink-dark.svg"

png "$SRC/social/banner-github.svg" 1280x640 "$SRC/social/banner-github.png"
cp "$SRC/social/banner-github.png" "$WEB/og-image.png"

echo "Brand assets written to pwa/public, website and assets/branding/termote/social"
