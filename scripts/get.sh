#!/bin/bash
# Termote online installer: downloads a release, verifies its checksum,
# extracts it and hands over to the termote CLI, which does the install.
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/lamngockhuong/termote/main/scripts/get.sh | bash
#     -> Downloads latest, prompts before install (defaults to native mode)
#   curl ... | bash -s -- --yes
#     -> Auto-install without prompt
#   curl ... | bash -s -- --container --lan
#     -> Container mode with LAN access (other flags go to `termote install`)
#   curl ... | bash -s -- --download-only
#     -> Download only, no install
#   curl ... | bash -s -- --update
#     -> Re-install with the saved config from the previous install
#   curl ... | bash -s -- --version 1.0.0
#     -> Install/downgrade to a specific version

set -eo pipefail

REPO="lamngockhuong/termote"
INSTALL_DIR="${TERMOTE_INSTALL_DIR:-$HOME/.termote}"
CONFIG_FILE="$HOME/.termote/config"
SHIM="${INSTALL_DIR}/scripts/termote.sh"
AUTO_YES=false
DOWNLOAD_ONLY=false
UPDATE_MODE=false
STRICT_CHECKSUM=false
PIN_VERSION=""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info() { echo -e "${GREEN}[INFO]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1" >&2; exit 1; }

# Installed version, from the .version file an install writes
get_installed_version() {
    [[ -f "${INSTALL_DIR}/.version" ]] && cat "${INSTALL_DIR}/.version"
    return 0
}

get_latest_version() {
    curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" |
        grep '"tag_name":' | sed -E 's/.*"v([^"]+)".*/\1/'
}

# Saved install mode, for --update (parse KEY="value", never source the file)
get_saved_mode() {
    grep '^TERMOTE_MODE=' "$CONFIG_FILE" | cut -d= -f2- | tr -d '"' || true
}

sha256_of() {
    if command -v sha256sum >/dev/null; then
        sha256sum "$1" | awk '{print $1}'
    elif command -v shasum >/dev/null; then
        shasum -a 256 "$1" | awk '{print $1}'
    fi
}

# verify_checksum <file> <name> <checksums-url>
verify_checksum() {
    local expected actual checksums
    checksums=$(curl -fsSL "$3" 2>/dev/null || true)
    expected=$(echo "$checksums" | awk -v f="$2" '$2 == f || $2 == "*"f {print $1}')
    if [[ -z "$expected" ]]; then
        [[ "$STRICT_CHECKSUM" == true ]] && error "Checksum not available for $2 (--strict mode)"
        warn "Checksum not available for $2, skipping verification"
        return 0
    fi
    actual=$(sha256_of "$1")
    if [[ -z "$actual" ]]; then
        [[ "$STRICT_CHECKSUM" == true ]] && error "No sha256sum/shasum found (--strict mode)"
        warn "No sha256sum/shasum found, skipping checksum verification"
        return 0
    fi
    [[ "$actual" == "$expected" ]] || error "Checksum mismatch! Expected: $expected, Got: $actual"
    info "Checksum verified"
}

confirm_install() {
    local current="$1" target="$2" question
    echo ""
    if [[ -z "$current" ]]; then
        info "Target version: v${target}"
        question="Install Termote?"
    elif [[ "$current" == "$target" ]]; then
        info "Current version: v${current} (same as target)"
        question="Re-install?"
    else
        info "Current version: v${current}"
        info "Target version:  v${target}"
        question="Switch to v${target}?"
    fi
    echo -e "${question} [y/N] \c"
    local response
    read -r response </dev/tty
    [[ "$response" =~ ^[yY]([eE][sS])?$ ]]
}

show_help() {
    cat <<'EOF'
Termote Installer

Usage: curl -fsSL <url>/get.sh | bash -s -- [options]

Modes:
  --native              Native mode (default)
  --container           Container mode (docker/podman)

Options:
  --yes, -y             Auto-install without prompt
  --version <ver>       Install a specific version (e.g. 1.0.0, 1.0.0-rc.1)
  --update              Re-install with the saved config
  --download-only       Download without installing
  --strict              Require checksum verification (fail if unavailable)
  --help, -h            Show this help

Any other option goes to `termote install` (e.g. --lan, --no-auth,
--tailscale <host>, --mux herdr, --allow-host <name>).

Examples:
  bash -s --                          # Interactive install (native)
  bash -s -- --container --lan        # Container + LAN
  bash -s -- --update                 # Update with saved config
  bash -s -- --update --version 0.1.0 # Downgrade with saved config
EOF
}

main() {
    local mode="" args=()
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --help | -h) show_help; exit 0 ;;
            --yes | -y) AUTO_YES=true ;;
            --download-only) DOWNLOAD_ONLY=true ;;
            --update) UPDATE_MODE=true; AUTO_YES=true ;;
            --strict) STRICT_CHECKSUM=true ;;
            --version)
                PIN_VERSION="${2#v}"
                [[ "$PIN_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] ||
                    error "Invalid version format: ${2:-} (expected: X.Y.Z)"
                shift ;;
            --container | container) mode="container" ;;
            --native | native) mode="native" ;;
            *) args+=("$1") ;;
        esac
        shift
    done

    info "Termote Installer"
    info "Install path: $INSTALL_DIR"
    command -v curl >/dev/null || error "curl is required"
    command -v tar >/dev/null || error "tar is required"

    local version="$PIN_VERSION"
    if [[ -z "$version" ]]; then
        version=$(get_latest_version)
        [[ -n "$version" ]] || error "Failed to get latest version"
    fi

    if [[ "$AUTO_YES" == false && "$DOWNLOAD_ONLY" == false ]]; then
        if ! confirm_install "$(get_installed_version)" "$version"; then
            info "Cancelled."
            exit 0
        fi
    fi

    local tarball="termote-v${version}.tar.gz"
    local base="https://github.com/${REPO}/releases/download/v${version}"
    # Global so the EXIT trap still sees it after main returns
    tmp=$(mktemp -d)
    trap 'rm -rf "$tmp"' EXIT

    info "Downloading ${tarball}..."
    curl -fsSL -o "$tmp/$tarball" "$base/$tarball" || error "Download failed: $base/$tarball"
    info "Verifying checksum..."
    verify_checksum "$tmp/$tarball" "$tarball" "$base/checksums.txt"

    # Extract over the install dir: the saved config lives outside the tarball.
    # Running services are stopped by `termote install`; the tarball holds no
    # binary a running server executes.
    info "Extracting..."
    mkdir -p "$INSTALL_DIR"
    tar xzf "$tmp/$tarball" --strip-components=1 -C "$INSTALL_DIR"
    echo "$version" >"${INSTALL_DIR}/.version"
    chmod +x "$SHIM"

    if [[ "$DOWNLOAD_ONLY" == true ]]; then
        info "Download complete. Files extracted to: $INSTALL_DIR"
        info "To install: $SHIM install [native|container]"
        exit 0
    fi

    # `install` merges the saved config for every flag not given here.
    if [[ "$UPDATE_MODE" == true && -z "$mode" ]]; then
        [[ -f "$CONFIG_FILE" ]] || error "No saved config found. Run 'termote install' first."
        mode=$(get_saved_mode)
        info "Using saved config (mode: ${mode:-native})"
    fi
    [[ -z "$mode" ]] && mode="native"

    info "Running installer..."
    "$SHIM" install "$mode" "${args[@]}"

    # Create the global 'termote' command (old releases may lack `link`)
    # Capture first: with pipefail, grep -q closing the pipe early could fail it
    local help
    help=$("$SHIM" help 2>/dev/null || true)
    if grep -qE '^ +link ' <<<"$help"; then
        "$SHIM" link
    fi
}

main "$@"
