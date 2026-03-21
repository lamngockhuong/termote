#!/bin/bash
# Deploy script for Termote
# Usage:
#   ./deploy.sh --docker                        # All-in-one container
#   ./deploy.sh --docker --tailscale <hostname> # Docker with Tailscale HTTPS
#   ./deploy.sh --hybrid                        # Docker nginx+api, native ttyd
#   ./deploy.sh --hybrid --tailscale <hostname> # Hybrid with Tailscale HTTPS
#   ./deploy.sh --native                        # All native
#   ./deploy.sh --native --tailscale <hostname> # Native with Tailscale HTTPS

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Parse arguments
MODE=""
TAILSCALE=""
LAN=false
NO_AUTH=false

args=("$@")
for i in "${!args[@]}"; do
    arg="${args[$i]}"
    case $arg in
        --docker)
            MODE="docker"
            ;;
        --hybrid)
            MODE="hybrid"
            ;;
        --native)
            MODE="native"
            ;;
        --tailscale)
            TAILSCALE="${args[$((i+1))]}"
            ;;
        --lan)
            LAN=true
            ;;
        --port)
            PORT="${args[$((i+1))]}"
            ;;
        --no-auth)
            NO_AUTH=true
            ;;
    esac
done

# Default port (internal)
PORT="${PORT:-7680}"

# Determine bind address (localhost by default, 0.0.0.0 with --lan)
if [[ "$LAN" == true ]]; then
    BIND_ADDR="0.0.0.0"
    LAN_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "0.0.0.0")
else
    BIND_ADDR="127.0.0.1"
fi

# Validate mode
if [[ -z "$MODE" ]]; then
    echo "Usage: ./deploy.sh <--docker|--hybrid|--native> [options]"
    echo ""
    echo "Modes:"
    echo "  --docker   All-in-one container (nginx+ttyd+tmux-api)"
    echo "  --hybrid   Docker (nginx+tmux-api) + native ttyd"
    echo "  --native   All native (requires system packages)"
    echo ""
    echo "Options:"
    echo "  --port <port>              Host port (default: 7680)"
    echo "  --tailscale <host[:port]>  Enable Tailscale HTTPS (default port: 443)"
    echo "  --lan                      Expose to LAN (default: localhost only)"
    echo "  --no-auth                  Disable basic authentication"
    echo ""
    echo "Examples:"
    echo "  ./deploy.sh --docker                              # localhost only"
    echo "  ./deploy.sh --docker --lan                        # LAN accessible"
    echo "  ./deploy.sh --docker --no-auth                    # No basic auth"
    echo "  ./deploy.sh --docker --tailscale myhost.ts.net    # Tailscale HTTPS on :443"
    echo "  ./deploy.sh --hybrid --tailscale myhost.ts.net:8765"
    echo "  ./deploy.sh --native"
    exit 1
fi

# Parse Tailscale hostname:port (separate from internal PORT)
if [[ -n "$TAILSCALE" ]]; then
    if [[ "$TAILSCALE" == *":"* ]]; then
        TS_HOST="${TAILSCALE%%:*}"
        TS_PORT="${TAILSCALE##*:}"
    else
        TS_HOST="$TAILSCALE"
        TS_PORT="443"
    fi
fi

echo "=== Termote Deployment ($MODE) ==="
echo ""

# Build PWA
echo "[1/3] Building PWA..."
cd "$PROJECT_DIR/pwa"
pnpm install --frozen-lockfile
pnpm build
cd "$PROJECT_DIR"

# Create .htpasswd if not exists (skip if --no-auth)
echo "[2/3] Checking auth..."
if [[ "$NO_AUTH" == true ]]; then
    echo "  Basic auth disabled (--no-auth)"
    # Create empty .htpasswd to satisfy COPY in Dockerfile
    touch "$PROJECT_DIR/.htpasswd"
else
    if [ ! -f "$PROJECT_DIR/.htpasswd" ]; then
        echo "Creating .htpasswd (enter password):"
        echo "admin:$(openssl passwd -apr1)" > "$PROJECT_DIR/.htpasswd"
    fi
fi

# Deploy based on mode
echo "[3/3] Starting services..."
export USER_ID=$(id -u)
export GROUP_ID=$(id -g)
export NO_AUTH

case $MODE in
    docker)
        # All-in-one container
        docker compose down 2>/dev/null || true

        # Create override with port binding
        cat > "$PROJECT_DIR/docker-compose.override.yml" << EOF
services:
  termote:
    ports:
      - "${BIND_ADDR}:${PORT}:7680"
EOF
        docker compose --profile docker up -d --build
        rm -f "$PROJECT_DIR/docker-compose.override.yml"

        # Setup Tailscale serve if requested
        if [[ -n "$TAILSCALE" ]]; then
            echo "  Setting up Tailscale serve..."
            command -v tailscale &>/dev/null && sudo tailscale serve --bg --https=$TS_PORT http://127.0.0.1:$PORT
        fi

        echo ""
        echo "=== Deployment complete ==="
        if [[ -n "$TAILSCALE" ]]; then
            echo "Tailscale: https://$TS_HOST:$TS_PORT"
        fi
        if [[ "$LAN" == true ]]; then
            echo "LAN: http://$LAN_IP:$PORT"
        elif [[ -z "$TAILSCALE" ]]; then
            echo "Access at: http://localhost:$PORT"
        fi
        ;;

    hybrid)
        # Single container (nginx + tmux-api), native ttyd
        docker compose down 2>/dev/null || true

        # Build tmux-api binary
        echo "  Building tmux-api..."
        (cd "$PROJECT_DIR/tmux-api" && CGO_ENABLED=0 go build -ldflags="-s -w" -o tmux-api .) 2>/dev/null || true

        # Start native ttyd (no -i flag for hybrid mode - container needs to reach host)
        echo "  Starting native ttyd..."
        # Stop systemd services if running (they bind to 127.0.0.1 which blocks container access)
        if systemctl is-active "termote@$(whoami)" &>/dev/null; then
            sudo systemctl stop "termote@$(whoami)" 2>/dev/null || true
        fi
        # Stop system ttyd.service if running (it may use different command like login)
        if systemctl is-active ttyd &>/dev/null; then
            echo "  Stopping system ttyd.service..."
            sudo systemctl stop ttyd 2>/dev/null || true
        fi
        # Kill any existing ttyd and start fresh without -i flag
        pkill -f "ttyd" 2>/dev/null || true
        sleep 0.5
        # Check ttyd version for -W flag support (1.7.0+)
        TTYD_VERSION=$(ttyd --version 2>&1 | grep -oP '\d+\.\d+' | head -1)
        if [[ "$(printf '%s\n' "1.7" "$TTYD_VERSION" | sort -V | head -1)" == "1.7" ]]; then
            nohup ttyd -W -p 7681 tmux new-session -A -s main > /dev/null 2>&1 &
        else
            nohup ttyd -p 7681 tmux new-session -A -s main > /dev/null 2>&1 &
        fi
        sleep 1

        # Set tmux socket dir based on OS
        if [[ "$(uname)" == "Darwin" ]]; then
            export TMUX_SOCKET_DIR="/private/tmp/tmux-$(id -u)"
        else
            export TMUX_SOCKET_DIR="/tmp/tmux-$(id -u)"
        fi

        # Create override with port binding
        cat > "$PROJECT_DIR/docker-compose.override.yml" << EOF
services:
  termote-hybrid:
    ports:
      - "${BIND_ADDR}:${PORT}:7680"
EOF
        docker compose --profile hybrid up -d --build
        rm -f "$PROJECT_DIR/docker-compose.override.yml"

        # Setup Tailscale serve if requested
        if [[ -n "$TAILSCALE" ]]; then
            echo "  Setting up Tailscale serve..."
            command -v tailscale &>/dev/null && sudo tailscale serve --bg --https=$TS_PORT http://127.0.0.1:$PORT
        fi

        echo ""
        echo "=== Deployment complete ==="
        if [[ -n "$TAILSCALE" ]]; then
            echo "Tailscale: https://$TS_HOST:$TS_PORT"
        fi
        if [[ "$LAN" == true ]]; then
            echo "LAN: http://$LAN_IP:$PORT"
        elif [[ -z "$TAILSCALE" ]]; then
            echo "Access at: http://localhost:$PORT"
        fi
        ;;

    native)
        # All native
        USER=$(whoami)

        # Stop docker services
        docker compose down 2>/dev/null || true

        # Install nginx config (always use local config, Tailscale serve handles HTTPS)
        NGINX_CONF="/etc/nginx/sites-available/termote"
        echo "  Installing nginx config..."
        if [[ "$NO_AUTH" == true ]]; then
            # Remove auth_basic lines
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
        sudo cp -r "$PROJECT_DIR/pwa/dist/"* /var/www/termote/
        if [[ "$NO_AUTH" != true ]] && [ ! -f "/etc/nginx/.htpasswd" ]; then
            sudo cp "$PROJECT_DIR/.htpasswd" /etc/nginx/.htpasswd
        fi

        # Build tmux-api binary
        echo "  Building tmux-api..."
        (cd "$PROJECT_DIR/tmux-api" && CGO_ENABLED=0 go build -ldflags="-s -w" -o tmux-api .) 2>/dev/null || true
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
        if [[ "$NEED_RELOAD" == true ]]; then
            sudo systemctl daemon-reload
        fi

        # Start services
        sudo systemctl enable "termote@$USER" 2>/dev/null || true
        sudo systemctl restart "termote@$USER"
        sudo systemctl enable "tmux-api@$USER" 2>/dev/null || true
        sudo systemctl restart "tmux-api@$USER"
        sudo nginx -t && sudo systemctl reload nginx

        # Setup Tailscale serve if requested
        if [[ -n "$TAILSCALE" ]]; then
            echo "  Setting up Tailscale serve..."
            command -v tailscale &>/dev/null && sudo tailscale serve --bg --https=$TS_PORT http://127.0.0.1:$PORT
        fi

        echo ""
        echo "=== Deployment complete ==="
        if [[ -n "$TAILSCALE" ]]; then
            echo "Tailscale: https://$TS_HOST:$TS_PORT"
        fi
        if [[ "$LAN" == true ]]; then
            echo "LAN: http://$LAN_IP:$PORT"
        elif [[ -z "$TAILSCALE" ]]; then
            echo "Access at: http://localhost:$PORT"
        fi
        ;;
esac
