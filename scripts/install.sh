#!/bin/bash
# Termote installer - supports both release and development mode
# Usage:
#   ./install.sh --docker                  # Docker mode
#   ./install.sh --hybrid                  # Hybrid mode
#   ./install.sh --native                  # Native mode
#   ./install.sh --docker --lan            # Docker with LAN access
#   ./install.sh --docker --tailscale host # Docker with Tailscale

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
OS="$(uname)"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info() { echo -e "${GREEN}[INFO]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# Detect container runtime (podman or docker)
detect_container_runtime() {
    if command -v podman &>/dev/null; then
        echo "podman"
    elif command -v docker &>/dev/null; then
        echo "docker"
    else
        error "Neither podman nor docker found. Please install one of them."
    fi
}

# Detect architecture
get_arch() {
    case "$(uname -m)" in
        x86_64|amd64) echo "amd64" ;;
        aarch64|arm64) echo "arm64" ;;
        *)
            warn "Unknown architecture $(uname -m), falling back to amd64"
            echo "amd64"
            ;;
    esac
}

# Start native ttyd with version-appropriate flags
start_ttyd() {
    local ttyd_ver
    ttyd_ver=$(ttyd --version 2>&1 | grep -oE '[0-9]+\.[0-9]+' | head -1)
    if [[ "$(printf '%s\n' "1.7" "$ttyd_ver" | sort -V | head -1)" == "1.7" ]]; then
        nohup ttyd -W -p 7681 tmux new-session -A -s main > /dev/null 2>&1 &
    else
        nohup ttyd -p 7681 tmux new-session -A -s main > /dev/null 2>&1 &
    fi
    sleep 1
}

# Start tmux-api in serve mode (replaces nginx on macOS)
start_serve_mode() {
    local binary="$1"
    info "Starting tmux-api in serve mode..."
    TERMOTE_SERVE=true \
    TERMOTE_PORT="$PORT" \
    TERMOTE_BIND="$BIND_ADDR" \
    TERMOTE_PWA_DIR="$PWA_DIST" \
    TERMOTE_USER="admin" \
    TERMOTE_PASS="${SERVE_PASS:-}" \
    TERMOTE_NO_AUTH="${NO_AUTH}" \
    nohup "$binary" --serve > /dev/null 2>&1 &
}

# Stop native ttyd and tmux-api processes
stop_native_services() {
    pkill -f "ttyd" 2>/dev/null || true
    pkill -f "tmux-api" 2>/dev/null || true
    sleep 0.5
}

# Resolve serve binary path
find_serve_binary() {
    if [[ -f "$PROJECT_DIR/tmux-api/tmux-api-native" ]]; then
        echo "$PROJECT_DIR/tmux-api/tmux-api-native"
    elif [[ -f "$PROJECT_DIR/tmux-api/tmux-api" ]]; then
        echo "$PROJECT_DIR/tmux-api/tmux-api"
    else
        error "tmux-api binary not found. Build with: cd tmux-api && go build -o tmux-api ."
    fi
}

# Prepare and start native serve mode (shared by hybrid-macOS and native-macOS)
prepare_native_serve() {
    command -v tmux &>/dev/null || error "tmux is required. Install with: brew install tmux"
    command -v ttyd &>/dev/null || error "ttyd is required. Install with: brew install ttyd"

    stop_native_services
    tmux has-session -t main 2>/dev/null || tmux new-session -d -s main
    start_ttyd

    local binary
    binary=$(find_serve_binary)

    # Generate password if needed
    if [[ "$NO_AUTH" != true ]]; then
        SERVE_PASS=$(openssl rand -base64 16 | tr -dc 'a-zA-Z0-9' | head -c 12)
    fi

    start_serve_mode "$binary"
}

# Show generated credentials banner
show_credentials() {
    local pass="$1"
    echo ""
    echo "============================================"
    echo "  TERMOTE CREDENTIALS (auto-generated)"
    echo "  Username: admin"
    echo "  Password: $pass"
    echo "============================================"
}

# Check if running from release tarball (pwa-dist exists at project root)
if [[ -d "$PROJECT_DIR/pwa-dist" ]]; then
    RELEASE_MODE=true
    PWA_DIST="$PROJECT_DIR/pwa-dist"
    info "Release mode detected (using pre-built artifacts)"
else
    RELEASE_MODE=false
    PWA_DIST="$PROJECT_DIR/pwa/dist"
    info "Development mode (building from source)"
fi

# Show usage
show_usage() {
    echo "Usage: ./install.sh [--docker|--hybrid|--native] [options]"
    echo ""
    echo "Modes:"
    echo "  --docker   All-in-one container (nginx+ttyd+tmux-api)"
    echo "  --hybrid   Docker (nginx+tmux-api) + native ttyd [default]"
    echo "  --native   All native (systemd on Linux, tmux-api --serve on macOS)"
    echo ""
    echo "Options:"
    echo "  --port <port>              Host port (default: 7680)"
    echo "  --tailscale <host[:port]>  Enable Tailscale HTTPS"
    echo "  --lan                      Expose to LAN (default: localhost only)"
    echo "  --no-auth                  Disable basic authentication"
    echo "  -h, --help                 Show this help message"
    exit 0
}

# Parse arguments
MODE=""
TAILSCALE=""
LAN=false
NO_AUTH=false
PORT=""

args=("$@")
for i in "${!args[@]}"; do
    arg="${args[$i]}"
    case $arg in
        -h|--help) show_usage ;;
        --docker) MODE="docker" ;;
        --hybrid) MODE="hybrid" ;;
        --native) MODE="native" ;;
        --tailscale) TAILSCALE="${args[$((i+1))]}" ;;
        --lan) LAN=true ;;
        --port) PORT="${args[$((i+1))]}" ;;
        --no-auth) NO_AUTH=true ;;
    esac
done

# Default port
PORT="${PORT:-7680}"

# Interactive mode selection if no mode provided
if [[ -z "$MODE" ]]; then
    echo ""
    echo "Select installation mode:"
    echo ""
    echo "  1) docker  - All-in-one container (nginx+ttyd+tmux-api)"
    echo "               Best for: Simple deployment, isolated environment"
    echo ""
    echo "  2) hybrid  - Docker (nginx+tmux-api) + native ttyd"
    echo "               Best for: Access host binaries (claude, gh, etc.)"
    echo ""
    echo "  3) native  - All native (systemd on Linux, serve on macOS)"
    echo "               Best for: No Docker, full system integration"
    echo ""

    # Check if stdin is a terminal
    if [[ -t 0 ]]; then
        read -p "Enter choice [1-3, default=2]: " choice
    else
        # Piped input - default to hybrid (most common use case)
        echo "Non-interactive mode detected, defaulting to hybrid..."
        choice="2"
    fi

    case "${choice:-2}" in
        1|docker)  MODE="docker" ;;
        2|hybrid)  MODE="hybrid" ;;
        3|native)  MODE="native" ;;
        *)
            error "Invalid choice: $choice"
            ;;
    esac

    info "Selected mode: $MODE"
fi

# Determine bind address
if [[ "$LAN" == true ]]; then
    BIND_ADDR="0.0.0.0"
    LAN_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
    # macOS fallback: hostname -I not available
    [[ -z "$LAN_IP" ]] && LAN_IP=$(ipconfig getifaddr en0 2>/dev/null || echo "0.0.0.0")
else
    BIND_ADDR="127.0.0.1"
fi

# Parse Tailscale hostname:port
if [[ -n "$TAILSCALE" ]]; then
    if [[ "$TAILSCALE" == *":"* ]]; then
        TS_HOST="${TAILSCALE%%:*}"
        TS_PORT="${TAILSCALE##*:}"
    else
        TS_HOST="$TAILSCALE"
        TS_PORT="443"
    fi
fi

echo ""
echo "=== Termote Installation ($MODE) ==="
echo ""

# Setup PWA
setup_pwa() {
    if [[ "$RELEASE_MODE" == true ]]; then
        info "Using pre-built PWA..."
        # For Docker, copy to expected location
        if [[ ! -d "$PROJECT_DIR/pwa/dist" ]]; then
            mkdir -p "$PROJECT_DIR/pwa/dist"
            cp -r "$PWA_DIST/"* "$PROJECT_DIR/pwa/dist/"
        fi
    else
        info "Building PWA..."
        cd "$PROJECT_DIR/pwa"
        pnpm install --frozen-lockfile
        pnpm build
        cd "$PROJECT_DIR"
    fi
}

# Setup tmux-api
setup_api() {
    local arch
    arch=$(get_arch)
    local binary_path="$PROJECT_DIR/tmux-api-linux-$arch"

    if [[ "$RELEASE_MODE" == true ]] && [[ -f "$binary_path" ]]; then
        info "Using pre-built tmux-api ($arch)..."
        mkdir -p "$PROJECT_DIR/tmux-api"
        cp "$binary_path" "$PROJECT_DIR/tmux-api/tmux-api"
        chmod +x "$PROJECT_DIR/tmux-api/tmux-api"
    else
        # Cross-compile for Linux when building on macOS for container modes
        # Skip for hybrid+podman+macOS and native+macOS (they run natively)
        local needs_cross=false
        if [[ "$MODE" != "native" && "$OS" != "Linux" ]]; then
            if [[ "$MODE" == "hybrid" && "$CONTAINER_RT" == "podman" && "$OS" == "Darwin" ]]; then
                : # Skip cross-compile — will build native binary below
            else
                needs_cross=true
            fi
        fi

        if [[ "$needs_cross" == true ]]; then
            local goarch
            goarch=$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/;s/arm64/arm64/')
            info "Cross-compiling tmux-api (linux/$goarch)..."
            cd "$PROJECT_DIR/tmux-api"
            CGO_ENABLED=0 GOOS=linux GOARCH="$goarch" go build -ldflags="-s -w" -o tmux-api .
        else
            info "Building tmux-api..."
            cd "$PROJECT_DIR/tmux-api"
            CGO_ENABLED=0 go build -ldflags="-s -w" -o tmux-api .
        fi
        cd "$PROJECT_DIR"
    fi

    # macOS native/hybrid: also build native macOS binary for host tmux-api
    if [[ "$OS" == "Darwin" ]] && { [[ "$MODE" == "native" ]] || { [[ "$MODE" == "hybrid" ]] && [[ "$CONTAINER_RT" == "podman" ]]; }; }; then
        if [[ "$RELEASE_MODE" != true ]]; then
            info "Building native tmux-api for host..."
            cd "$PROJECT_DIR/tmux-api"
            CGO_ENABLED=0 go build -ldflags="-s -w" -o tmux-api-native .
            cd "$PROJECT_DIR"
        else
            warn "Podman+macOS hybrid in release mode requires Go to build native tmux-api"
            warn "Install Go (brew install go) or use docker mode instead"
        fi
    fi
}

setup_auth() {
    if [[ "$NO_AUTH" == true ]]; then
        info "Basic auth disabled"
        touch "$PROJECT_DIR/.htpasswd"
    elif [[ ! -f "$PROJECT_DIR/.htpasswd" ]]; then
        if [[ -t 0 ]]; then
            # Interactive mode - prompt for password
            info "Creating .htpasswd (enter password):"
            echo "admin:$(openssl passwd -apr1)" > "$PROJECT_DIR/.htpasswd"
        elif [[ "$MODE" == "native" ]]; then
            # Native mode - generate credentials directly (no Docker container)
            local pass
            pass=$(openssl rand -base64 16 | tr -dc 'a-zA-Z0-9' | head -c 12)
            echo "admin:$(openssl passwd -apr1 "$pass")" > "$PROJECT_DIR/.htpasswd"
            GENERATED_PASS="$pass"
        else
            # Docker/Hybrid mode - use placeholder for container to generate credentials
            info "Auth will be auto-generated on container start..."
            echo "placeholder" > "$PROJECT_DIR/.htpasswd"
        fi
    fi
}

# Detect container runtime (not required for native macOS — no container needed)
if [[ "$MODE" == "native" && "$OS" == "Darwin" ]]; then
    CONTAINER_RT=""
elif [[ "$MODE" != "native" ]]; then
    CONTAINER_RT=$(detect_container_runtime)
    info "Using container runtime: $CONTAINER_RT"
fi

# Export for docker-compose
export USER_ID=$(id -u)
export GROUP_ID=$(id -g)
export NO_AUTH

# Build steps
info "[1/4] Setting up PWA..."
setup_pwa

info "[2/4] Setting up tmux-api..."
setup_api

info "[3/4] Setting up authentication..."
setup_auth

info "[4/4] Starting services..."

case $MODE in
    docker)
        $CONTAINER_RT compose down 2>/dev/null || true

        cat > "$PROJECT_DIR/docker-compose.override.yml" << EOF
services:
  termote:
    ports:
      - "${BIND_ADDR}:${PORT}:7680"
EOF
        $CONTAINER_RT compose --profile docker up -d --build
        rm -f "$PROJECT_DIR/docker-compose.override.yml"
        ;;

    hybrid)
        # Detect podman+macOS: use fully native serve mode (no container)
        PODMAN_MACOS=false
        if [[ "$CONTAINER_RT" == "podman" && "$OS" == "Darwin" ]]; then
            PODMAN_MACOS=true
            info "Podman on macOS: using native serve mode (no container)"
        fi

        if [[ "$PODMAN_MACOS" == true ]]; then
            # === Native serve mode: tmux-api --serve (no container needed) ===
            prepare_native_serve
        else
            # === Container mode: nginx + tmux-api in container ===
            command -v tmux &>/dev/null || error "tmux is required for hybrid mode. Install with: brew install tmux (macOS) or apt install tmux (Linux)"
            command -v ttyd &>/dev/null || error "ttyd is required for hybrid mode. Install with: brew install ttyd (macOS) or snap install ttyd (Linux)"

            # Stop existing services
            $CONTAINER_RT compose down 2>/dev/null || true
            if command -v systemctl &>/dev/null; then
                systemctl is-active "termote@$(whoami)" &>/dev/null && sudo systemctl stop "termote@$(whoami)" 2>/dev/null || true
                systemctl is-active ttyd &>/dev/null && sudo systemctl stop ttyd 2>/dev/null || true
            fi
            stop_native_services
            tmux has-session -t main 2>/dev/null || tmux new-session -d -s main
            start_ttyd

            if [[ "$OS" == "Darwin" ]]; then
                export TMUX_SOCKET_DIR="/private/tmp/tmux-$USER_ID"
            else
                export TMUX_SOCKET_DIR="/tmp/tmux-$USER_ID"
            fi
            mkdir -p "$TMUX_SOCKET_DIR" && chmod 700 "$TMUX_SOCKET_DIR"

            if [[ "$CONTAINER_RT" == "podman" ]]; then
                export HOST_GATEWAY=$(podman network inspect podman 2>/dev/null | grep '"gateway"' | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' || echo "10.0.2.2")
            fi

            cat > "$PROJECT_DIR/docker-compose.override.yml" << EOF
services:
  termote-hybrid:
    ports:
      - "${BIND_ADDR}:${PORT}:7680"
EOF
            $CONTAINER_RT compose --profile hybrid up -d --build
            rm -f "$PROJECT_DIR/docker-compose.override.yml"
        fi
        ;;

    native)
        if [[ "$OS" == "Darwin" ]]; then
            # === macOS: tmux-api --serve + native ttyd (no container, no systemd) ===
            info "macOS detected: using native serve mode"
            prepare_native_serve
        else
            # === Linux: systemd + nginx (original native flow) ===
            command -v systemctl &>/dev/null || error "Native mode on Linux requires systemd"

            # Stop containers if runtime available
            if command -v podman &>/dev/null; then
                podman compose down 2>/dev/null || true
            elif command -v docker &>/dev/null; then
                docker compose down 2>/dev/null || true
            fi

            # Install nginx config
            NGINX_CONF="/etc/nginx/sites-available/termote"
            if [[ "$NO_AUTH" == true ]]; then
                sed -e "s/<bind_addr>/$BIND_ADDR/g" \
                    -e '/auth_basic/d' \
                    "$PROJECT_DIR/nginx/nginx-local.conf" | sudo tee "$NGINX_CONF" > /dev/null
            else
                sed -e "s/<bind_addr>/$BIND_ADDR/g" \
                    "$PROJECT_DIR/nginx/nginx-local.conf" | sudo tee "$NGINX_CONF" > /dev/null
            fi
            sudo ln -sf "$NGINX_CONF" /etc/nginx/sites-enabled/termote

            # Deploy files
            sudo mkdir -p /var/www/termote
            sudo cp -r "$PWA_DIST/"* /var/www/termote/
            if [[ "$NO_AUTH" != true ]] && [ ! -f "/etc/nginx/.htpasswd" ]; then
                sudo cp "$PROJECT_DIR/.htpasswd" /etc/nginx/.htpasswd
            fi

            # Install tmux-api
            sudo cp "$PROJECT_DIR/tmux-api/tmux-api" /usr/local/bin/tmux-api
            sudo chmod +x /usr/local/bin/tmux-api

            # Install systemd services
            NEED_RELOAD=false
            if [ ! -f "/etc/systemd/system/termote@.service" ]; then
                sudo cp "$PROJECT_DIR/systemd/termote.service" "/etc/systemd/system/termote@.service"
                NEED_RELOAD=true
            fi
            if [ ! -f "/etc/systemd/system/tmux-api@.service" ]; then
                sudo cp "$PROJECT_DIR/systemd/tmux-api.service" "/etc/systemd/system/tmux-api@.service"
                NEED_RELOAD=true
            fi
            [[ "$NEED_RELOAD" == true ]] && sudo systemctl daemon-reload

            # Start services
            sudo systemctl enable "termote@$(whoami)" 2>/dev/null || true
            sudo systemctl restart "termote@$(whoami)"
            sudo systemctl enable "tmux-api@$(whoami)" 2>/dev/null || true
            sudo systemctl restart "tmux-api@$(whoami)"
            sudo nginx -t && sudo systemctl reload nginx
        fi
        ;;
esac

# Setup Tailscale if requested
if [[ -n "$TAILSCALE" ]]; then
    info "Setting up Tailscale serve..."
    command -v tailscale &>/dev/null && sudo tailscale serve --bg --https="$TS_PORT" http://127.0.0.1:"$PORT"
fi

echo ""
echo "=== Installation complete ==="
echo "Installed to: $PROJECT_DIR"
if [[ -n "$TAILSCALE" ]]; then
    echo "Tailscale: https://$TS_HOST:$TS_PORT"
fi
if [[ "$LAN" == true ]]; then
    echo "LAN: http://$LAN_IP:$PORT"
elif [[ -z "$TAILSCALE" ]]; then
    echo "Access at: http://localhost:$PORT"
fi

# Show credentials for non-interactive installs
if [[ "$NO_AUTH" != true ]]; then
    if [[ -n "$GENERATED_PASS" ]] || [[ -n "$SERVE_PASS" ]]; then
        show_credentials "${GENERATED_PASS:-$SERVE_PASS}"
    elif [[ "$MODE" != "native" ]] && grep -q 'placeholder' "$PROJECT_DIR/.htpasswd" 2>/dev/null; then
        # Docker/Hybrid container mode - show hint to view logs
        CONTAINER_NAME="termote"
        [[ "$MODE" == "hybrid" ]] && CONTAINER_NAME="termote-hybrid"
        echo ""
        echo "View auto-generated credentials:"
        echo "  $CONTAINER_RT logs $CONTAINER_NAME 2>&1 | grep -A3 'TERMOTE CREDENTIALS'"
    fi
fi
