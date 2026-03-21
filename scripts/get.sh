#!/bin/bash
# Termote online installer
# Usage: curl -fsSL https://raw.githubusercontent.com/lamngockhuong/termote/main/scripts/get.sh | bash
# Or: curl ... | bash -s -- --docker --lan

set -e

REPO="lamngockhuong/termote"
INSTALL_DIR="${TERMOTE_INSTALL_DIR:-$HOME/.termote}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info() { echo -e "${GREEN}[INFO]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

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
    echo ""

    # Check dependencies
    command -v curl >/dev/null || error "curl is required"
    command -v tar >/dev/null || error "tar is required"

    # Get latest version
    VERSION=$(get_latest_version)
    [ -z "$VERSION" ] && error "Failed to get latest version"
    info "Latest version: v${VERSION}"

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

    # Run install script with forwarded arguments
    info "Running installer..."
    chmod +x scripts/install.sh
    ./scripts/install.sh "$@"
}

main "$@"
