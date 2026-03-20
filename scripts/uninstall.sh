#!/bin/bash
# Uninstall script for Termote
# Usage:
#   ./uninstall.sh --docker   # Remove docker containers
#   ./uninstall.sh --native   # Remove systemd services + files
#   ./uninstall.sh --all      # Remove everything

set -e

MODE="$1"

if [[ -z "$MODE" ]]; then
    echo "Usage: ./uninstall.sh <--docker|--native|--all>"
    echo "  --docker  Remove docker containers"
    echo "  --native  Remove systemd services + files"
    echo "  --all     Remove everything"
    exit 1
fi

echo "=== Termote Uninstall ==="
echo "Mode: $MODE"
echo ""

USER=$(whoami)

# Docker cleanup
if [[ "$MODE" == "--docker" || "$MODE" == "--all" ]]; then
    echo "Removing docker services..."
    docker compose down -v 2>/dev/null || true
    rm -f .htpasswd
    rm -f docker-compose.override.yml
fi

# Native cleanup
if [[ "$MODE" == "--native" || "$MODE" == "--all" ]]; then
    echo "Stopping systemd services..."
    sudo systemctl stop "termote@$USER" "tmux-api@$USER" 2>/dev/null || true
    sudo systemctl disable "termote@$USER" "tmux-api@$USER" 2>/dev/null || true

    echo "Removing systemd services..."
    sudo rm -f /etc/systemd/system/termote@.service
    sudo rm -f /etc/systemd/system/tmux-api@.service
    sudo systemctl daemon-reload

    echo "Removing deployed files..."
    sudo rm -rf /var/www/termote

    echo "Removing nginx config..."
    sudo rm -f /etc/nginx/sites-enabled/termote
    sudo rm -f /etc/nginx/sites-available/termote
    sudo rm -f /etc/nginx/conf.d/termote.conf
    sudo systemctl reload nginx 2>/dev/null || true
fi

echo ""
echo "=== Uninstall complete ==="
