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
#   curl ... | bash -s -- --update
#     -> Auto-update using saved config from previous install
#   curl ... | bash -s -- --version 0.0.4
#     -> Install/downgrade to a specific version

set -e

REPO="lamngockhuong/termote"
INSTALL_DIR="${TERMOTE_INSTALL_DIR:-$HOME/.termote}"
AUTO_YES=false
DOWNLOAD_ONLY=false
UPDATE_MODE=false
PIN_VERSION=""

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

# Load saved config for --update mode (parse key=value, never source)
load_config() {
    local config="$HOME/.termote/config"
    if [[ ! -f "$config" ]]; then
        error "No saved config found. Run 'termote.sh install' first."
    fi
    TERMOTE_MODE=$(grep '^TERMOTE_MODE=' "$config" 2>/dev/null | cut -d= -f2-)
    TERMOTE_LAN=$(grep '^TERMOTE_LAN=' "$config" 2>/dev/null | cut -d= -f2-)
    TERMOTE_NO_AUTH=$(grep '^TERMOTE_NO_AUTH=' "$config" 2>/dev/null | cut -d= -f2-)
    TERMOTE_PORT=$(grep '^TERMOTE_PORT=' "$config" 2>/dev/null | cut -d= -f2-)
    TERMOTE_TAILSCALE=$(grep '^TERMOTE_TAILSCALE=' "$config" 2>/dev/null | cut -d= -f2-)
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
            info "Current version: v${current} (same as target)"
            echo -e "Re-install? [y/N] \c"
        else
            info "Current version: v${current}"
            info "Target version:  v${latest}"
            echo -e "Switch to v${latest}? [y/N] \c"
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

show_help() {
    echo "Termote Installer"
    echo ""
    echo "Usage: curl -fsSL <url>/get.sh | bash -s -- [options]"
    echo ""
    echo "Modes:"
    echo "  --native              Native mode (default)"
    echo "  --container           Container mode (docker/podman)"
    echo ""
    echo "Options:"
    echo "  --yes, -y             Auto-install without prompt"
    echo "  --version <ver>       Install specific version (e.g. 0.0.4)"
    echo "  --update              Re-install with saved config"
    echo "  --download-only       Download without installing"
    echo "  --lan                 Expose to LAN"
    echo "  --no-auth             Disable authentication"
    echo "  --tailscale <host>    Enable Tailscale HTTPS"
    echo "  --help, -h            Show this help"
    echo ""
    echo "Examples:"
    echo "  bash -s --                          # Interactive install (native)"
    echo "  bash -s -- --container --lan        # Container + LAN"
    echo "  bash -s -- --update                 # Update with saved config"
    echo "  bash -s -- --version 0.0.4          # Install specific version"
    echo "  bash -s -- --update --version 0.0.3 # Downgrade with saved config"
}

# Main
main() {
    # Check for --help before printing header
    for arg in "$@"; do
        case "$arg" in --help|-h) show_help; exit 0 ;; esac
    done

    info "Termote Installer"
    info "Install path: $INSTALL_DIR"

    local mode=""
    local args=()
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --yes|-y) AUTO_YES=true; shift ;;
            --download-only) DOWNLOAD_ONLY=true; shift ;;
            --update) UPDATE_MODE=true; AUTO_YES=true; shift ;;
            --version)
                PIN_VERSION="${2#v}"
                if [[ ! "$PIN_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
                    error "Invalid version format: $2 (expected: X.Y.Z)"
                fi
                shift 2 ;;
            --container|container) mode="container"; shift ;;
            --native|native) mode="native"; shift ;;
            *) args+=("$1"); shift ;;
        esac
    done

    # Check dependencies
    command -v curl >/dev/null || error "curl is required"
    command -v tar >/dev/null || error "tar is required"

    # Get versions
    CURRENT_VERSION=$(get_installed_version)
    if [ -n "$PIN_VERSION" ]; then
        VERSION="$PIN_VERSION"
        info "Target version: v${VERSION}"
    else
        VERSION=$(get_latest_version)
        [ -z "$VERSION" ] && error "Failed to get latest version"
    fi

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

    # --update mode: load saved config
    if [[ "$UPDATE_MODE" == true ]]; then
        load_config
        mode="${TERMOTE_MODE:-native}"
        [[ "$TERMOTE_LAN" == true ]] && args+=("--lan")
        [[ "$TERMOTE_NO_AUTH" == true ]] && args+=("--no-auth")
        [[ -n "$TERMOTE_PORT" && "$TERMOTE_PORT" != "7680" ]] && args+=("--port" "$TERMOTE_PORT")
        [[ -n "$TERMOTE_TAILSCALE" ]] && args+=("--tailscale" "$TERMOTE_TAILSCALE")
        info "Using saved config: mode=$mode ${args[*]}"
    fi

    # Default to native if no mode specified
    [[ -z "$mode" ]] && mode="native"

    ./scripts/termote.sh install "$mode" "${args[@]}"
}

main "$@"
