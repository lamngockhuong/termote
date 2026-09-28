#!/bin/sh
# Termote installer: download the release for this platform, verify its
# sha256, lay it down under ~/.local/share/termote, and put `termote` on PATH.
#
#   curl -fsSL https://termote.ohnice.app/install.sh | sh
#   curl -fsSL https://termote.ohnice.app/install.sh | TERMOTE_VERSION=1.0.0 sh
#
# It never asks for sudo, never writes outside ~/.local/share/termote and
# ~/.local/bin, and never starts anything: it ends by printing `termote start`.
# Every file it fetches is a plain GitHub Release asset you can download and
# check by hand.
#
# TERMOTE_VERSION=X.Y.Z (or X.Y.Z-rc.N) installs that exact release and skips
# the lookup of the newest one. With a version already installed it is the
# rescue path: the named version is laid down beside it and `current` points
# at it. GH_TOKEN (or GITHUB_TOKEN) only raises the GitHub API rate limit.
set -eu

REPO="lamngockhuong/termote"
DIR="${XDG_DATA_HOME:-$HOME/.local/share}/termote"
BIN_DIR="$HOME/.local/bin"

die() { echo "termote install: $1" >&2; exit 1; }

# A pinned version is checked before anything is fetched or touched.
PIN="${TERMOTE_VERSION:-}"
PIN="${PIN#v}"
if [ -n "$PIN" ]; then
  # One line only: grep checks each line on its own.
  case "$PIN" in *"
"*) die "TERMOTE_VERSION must be a single line." ;; esac
  printf '%s\n' "$PIN" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$' ||
    die "TERMOTE_VERSION='$PIN' is not a version. It has to look like 1.0.0, or 1.0.0-rc.1 for a pre-release."
fi

command -v curl >/dev/null 2>&1 || die "curl is required. Install it with your package manager, then run this again."
command -v tar >/dev/null 2>&1 || die "tar is required. Install it with your package manager, then run this again."
if command -v sha256sum >/dev/null 2>&1; then SHA="sha256sum"
elif command -v shasum >/dev/null 2>&1; then SHA="shasum -a 256"
else die "no sha256 tool found (sha256sum or shasum). The download must be verified, so this stops here."
fi

case "$(uname -s)" in
  Linux) OS=linux ;;
  Darwin) OS=darwin ;;
  *) die "Termote publishes no binary for $(uname -s). On Windows run: irm https://termote.ohnice.app/install.ps1 | iex" ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) ARCH=amd64 ;;
  aarch64 | arm64) ARCH=arm64 ;;
  *) die "Termote publishes no binary for $(uname -m). Build from source instead: https://github.com/${REPO}#build-from-source" ;;
esac

# Leave an existing install alone, unless a version was pinned. An install
# is a current pointer; without one (an install cut short, or removed with
# its logs kept) the dir may hold only what an install leaves behind.
RESCUE=0
if [ -L "$DIR/current" ]; then
  if [ -z "$PIN" ]; then
    echo "Termote is already installed at $DIR; leaving it alone."
    echo "To move it forward, run:  termote update"
    echo "To put one specific version there instead, run this again with TERMOTE_VERSION=X.Y.Z"
    exit 0
  fi
  echo "Termote is already installed at $DIR; laying $PIN down beside it and pointing current at it."
  RESCUE=1
elif [ -e "$DIR" ]; then
  for entry in "$DIR"/* "$DIR"/.[!.]*; do
    [ -e "$entry" ] || [ -L "$entry" ] || continue
    case "${entry##*/}" in
      versions | previous | .unpack-*) ;;
      *) die "$DIR exists and is not a Termote install. Move it aside, then run this again." ;;
    esac
  done
fi

# Downloads go to a scratch dir outside the install, so a failed or
# unverified download leaves nothing in it.
TMP=$(mktemp -d "${TMPDIR:-/tmp}/termote-install.XXXXXX") || die "could not create a temporary directory."
STAGE=""
trap 'rm -rf "$TMP" ${STAGE:+"$STAGE"}' EXIT
trap 'exit 130' INT HUP TERM

# The newest release: the tag list sorted by version, stable 1.x and later
# only. releases/latest is not used, as it can name a 0.x release.
if [ -n "$PIN" ]; then
  VERSION="$PIN"
else
  TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
  if [ -n "$TOKEN" ]; then
    # The token goes in a curl config file (mode 600), never on the command
    # line, where ps would show it.
    # Backslashes and quotes are escaped for the curl config syntax.
    ESCAPED=$(printf '%s' "$TOKEN" | sed 's/[\\"]/\\&/g')
    (umask 077 && printf 'header = "Authorization: Bearer %s"\n' "$ESCAPED" >"$TMP/auth.curlrc") || die "could not write $TMP/auth.curlrc."
    set -- -K "$TMP/auth.curlrc"
  else
    set --
  fi
  CODE=$(curl -sSL -o "$TMP/tags.json" -w '%{http_code}' -H 'Accept: application/vnd.github+json' "$@" \
    "https://api.github.com/repos/${REPO}/tags?per_page=100") ||
    die "could not reach api.github.com to list the releases. Check your network and try again."
  case "$CODE" in
    200) ;;
    403 | 429) die "GitHub's API rate limit says no (HTTP $CODE). Set GH_TOKEN to a GitHub token with no scopes, wait an hour, or name the version and skip this call:  TERMOTE_VERSION=X.Y.Z  (see https://github.com/${REPO}/releases)" ;;
    *) die "api.github.com answered HTTP $CODE for the tags of ${REPO}. Try again later, or name the version:  TERMOTE_VERSION=X.Y.Z" ;;
  esac
  VERSION=$(tr ',{}' '\n\n\n' <"$TMP/tags.json" | grep -o '"name":[[:space:]]*"[^"]*"' | sed 's/.*"v\{0,1\}\([^"]*\)"$/\1/' |
    grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | grep -vE '^0\.' | sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1 || true)
  [ -n "$VERSION" ] || die "no 1.x release found for ${REPO}. Name one with TERMOTE_VERSION=X.Y.Z (see https://github.com/${REPO}/releases)."
fi

publish_name() {
  "$DIR/versions/$VERSION/bin/termote" link ||
    echo "note: 'termote link' did not publish the command; run '$DIR/current/bin/termote link' to see why."
}

finish() {
  case ":${PATH}:" in
    *":$BIN_DIR:"*) CMD=termote ;;
    *)
      CMD="$DIR/current/bin/termote"
      echo ""
      echo "note: $BIN_DIR is not on your PATH. Add it to your shell profile:"
      echo "  export PATH=\"$BIN_DIR:\$PATH\""
      ;;
  esac
  cat <<EOF

Termote $VERSION is installed at $DIR, and nothing is running yet.
Start it (it asks for nothing; see '$CMD help' for options such as --lan):

  $CMD start

EOF
}

# The pinned version may already be on disk (a rollback): just point at it.
if [ "$RESCUE" -eq 1 ] && [ -d "$DIR/versions/$VERSION" ]; then
  [ -x "$DIR/versions/$VERSION/bin/termote" ] || die "$DIR/versions/$VERSION holds no runnable bin/termote. Move it aside and run this again."
  ln -sfn "versions/$VERSION" "$DIR/current" || die "could not point $DIR/current at versions/$VERSION."
  publish_name
  echo "Termote $VERSION was already in $DIR/versions; current now points at it and nothing was downloaded."
  finish
  exit 0
fi

# Download and verify before anything is unpacked; there is no way to skip
# the check.
NAME="termote-${VERSION}-${OS}-${ARCH}"
BASE="https://github.com/${REPO}/releases/download/v${VERSION}"
echo "Downloading Termote ${VERSION} for ${OS}-${ARCH}..."
curl -fsSL -o "$TMP/$NAME.tar.gz" "$BASE/$NAME.tar.gz" ||
  die "release ${VERSION} has no ${OS}-${ARCH} archive: the version does not exist, or it was released a few minutes ago and is still publishing (retry then). See https://github.com/${REPO}/releases"
curl -fsSL -o "$TMP/$NAME.tar.gz.sha256" "$BASE/$NAME.tar.gz.sha256" ||
  die "could not download $NAME.tar.gz.sha256; refusing to install an unverified binary."
# The .sha256 file must name this archive, then match it.
grep -q "[[:space:]]\*\{0,1\}$NAME.tar.gz\$" "$TMP/$NAME.tar.gz.sha256" ||
  die "$NAME.tar.gz.sha256 does not list $NAME.tar.gz; refusing to install an unverified binary."
(cd "$TMP" && $SHA -c "$NAME.tar.gz.sha256" >/dev/null 2>&1) ||
  die "CHECKSUM MISMATCH for $NAME.tar.gz: the download was discarded and nothing was installed. Try again; if it repeats, report it."

# Unpack beside versions/ (same file system), so the move into place is a
# rename: a version dir is never half written.
mkdir -p "$DIR/versions" || die "could not create $DIR/versions."
STAGE="$DIR/.unpack-$$"
mkdir -p "$STAGE" || die "could not create $STAGE."
tar -xzf "$TMP/$NAME.tar.gz" -C "$STAGE" || die "could not unpack $NAME.tar.gz."
[ -x "$STAGE/$NAME/bin/termote" ] || die "$NAME.tar.gz does not contain bin/termote; refusing to install it."
rm -rf "$DIR/versions/$VERSION"
mv "$STAGE/$NAME" "$DIR/versions/$VERSION" || die "could not move the payload into $DIR/versions/$VERSION."
ln -sfn "versions/$VERSION" "$DIR/current" || die "could not point $DIR/current at versions/$VERSION."

publish_name
finish
