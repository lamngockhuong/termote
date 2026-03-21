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

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info() { echo -e "${GREEN}[INFO]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

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
    echo "  --native   All native (requires system packages)"
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
    echo "  3) native  - All native (requires nginx, ttyd, systemd)"
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
    LAN_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "0.0.0.0")
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
    ARCH=$(get_arch)
    BINARY_PATH="$PROJECT_DIR/tmux-api-linux-$ARCH"

    if [[ "$RELEASE_MODE" == true ]] && [[ -f "$BINARY_PATH" ]]; then
        info "Using pre-built tmux-api ($ARCH)..."
        mkdir -p "$PROJECT_DIR/tmux-api"
        cp "$BINARY_PATH" "$PROJECT_DIR/tmux-api/tmux-api"
        chmod +x "$PROJECT_DIR/tmux-api/tmux-api"
    else
        info "Building tmux-api..."
        cd "$PROJECT_DIR/tmux-api"
        CGO_ENABLED=0 go build -ldflags="-s -w" -o tmux-api .
        cd "$PROJECT_DIR"
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
            local pass=$(openssl rand -base64 16 | tr -dc 'a-zA-Z0-9' | head -c 12)
            echo "admin:$(openssl passwd -apr1 "$pass")" > "$PROJECT_DIR/.htpasswd"
            GENERATED_PASS="$pass"
        else
            # Docker/Hybrid mode - use placeholder for container to generate credentials
            info "Auth will be auto-generated on container start..."
            echo "placeholder" > "$PROJECT_DIR/.htpasswd"
        fi
    fi
}

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
        docker compose down 2>/dev/null || true

        cat > "$PROJECT_DIR/docker-compose.override.yml" << EOF
services:
  termote:
    ports:
      - "${BIND_ADDR}:${PORT}:7680"
EOF
        docker compose --profile docker up -d --build
        rm -f "$PROJECT_DIR/docker-compose.override.yml"
        ;;

    hybrid)
        docker compose down 2>/dev/null || true

        # Stop existing ttyd
        if systemctl is-active "termote@$(whoami)" &>/dev/null; then
            sudo systemctl stop "termote@$(whoami)" 2>/dev/null || true
        fi
        if systemctl is-active ttyd &>/dev/null; then
            sudo systemctl stop ttyd 2>/dev/null || true
        fi
        pkill -f "ttyd" 2>/dev/null || true
        sleep 0.5

        # Start native ttyd
        TTYD_VERSION=$(ttyd --version 2>&1 | grep -oP '\d+\.\d+' | head -1)
        if [[ "$(printf '%s\n' "1.7" "$TTYD_VERSION" | sort -V | head -1)" == "1.7" ]]; then
            nohup ttyd -W -p 7681 tmux new-session -A -s main > /dev/null 2>&1 &
        else
            nohup ttyd -p 7681 tmux new-session -A -s main > /dev/null 2>&1 &
        fi
        sleep 1

        # Set tmux socket dir
        if [[ "$(uname)" == "Darwin" ]]; then
            export TMUX_SOCKET_DIR="/private/tmp/tmux-$(id -u)"
        else
            export TMUX_SOCKET_DIR="/tmp/tmux-$(id -u)"
        fi

        cat > "$PROJECT_DIR/docker-compose.override.yml" << EOF
services:
  termote-hybrid:
    ports:
      - "${BIND_ADDR}:${PORT}:7680"
EOF
        docker compose --profile hybrid up -d --build
        rm -f "$PROJECT_DIR/docker-compose.override.yml"
        ;;

    native)
        USER=$(whoami)
        docker compose down 2>/dev/null || true

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
        sudo systemctl enable "termote@$USER" 2>/dev/null || true
        sudo systemctl restart "termote@$USER"
        sudo systemctl enable "tmux-api@$USER" 2>/dev/null || true
        sudo systemctl restart "tmux-api@$USER"
        sudo nginx -t && sudo systemctl reload nginx
        ;;
esac

# Setup Tailscale if requested
if [[ -n "$TAILSCALE" ]]; then
    info "Setting up Tailscale serve..."
    command -v tailscale &>/dev/null && sudo tailscale serve --bg --https=$TS_PORT http://127.0.0.1:$PORT
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
    if [[ -n "$GENERATED_PASS" ]]; then
        # Native mode - show generated credentials directly
        echo ""
        echo "============================================"
        echo "  TERMOTE CREDENTIALS (auto-generated)"
        echo "  Username: admin"
        echo "  Password: $GENERATED_PASS"
        echo "============================================"
    elif [[ "$MODE" != "native" ]] && grep -q 'placeholder' "$PROJECT_DIR/.htpasswd" 2>/dev/null; then
        # Docker/Hybrid mode - show hint to view logs
        CONTAINER_NAME="termote"
        [[ "$MODE" == "hybrid" ]] && CONTAINER_NAME="termote-hybrid"
        echo ""
        echo "View auto-generated credentials:"
        echo "  docker logs $CONTAINER_NAME 2>&1 | grep -A3 'TERMOTE CREDENTIALS'"
    fi
fi
