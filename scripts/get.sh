#!/bin/bash
# Termote online installer
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/lamngockhuong/termote/main/scripts/get.sh | bash
#     -> Downloads latest, prompts before install (defaults to native mode)
#   curl ... | bash -s -- --yes
#     -> Auto-install without prompt
#   curl ... | bash -s -- --container --lan
#     -> Container mode with LAN access
#   curl ... | bash -s -- --download-only
#     -> Download only, no install

set -e

REPO="lamngockhuong/termote"
INSTALL_DIR="${TERMOTE_INSTALL_DIR:-$HOME/.termote}"
AUTO_YES=false
DOWNLOAD_ONLY=false

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info() { echo -e "${GREEN}[INFO]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# Path to termote CLI (reused in multiple functions)
TERMOTE_SCRIPT="${INSTALL_DIR}/scripts/termote.sh"

# Get installed version (if any)
get_installed_version() {
    if [ -f "$TERMOTE_SCRIPT" ]; then
        grep 'VERSION=' "$TERMOTE_SCRIPT" 2>/dev/null | head -1 | cut -d'"' -f2
    fi
}

# Check if services are running
services_running() {
    pgrep -f "tmux-api" >/dev/null 2>&1 || pgrep -f "ttyd" >/dev/null 2>&1
}

# Stop running services
stop_services() {
    if [ -f "$TERMOTE_SCRIPT" ]; then
        info "Stopping running services..."
        "$TERMOTE_SCRIPT" uninstall all 2>/dev/null || true
    fi
}

# Prompt user for confirmation
confirm_install() {
    local current="$1"
    local latest="$2"

    echo ""
    if [ -n "$current" ]; then
        if [ "$current" = "$latest" ]; then
            info "Current version: v${current} (same as latest)"
            echo -e "Re-install? [y/N] \c"
        else
            info "Current version: v${current}"
            info "Latest version:  v${latest}"
            echo -e "Update to v${latest}? [y/N] \c"
        fi
    else
        info "Latest version: v${latest}"
        echo -e "Install Termote? [y/N] \c"
    fi

    read -r response </dev/tty
    case "$response" in
        [yY]|[yY][eE][sS]) return 0 ;;
        *) return 1 ;;
    esac
}

# Detect latest version
get_latest_version() {
    curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | \
        grep '"tag_name":' | sed -E 's/.*"v([^"]+)".*/\1/'
}

# Detect architecture
get_arch() {
    case "$(uname -m)" in
        x86_64|amd64) echo "amd64" ;;
        aarch64|arm64) echo "arm64" ;;
        *) error "Unsupported architecture: $(uname -m)" ;;
    esac
}

# Verify checksum
verify_checksum() {
    local file="$1"
    local expected="$2"
    local actual

    if command -v sha256sum >/dev/null; then
        actual=$(sha256sum "$file" | awk '{print $1}')
    elif command -v shasum >/dev/null; then
        actual=$(shasum -a 256 "$file" | awk '{print $1}')
    else
        warn "No sha256sum/shasum found, skipping checksum verification"
        return 0
    fi

    if [ "$actual" != "$expected" ]; then
        error "Checksum mismatch! Expected: $expected, Got: $actual"
    fi
    info "Checksum verified"
}

# Main
main() {
    info "Termote Installer"
    info "Install path: $INSTALL_DIR"

    local mode=""
    local args=()
    for arg in "$@"; do
        case "$arg" in
            --yes|-y) AUTO_YES=true ;;
            --download-only) DOWNLOAD_ONLY=true ;;
            --container|container) mode="container" ;;
            --native|native) mode="native" ;;
            *) args+=("$arg") ;;
        esac
    done

    # Check dependencies
    command -v curl >/dev/null || error "curl is required"
    command -v tar >/dev/null || error "tar is required"

    # Get versions (lightweight API call, no download yet)
    CURRENT_VERSION=$(get_installed_version)
    VERSION=$(get_latest_version)
    [ -z "$VERSION" ] && error "Failed to get latest version"

    # Prompt BEFORE download (unless --yes or --download-only)
    if [ "$AUTO_YES" = false ] && [ "$DOWNLOAD_ONLY" = false ]; then
        if ! confirm_install "$CURRENT_VERSION" "$VERSION"; then
            info "Cancelled."
            exit 0
        fi
    fi

    # Stop services if running (to avoid "Text file busy" error)
    if services_running; then
        warn "Services are running"
        if [ "$AUTO_YES" = true ]; then
            stop_services
        else
            echo -e "Stop services before update? [Y/n] \c"
            read -r response </dev/tty
            case "$response" in
                [nN]|[nN][oO])
                    error "Cannot update while services are running. Stop manually: ./scripts/termote.sh uninstall [native|container]"
                    ;;
                *)
                    stop_services
                    ;;
            esac
        fi
    fi

    # Create install directory
    mkdir -p "$INSTALL_DIR"
    cd "$INSTALL_DIR"

    # Download tarball and checksums
    TARBALL="termote-v${VERSION}.tar.gz"
    TARBALL_URL="https://github.com/${REPO}/releases/download/v${VERSION}/${TARBALL}"
    CHECKSUMS_URL="https://github.com/${REPO}/releases/download/v${VERSION}/checksums.txt"

    info "Downloading ${TARBALL}..."
    curl -fsSL -o "$TARBALL" "$TARBALL_URL"

    # Verify checksum
    info "Verifying checksum..."
    CHECKSUMS=$(curl -fsSL "$CHECKSUMS_URL" 2>/dev/null || echo "")
    if [ -n "$CHECKSUMS" ]; then
        EXPECTED=$(echo "$CHECKSUMS" | grep "$TARBALL" | awk '{print $1}')
        if [ -n "$EXPECTED" ]; then
            verify_checksum "$TARBALL" "$EXPECTED"
        else
            warn "Checksum not found for ${TARBALL}, skipping verification"
        fi
    else
        warn "Could not download checksums, skipping verification"
    fi

    # Extract
    info "Extracting..."
    tar xzf "$TARBALL" --strip-components=1
    rm -f "$TARBALL"

    # Download only mode - stop here
    if [ "$DOWNLOAD_ONLY" = true ]; then
        info "Download complete. Files extracted to: $INSTALL_DIR"
        info "To install manually: cd $INSTALL_DIR && ./scripts/termote.sh install [native|container]"
        exit 0
    fi

    # Run termote CLI
    info "Running installer..."
    chmod +x scripts/termote.sh

    # Default to native if no mode specified
    [[ -z "$mode" ]] && mode="native"

    ./scripts/termote.sh install "$mode" "${args[@]}"
}

main "$@"
