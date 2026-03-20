#!/bin/bash
# Deploy script for Termote
# Usage:
#   ./deploy.sh --docker                        # All in docker
#   ./deploy.sh --native                        # Native local (no SSL)
#   ./deploy.sh --native --production           # Native production (SSL)
#   ./deploy.sh --native --tailscale <hostname> # Native with Tailscale HTTPS
#   ./deploy.sh --hybrid [options]              # Mix docker + native
#
# Options:
#   --production            Use production nginx (SSL, domain required)
#   --tailscale <hostname>  Use Tailscale HTTPS (auto SSL certs)
#   --nginx=docker|native   (default: docker for hybrid)
#   --ttyd=docker|native    (default: native for hybrid)
#   --api=docker|native     (default: native for hybrid)
#
# Example:
#   ./deploy.sh --native
#   ./deploy.sh --native --tailscale myhost

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Parse arguments
MODE=""
NGINX_MODE=""
TTYD_MODE=""
API_MODE=""
PRODUCTION=false
TAILSCALE=""

args=("$@")
for i in "${!args[@]}"; do
    arg="${args[$i]}"
    case $arg in
        --docker)
            MODE="docker"
            ;;
        --native)
            MODE="native"
            ;;
        --hybrid)
            MODE="hybrid"
            ;;
        --production)
            PRODUCTION=true
            ;;
        --tailscale)
            TAILSCALE="${args[$((i+1))]}"
            ;;
        --nginx=*)
            NGINX_MODE="${arg#*=}"
            ;;
        --ttyd=*)
            TTYD_MODE="${arg#*=}"
            ;;
        --api=*)
            API_MODE="${arg#*=}"
            ;;
    esac
done

# Validate mode
if [[ -z "$MODE" ]]; then
    echo "Usage: ./deploy.sh <--docker|--native|--hybrid> [options]"
    echo ""
    echo "Modes:"
    echo "  --docker   All in docker"
    echo "  --native   All native (local, basic auth)"
    echo "  --hybrid   Mix docker + native"
    echo ""
    echo "Options:"
    echo "  --tailscale <host[:port]>  Tailscale HTTPS (default port: 8080)"
    echo "  --production           Production SSL (manual certs)"
    echo "  --nginx=docker|native  Hybrid: nginx mode"
    echo "  --ttyd=docker|native   Hybrid: ttyd mode"
    echo "  --api=docker|native    Hybrid: API mode"
    echo ""
    echo "Examples:"
    echo "  ./deploy.sh --native"
    echo "  ./deploy.sh --native --tailscale myhost.ts.net"
    echo "  ./deploy.sh --hybrid --nginx=docker"
    exit 1
fi

# Set defaults for hybrid mode
if [[ "$MODE" == "hybrid" ]]; then
    NGINX_MODE="${NGINX_MODE:-docker}"
    TTYD_MODE="${TTYD_MODE:-native}"
    API_MODE="${API_MODE:-native}"
elif [[ "$MODE" == "docker" ]]; then
    NGINX_MODE="docker"
    TTYD_MODE="docker"
    API_MODE="docker"
elif [[ "$MODE" == "native" ]]; then
    NGINX_MODE="native"
    TTYD_MODE="native"
    API_MODE="native"
fi

echo "=== Termote Deployment ==="
echo "nginx: $NGINX_MODE | ttyd: $TTYD_MODE | api: $API_MODE"
echo ""

# Build PWA
echo "[1/4] Building PWA..."
cd "$PROJECT_DIR/pwa"
pnpm install --frozen-lockfile
pnpm build
cd "$PROJECT_DIR"

# Deploy PWA files
echo "[2/4] Deploying PWA..."
if [[ "$NGINX_MODE" == "docker" ]]; then
    # PWA served from docker volume
    mkdir -p "$PROJECT_DIR/pwa/dist"
else
    # PWA served from /var/www/termote
    sudo mkdir -p /var/www/termote/scripts
    sudo cp -r "$PROJECT_DIR/pwa/dist/"* /var/www/termote/
    sudo cp "$PROJECT_DIR/scripts/tmux-api.sh" /var/www/termote/scripts/
    sudo chmod +x /var/www/termote/scripts/tmux-api.sh
    sudo chown -R www-data:www-data /var/www/termote
fi

# Deploy services
echo "[3/4] Deploying services..."
USER=$(whoami)

# nginx
if [[ "$NGINX_MODE" == "docker" ]]; then
    if [ ! -f "$PROJECT_DIR/.htpasswd" ]; then
        echo "Creating .htpasswd (enter password):"
        echo "admin:$(openssl passwd -apr1)" > "$PROJECT_DIR/.htpasswd"
    fi
elif [[ "$NGINX_MODE" == "native" ]]; then
    # Create htpasswd for nginx auth
    if [ ! -f "/etc/nginx/.htpasswd" ]; then
        echo "Creating /etc/nginx/.htpasswd (enter password):"
        echo "admin:$(openssl passwd -apr1)" | sudo tee /etc/nginx/.htpasswd > /dev/null
    fi
    # Check if nginx is installed
    if ! command -v nginx &> /dev/null; then
        echo "  Error: nginx not installed. Run: sudo apt install nginx"
        exit 1
    fi

    # Determine nginx config directory
    if [ -d "/etc/nginx/sites-available" ]; then
        NGINX_CONF="/etc/nginx/sites-available/termote"
        NGINX_LINK="/etc/nginx/sites-enabled/termote"
    elif [ -d "/etc/nginx/conf.d" ]; then
        NGINX_CONF="/etc/nginx/conf.d/termote.conf"
        NGINX_LINK=""
    else
        # Create conf.d if neither exists
        sudo mkdir -p /etc/nginx/conf.d
        NGINX_CONF="/etc/nginx/conf.d/termote.conf"
        NGINX_LINK=""
    fi

    # Install nginx config
    if [[ -n "$TAILSCALE" ]]; then
        # Parse hostname:port format
        if [[ "$TAILSCALE" == *":"* ]]; then
            TS_HOST="${TAILSCALE%%:*}"
            TS_PORT="${TAILSCALE##*:}"
        else
            TS_HOST="$TAILSCALE"
            TS_PORT="8080"
        fi

        echo "  Installing Tailscale nginx config for $TS_HOST:$TS_PORT..."

        # Get Tailscale IP (bind only to this - not LAN accessible)
        TS_IP=$(tailscale ip -4 2>/dev/null || echo "127.0.0.1")
        echo "  Tailscale IP: $TS_IP (LAN not accessible)"

        # Generate Tailscale certs
        sudo mkdir -p /var/lib/tailscale/certs
        sudo tailscale cert --cert-file /var/lib/tailscale/certs/${TS_HOST}.crt \
                            --key-file /var/lib/tailscale/certs/${TS_HOST}.key \
                            "$TS_HOST" 2>/dev/null || true
        # Update config with hostname, port, and Tailscale IP
        sed -e "s/<hostname>/$TS_HOST/g" \
            -e "s/<port>/$TS_PORT/g" \
            -e "s/<tailscale_ip>/$TS_IP/g" \
            "$PROJECT_DIR/nginx/nginx-tailscale.conf" | sudo tee "$NGINX_CONF" > /dev/null
    elif [[ "$PRODUCTION" == true ]]; then
        echo "  Installing production nginx config..."
        sudo cp "$PROJECT_DIR/nginx/nginx-production.conf" "$NGINX_CONF"
    else
        echo "  Installing local nginx config..."
        sudo cp "$PROJECT_DIR/nginx/nginx-local.conf" "$NGINX_CONF"
    fi

    # Create symlink if using sites-available
    if [ -n "$NGINX_LINK" ]; then
        sudo ln -sf "$NGINX_CONF" "$NGINX_LINK"
    fi
    sudo nginx -t
fi

# Install systemd services
NEED_RELOAD=false
if [[ "$TTYD_MODE" == "native" ]]; then
    if [ ! -f "/etc/systemd/system/termote@.service" ]; then
        sudo cp "$PROJECT_DIR/systemd/termote.service" "/etc/systemd/system/termote@.service"
        NEED_RELOAD=true
    fi
fi
if [[ "$API_MODE" == "native" ]]; then
    if [ ! -f "/etc/systemd/system/tmux-api@.service" ]; then
        sudo cp "$PROJECT_DIR/systemd/tmux-api.service" "/etc/systemd/system/tmux-api@.service"
        NEED_RELOAD=true
    fi
fi
if [[ "$NEED_RELOAD" == true ]]; then
    sudo systemctl daemon-reload
fi

# Start native services
if [[ "$TTYD_MODE" == "native" ]]; then
    sudo systemctl enable "termote@$USER" 2>/dev/null || true
    sudo systemctl restart "termote@$USER"
fi
if [[ "$API_MODE" == "native" ]]; then
    sudo systemctl enable "tmux-api@$USER" 2>/dev/null || true
    sudo systemctl restart "tmux-api@$USER"
fi

# Start docker services if needed
if [[ "$NGINX_MODE" == "docker" || "$TTYD_MODE" == "docker" ]]; then
    echo "[4/4] Starting docker services..."

    # Generate docker-compose override for hybrid
    if [[ "$MODE" == "hybrid" ]]; then
        cat > "$PROJECT_DIR/docker-compose.override.yml" << EOF
services:
  ttyd:
    profiles: [${TTYD_MODE/native/disabled}]
  nginx:
    profiles: [${NGINX_MODE/native/disabled}]
EOF
    else
        rm -f "$PROJECT_DIR/docker-compose.override.yml"
    fi

    docker compose down 2>/dev/null || true
    docker compose up -d
else
    echo "[4/4] Reloading nginx..."
    sudo systemctl reload nginx 2>/dev/null || true
fi

# Verify
echo ""
"$SCRIPT_DIR/health-check.sh" || true

echo ""
echo "=== Deployment complete ==="
if [[ -n "$TAILSCALE" ]]; then
    if [[ "$TAILSCALE" == *":"* ]]; then
        echo "Access at: https://$TAILSCALE"
    else
        echo "Access at: https://$TAILSCALE:8080"
    fi
elif [[ "$PRODUCTION" == true ]]; then
    echo "Access at: https://your-domain.com"
else
    echo "Access at: http://localhost:8080"
fi
