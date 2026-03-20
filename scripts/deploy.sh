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
    esac
done

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
    echo "  --tailscale <host[:port]>  Enable Tailscale HTTPS (default port: 8080)"
    echo "  --lan                      Expose to LAN (default: localhost only)"
    echo ""
    echo "Examples:"
    echo "  ./deploy.sh --docker                              # localhost only"
    echo "  ./deploy.sh --docker --lan                        # LAN accessible"
    echo "  ./deploy.sh --docker --tailscale myhost.ts.net    # Tailscale HTTPS"
    echo "  ./deploy.sh --hybrid --tailscale myhost.ts.net:443"
    echo "  ./deploy.sh --native"
    exit 1
fi

# Parse Tailscale hostname:port
if [[ -n "$TAILSCALE" ]]; then
    if [[ "$TAILSCALE" == *":"* ]]; then
        TS_HOST="${TAILSCALE%%:*}"
        TS_PORT="${TAILSCALE##*:}"
    else
        TS_HOST="$TAILSCALE"
        TS_PORT="8080"
    fi

    # Generate Tailscale certs (copy to project for Docker access)
    echo "Generating Tailscale certs for $TS_HOST..."
    CERT_DIR="$PROJECT_DIR/.certs"
    mkdir -p "$CERT_DIR"
    sudo tailscale cert --cert-file "$CERT_DIR/${TS_HOST}.crt" \
                        --key-file "$CERT_DIR/${TS_HOST}.key" \
                        "$TS_HOST" 2>/dev/null || true
    sudo chown $(id -u):$(id -g) "$CERT_DIR"/${TS_HOST}.*
    chmod 644 "$CERT_DIR"/${TS_HOST}.*
fi

echo "=== Termote Deployment ($MODE) ==="
echo ""

# Build PWA
echo "[1/3] Building PWA..."
cd "$PROJECT_DIR/pwa"
pnpm install --frozen-lockfile
pnpm build
cd "$PROJECT_DIR"

# Create .htpasswd if not exists
echo "[2/3] Checking auth..."
if [ ! -f "$PROJECT_DIR/.htpasswd" ]; then
    echo "Creating .htpasswd (enter password):"
    echo "admin:$(openssl passwd -apr1)" > "$PROJECT_DIR/.htpasswd"
fi

# Deploy based on mode
echo "[3/3] Starting services..."
export USER_ID=$(id -u)
export GROUP_ID=$(id -g)

case $MODE in
    docker)
        # All-in-one container
        docker compose down 2>/dev/null || true

        if [[ -n "$TAILSCALE" ]]; then
            # Generate nginx config with Tailscale (wrap in events/http for Docker)
            # Use 0.0.0.0 in container (container has no Tailscale interface)
            cat > "$PROJECT_DIR/nginx/nginx-docker.conf.tmp" << 'NGINX_HEADER'
events {
    worker_connections 1024;
}

http {
    include /etc/nginx/mime.types;
    default_type application/octet-stream;

    map $http_upgrade $connection_upgrade {
        default upgrade;
        '' close;
    }

NGINX_HEADER
            sed -e "s/<hostname>/$TS_HOST/g" \
                -e "s/<port>/$TS_PORT/g" \
                -e "s/<tailscale_ip>/0.0.0.0/g" \
                -e "s|/var/lib/tailscale/certs|/certs|g" \
                "$PROJECT_DIR/nginx/nginx-tailscale.conf" >> "$PROJECT_DIR/nginx/nginx-docker.conf.tmp"
            echo "}" >> "$PROJECT_DIR/nginx/nginx-docker.conf.tmp"

            # Create override with cert mounts and port binding
            cat > "$PROJECT_DIR/docker-compose.override.yml" << EOF
services:
  termote:
    ports:
      - "${BIND_ADDR}:${TS_PORT}:8080"
    volumes:
      - \${WORKSPACE:-./workspace}:/workspace:rw
      - ./nginx/nginx-docker.conf.tmp:/etc/nginx/nginx.conf:ro
      - ./.certs:/certs:ro
EOF
            docker compose --profile docker up -d --build
            rm -f "$PROJECT_DIR/docker-compose.override.yml"

            echo ""
            echo "=== Deployment complete ==="
            echo "Tailscale: https://$TS_HOST:$TS_PORT"
            if [[ "$LAN" == true ]]; then
                echo "LAN: http://$LAN_IP:${TS_PORT}"
            fi
        else
            # Create override with port binding (localhost by default)
            cat > "$PROJECT_DIR/docker-compose.override.yml" << EOF
services:
  termote:
    ports:
      - "${BIND_ADDR}:8080:8080"
EOF
            docker compose --profile docker up -d --build
            rm -f "$PROJECT_DIR/docker-compose.override.yml"

            echo ""
            echo "=== Deployment complete ==="
            if [[ "$LAN" == true ]]; then
                echo "LAN: http://$LAN_IP:8080"
            else
                echo "Access at: http://localhost:8080"
            fi
        fi
        ;;

    hybrid)
        # Single container (nginx + tmux-api), native ttyd
        docker compose down 2>/dev/null || true

        # Build tmux-api binary
        echo "  Building tmux-api..."
        cd "$PROJECT_DIR/tmux-api"
        CGO_ENABLED=0 go build -ldflags="-s -w" -o tmux-api . 2>/dev/null || true
        cd "$PROJECT_DIR"

        # Start native ttyd
        echo "  Starting native ttyd..."
        if systemctl is-active "termote@$(whoami)" &>/dev/null; then
            sudo systemctl restart "termote@$(whoami)"
        elif ! pgrep -f "ttyd.*tmux" > /dev/null; then
            # Check ttyd version for -W flag support (1.7.0+)
            TTYD_VERSION=$(ttyd --version 2>&1 | grep -oP '\d+\.\d+' | head -1)
            if [[ "$(printf '%s\n' "1.7" "$TTYD_VERSION" | sort -V | head -1)" == "1.7" ]]; then
                nohup ttyd -W -p 7681 tmux new-session -A -s main > /dev/null 2>&1 &
            else
                nohup ttyd -p 7681 tmux new-session -A -s main > /dev/null 2>&1 &
            fi
            sleep 1
        fi

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
      - "${BIND_ADDR}:8080:8080"
EOF

        if [[ -n "$TAILSCALE" ]]; then
            # Generate nginx config with Tailscale
            TS_IP=$(tailscale ip -4 2>/dev/null || echo "0.0.0.0")
            sed -e "s/<hostname>/$TS_HOST/g" \
                -e "s/<port>/$TS_PORT/g" \
                -e "s/<tailscale_ip>/$TS_IP/g" \
                "$PROJECT_DIR/nginx/nginx-tailscale.conf" > "$PROJECT_DIR/nginx/nginx-hybrid.conf"

            docker compose --profile hybrid up -d --build
            rm -f "$PROJECT_DIR/docker-compose.override.yml"

            echo ""
            echo "=== Deployment complete ==="
            echo "Tailscale: https://$TS_HOST:$TS_PORT"
            if [[ "$LAN" == true ]]; then
                echo "LAN: http://$LAN_IP:8080"
            fi
        else
            docker compose --profile hybrid up -d --build
            rm -f "$PROJECT_DIR/docker-compose.override.yml"

            echo ""
            echo "=== Deployment complete ==="
            if [[ "$LAN" == true ]]; then
                echo "LAN: http://$LAN_IP:8080"
            else
                echo "Access at: http://localhost:8080"
            fi
        fi
        ;;

    native)
        # All native
        USER=$(whoami)

        # Stop docker services
        docker compose down 2>/dev/null || true

        # Install nginx config
        NGINX_CONF="/etc/nginx/sites-available/termote"
        if [[ -n "$TAILSCALE" ]]; then
            # TS_HOST, TS_PORT, certs already set at top-level
            echo "  Installing Tailscale config for $TS_HOST:$TS_PORT..."
            TS_IP=$(tailscale ip -4 2>/dev/null || echo "127.0.0.1")

            sed -e "s/<hostname>/$TS_HOST/g" \
                -e "s/<port>/$TS_PORT/g" \
                -e "s/<tailscale_ip>/$TS_IP/g" \
                "$PROJECT_DIR/nginx/nginx-tailscale.conf" | sudo tee "$NGINX_CONF" > /dev/null
        else
            echo "  Installing local nginx config..."
            sed -e "s/<bind_addr>/$BIND_ADDR/g" \
                "$PROJECT_DIR/nginx/nginx-local.conf" | sudo tee "$NGINX_CONF" > /dev/null
        fi
        sudo ln -sf "$NGINX_CONF" /etc/nginx/sites-enabled/termote

        # Deploy files
        sudo mkdir -p /var/www/termote
        sudo cp -r "$PROJECT_DIR/pwa/dist/"* /var/www/termote/
        if [ ! -f "/etc/nginx/.htpasswd" ]; then
            sudo cp "$PROJECT_DIR/.htpasswd" /etc/nginx/.htpasswd
        fi

        # Build tmux-api binary
        echo "  Building tmux-api..."
        cd "$PROJECT_DIR/tmux-api"
        CGO_ENABLED=0 go build -ldflags="-s -w" -o tmux-api . 2>/dev/null || true
        cd "$PROJECT_DIR"
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

        echo ""
        echo "=== Deployment complete ==="
        if [[ -n "$TAILSCALE" ]]; then
            echo "Tailscale: https://$TS_HOST:$TS_PORT"
            if [[ "$LAN" == true ]]; then
                echo "LAN: http://$LAN_IP:8080"
            fi
        elif [[ "$LAN" == true ]]; then
            echo "LAN: http://$LAN_IP:8080"
        else
            echo "Access at: http://localhost:8080"
        fi
        ;;
esac
