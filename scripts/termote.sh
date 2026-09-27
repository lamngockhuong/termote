#!/bin/bash
# Termote CLI shim for a git checkout: builds the termote binary (with the
# PWA embedded) when its sources changed, then runs it with the same arguments.
# Installed releases run the termote binary directly.
set -eo pipefail

# Resolve symlinks (the global `termote` command is one) without readlink -f.
src="${BASH_SOURCE[0]}"
while [[ -L "$src" ]]; do
    dir="$(CDPATH= cd -P "$(dirname "$src")" && pwd)"
    src="$(readlink "$src")"
    [[ "$src" != /* ]] && src="$dir/$src"
done
PROJECT_DIR="$(dirname "$(CDPATH= cd -P "$(dirname "$src")" && pwd)")"
export TERMOTE_PROJECT_DIR="$PROJECT_DIR"

info() { echo -e "\033[0;32m[INFO]\033[0m $1" >&2; }
warn() { echo -e "\033[1;33m[WARN]\033[0m $1" >&2; }
die() { echo -e "\033[0;31m[ERROR]\033[0m $1" >&2; exit 1; }

api="$PROJECT_DIR/server"
bin="$api/termote-dev"
pwa="$PROJECT_DIR/pwa"
[[ -f "$api/go.mod" ]] || die "not a Termote checkout ($api/go.mod missing); installed releases run 'termote' directly"

# Build the PWA once; later changes are rebuilt with: make build-pwa
if [[ -f "$pwa/package.json" && ! -f "$pwa/dist/index.html" ]]; then
    if command -v pnpm >/dev/null 2>&1; then
        info "Building the PWA..."
        (cd "$PROJECT_DIR" && pnpm install --frozen-lockfile --filter termote... >&2 && pnpm --filter termote build >&2) || die "PWA build failed"
    else
        warn "pnpm not found; the server will show a placeholder page instead of the app"
    fi
fi

# Rebuild when a Go source or the PWA build is newer than the binary.
if [[ ! -x "$bin" || -n "$(find "$api" "$api/webui" -maxdepth 1 \( -name '*.go' -o -name 'go.mod' -o -name 'go.sum' \) -newer "$bin" | head -n 1)" ||
    ( -f "$pwa/dist/index.html" && "$pwa/dist/index.html" -nt "$bin" ) ]]; then
    if command -v go >/dev/null 2>&1; then
        info "Building termote..."
        if [[ -f "$pwa/dist/index.html" ]]; then
            find "$api/webui/dist" -mindepth 1 ! -name .gitkeep -delete 2>/dev/null || true
            mkdir -p "$api/webui/dist" && cp -R "$pwa/dist/." "$api/webui/dist/"
        fi
        (cd "$api" && CGO_ENABLED=0 go build -ldflags="-s -w" -o termote-dev .) || die "Build failed"
    elif [[ -x "$bin" ]]; then
        warn "Go not found; running the existing (older) termote build"
    else
        die "Go is required to build termote in a checkout: https://go.dev/dl/"
    fi
fi

# No arguments opens the interactive menu.
[[ $# -eq 0 ]] && set -- menu
exec "$bin" "$@"
