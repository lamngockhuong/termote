#!/bin/bash
# Termote CLI shim: every command lives in the termote binary.
# 0.x `update` runs this exact path (link, then install <mode> [flags]), so the
# path and the flags it passes must keep working.
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

die() { echo -e "\033[0;31m[ERROR]\033[0m $1" >&2; exit 1; }

if [[ -f "$PROJECT_DIR/server/go.mod" ]]; then
    # Checkout: rebuild when any Go source is newer than the binary.
    api="$PROJECT_DIR/server"
    bin="$api/termote-dev"
    if [[ ! -x "$bin" || -n "$(find "$api" -maxdepth 1 \( -name '*.go' -o -name 'go.mod' -o -name 'go.sum' \) -newer "$bin" | head -n 1)" ]]; then
        if command -v go >/dev/null 2>&1; then
            echo -e "\033[0;32m[INFO]\033[0m Building termote..." >&2
            (cd "$api" && CGO_ENABLED=0 go build -ldflags="-s -w" -o termote-dev .) || die "Build failed"
        elif [[ -x "$bin" ]]; then
            echo -e "\033[1;33m[WARN]\033[0m Go not found; running the existing (older) termote build" >&2
        else
            die "Go is required to build termote in a checkout: https://go.dev/dl/"
        fi
    fi
else
    # Installed release: the tarball ships one binary per platform.
    case "$(uname -s)" in
        Darwin) os=darwin ;;
        Linux) os=linux ;;
        *) die "Unsupported OS: $(uname -s)" ;;
    esac
    case "$(uname -m)" in
        x86_64 | amd64) arch=amd64 ;;
        aarch64 | arm64) arch=arm64 ;;
        *) die "Unsupported architecture: $(uname -m)" ;;
    esac
    bin="$PROJECT_DIR/termote-$os-$arch"
    [[ -f "$bin" ]] || die "$bin not found; reinstall Termote"
    [[ -x "$bin" ]] || chmod +x "$bin"
fi

# No arguments opens the interactive menu, as in 0.x.
[[ $# -eq 0 ]] && set -- menu
exec "$bin" "$@"
