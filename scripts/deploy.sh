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
OS="$(uname)"

# Detect container runtime (podman or docker)
detect_container_runtime() {
    if command -v podman &>/dev/null; then
        echo "podman"
    elif command -v docker &>/dev/null; then
        echo "docker"
    else
        echo >&2 "Error: Neither podman nor docker found."
        exit 1
    fi
}

# Start native ttyd with version-appropriate flags
start_ttyd() {
    echo "  Starting native ttyd..."
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
    echo "  Starting tmux-api in serve mode..."
    TERMOTE_SERVE=true \
    TERMOTE_PORT="$PORT" \
    TERMOTE_BIND="$BIND_ADDR" \
    TERMOTE_PWA_DIR="$PROJECT_DIR/pwa/dist" \
    TERMOTE_USER="admin" \
    TERMOTE_PASS="${SERVE_PASS:-}" \
    TERMOTE_NO_AUTH="${NO_AUTH}" \
    nohup "$binary" --serve > /dev/null 2>&1 &
}

# Show generated credentials
show_credentials() {
    local pass="$1"
    echo ""
    echo "============================================"
    echo "  TERMOTE CREDENTIALS (auto-generated)"
    echo "  Username: admin"
    echo "  Password: $pass"
    echo "============================================"
}

# Stop native ttyd and tmux-api processes
stop_native_services() {
    pkill -f "ttyd" 2>/dev/null || true
    pkill -f "tmux-api" 2>/dev/null || true
    sleep 0.5
}

# Prepare native serve mode (shared by hybrid-macOS and native-macOS)
prepare_native_serve() {
    command -v tmux &>/dev/null || { echo >&2 "Error: tmux is required. Install with: brew install tmux"; exit 1; }
    command -v ttyd &>/dev/null || { echo >&2 "Error: ttyd is required. Install with: brew install ttyd"; exit 1; }

    stop_native_services
    tmux has-session -t main 2>/dev/null || tmux new-session -d -s main
    start_ttyd

    # Build native tmux-api
    echo "  Building native tmux-api..."
    (cd "$PROJECT_DIR/tmux-api" && CGO_ENABLED=0 go build -ldflags="-s -w" -o tmux-api-native .)

    # Generate password if needed
    if [[ "$NO_AUTH" != true ]]; then
        SERVE_PASS=$(openssl rand -base64 16 | tr -dc 'a-zA-Z0-9' | head -c 12)
    fi

    start_serve_mode "$PROJECT_DIR/tmux-api/tmux-api-native"
}

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
    LAN_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
    # macOS fallback: hostname -I not available
    [[ -z "$LAN_IP" ]] && LAN_IP=$(ipconfig getifaddr en0 2>/dev/null || echo "0.0.0.0")
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
    echo "  --native   All native (systemd on Linux, tmux-api --serve on macOS)"
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

echo "[2/3] Checking auth..."
if [[ "$NO_AUTH" == true ]]; then
    echo "  Basic auth disabled (--no-auth)"
    # Create empty .htpasswd to satisfy COPY in Dockerfile
    touch "$PROJECT_DIR/.htpasswd"
else
    if [ ! -f "$PROJECT_DIR/.htpasswd" ]; then
        if [[ -t 0 ]]; then
            # Interactive mode - prompt for password
            echo "Creating .htpasswd (enter password):"
            echo "admin:$(openssl passwd -apr1)" > "$PROJECT_DIR/.htpasswd"
        elif [[ "$MODE" == "native" ]]; then
            # Native mode - generate credentials directly (no Docker container)
            GENERATED_PASS=$(openssl rand -base64 16 | tr -dc 'a-zA-Z0-9' | head -c 12)
            echo "admin:$(openssl passwd -apr1 "$GENERATED_PASS")" > "$PROJECT_DIR/.htpasswd"
        else
            # Docker/Hybrid mode - use placeholder for container to generate credentials
            echo "  Auth will be auto-generated on container start..."
            echo "placeholder" > "$PROJECT_DIR/.htpasswd"
        fi
    fi
fi

# Detect container runtime (not required for native macOS — no container needed)
if [[ "$MODE" == "native" && "$OS" == "Darwin" ]]; then
    CONTAINER_RT=""
else
    CONTAINER_RT=$(detect_container_runtime)
    echo "  Using container runtime: $CONTAINER_RT"
fi

# Cross-compile tmux-api for Linux if building container modes on non-Linux (macOS)
# Skip for hybrid+podman+macOS since it runs natively (no container)
if [[ "$MODE" != "native" && "$OS" != "Linux" ]]; then
    if [[ "$MODE" == "hybrid" && "$CONTAINER_RT" == "podman" && "$OS" == "Darwin" ]]; then
        : # Skip cross-compile — will build native binary later
    else
        echo "[2.5/3] Cross-compiling tmux-api for linux..."
        GOARCH=$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/;s/arm64/arm64/')
        (cd "$PROJECT_DIR/tmux-api" && CGO_ENABLED=0 GOOS=linux GOARCH="$GOARCH" go build -ldflags="-s -w" -o tmux-api .)
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
        $CONTAINER_RT compose down 2>/dev/null || true

        # Create override with port binding
        cat > "$PROJECT_DIR/docker-compose.override.yml" << EOF
services:
  termote:
    ports:
      - "${BIND_ADDR}:${PORT}:7680"
EOF
        $CONTAINER_RT compose --profile docker up -d --build
        rm -f "$PROJECT_DIR/docker-compose.override.yml"

        # Setup Tailscale serve if requested
        if [[ -n "$TAILSCALE" ]]; then
            echo "  Setting up Tailscale serve..."
            command -v tailscale &>/dev/null && sudo tailscale serve --bg --https="$TS_PORT" http://127.0.0.1:"$PORT"
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
        # Show credentials hint for non-interactive Docker installs
        if [[ "$NO_AUTH" != true ]] && grep -q 'placeholder' "$PROJECT_DIR/.htpasswd" 2>/dev/null; then
            echo ""
            echo "View auto-generated credentials:"
            echo "  $CONTAINER_RT logs termote 2>&1 | grep -A3 'TERMOTE CREDENTIALS'"
        fi
        ;;

    hybrid)
        # Detect podman+macOS: use fully native serve mode (no container)
        PODMAN_MACOS=false
        if [[ "$CONTAINER_RT" == "podman" && "$OS" == "Darwin" ]]; then
            PODMAN_MACOS=true
            echo "  Podman on macOS: using native serve mode (no container)"
        fi

        if [[ "$PODMAN_MACOS" == true ]]; then
            # === Native serve mode: tmux-api --serve (no container needed) ===
            prepare_native_serve
        else
            # === Container mode: nginx + tmux-api in container ===
            command -v tmux &>/dev/null || { echo >&2 "Error: tmux is required for hybrid mode. Install with: brew install tmux (macOS) or apt install tmux (Linux)"; exit 1; }
            command -v ttyd &>/dev/null || { echo >&2 "Error: ttyd is required for hybrid mode. Install with: brew install ttyd (macOS) or snap install ttyd (Linux)"; exit 1; }

            # Stop existing services
            $CONTAINER_RT compose down 2>/dev/null || true
            if command -v systemctl &>/dev/null; then
                systemctl is-active "termote@$(whoami)" &>/dev/null && sudo systemctl stop "termote@$(whoami)" 2>/dev/null || true
                if systemctl is-active ttyd &>/dev/null; then
                    echo "  Stopping system ttyd.service..."
                    sudo systemctl stop ttyd 2>/dev/null || true
                fi
            fi
            stop_native_services
            tmux has-session -t main 2>/dev/null || tmux new-session -d -s main
            start_ttyd

            # Set tmux socket dir based on OS
            if [[ "$OS" == "Darwin" ]]; then
                export TMUX_SOCKET_DIR="/private/tmp/tmux-$USER_ID"
            else
                export TMUX_SOCKET_DIR="/tmp/tmux-$USER_ID"
            fi
            mkdir -p "$TMUX_SOCKET_DIR" && chmod 700 "$TMUX_SOCKET_DIR"

            # Resolve host gateway for podman
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

        # Setup Tailscale serve if requested
        if [[ -n "$TAILSCALE" ]]; then
            echo "  Setting up Tailscale serve..."
            command -v tailscale &>/dev/null && sudo tailscale serve --bg --https="$TS_PORT" http://127.0.0.1:"$PORT"
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
        # Show credentials
        if [[ "$NO_AUTH" != true ]]; then
            if [[ -n "$SERVE_PASS" ]]; then
                show_credentials "$SERVE_PASS"
            elif grep -q 'placeholder' "$PROJECT_DIR/.htpasswd" 2>/dev/null; then
                echo ""
                echo "View auto-generated credentials:"
                echo "  $CONTAINER_RT logs termote-hybrid 2>&1 | grep -A3 'TERMOTE CREDENTIALS'"
            fi
        fi
        ;;

    native)
        # All native — auto-detect OS
        if [[ "$OS" == "Darwin" ]]; then
            # === macOS: tmux-api --serve + native ttyd (no container, no systemd) ===
            echo "  macOS detected: using native serve mode"
            prepare_native_serve
        else
            # === Linux: systemd + nginx (original native flow) ===
            command -v systemctl &>/dev/null || { echo >&2 "Error: Native mode on Linux requires systemd"; exit 1; }

            # Stop container services (best-effort, container runtime may not exist)
            if [[ -n "$CONTAINER_RT" ]]; then
                $CONTAINER_RT compose down 2>/dev/null || true
            fi

            # Install nginx config
            NGINX_CONF="/etc/nginx/sites-available/termote"
            echo "  Installing nginx config..."
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
            sudo systemctl enable "termote@$(whoami)" 2>/dev/null || true
            sudo systemctl restart "termote@$(whoami)"
            sudo systemctl enable "tmux-api@$(whoami)" 2>/dev/null || true
            sudo systemctl restart "tmux-api@$(whoami)"
            sudo nginx -t && sudo systemctl reload nginx
        fi

        # Setup Tailscale serve if requested
        if [[ -n "$TAILSCALE" ]]; then
            echo "  Setting up Tailscale serve..."
            command -v tailscale &>/dev/null && sudo tailscale serve --bg --https="$TS_PORT" http://127.0.0.1:"$PORT"
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
        # Show generated credentials
        if [[ "$NO_AUTH" != true ]]; then
            if [[ -n "$SERVE_PASS" ]]; then
                show_credentials "$SERVE_PASS"
            elif [[ -n "$GENERATED_PASS" ]]; then
                show_credentials "$GENERATED_PASS"
            fi
        fi
        ;;
esac
