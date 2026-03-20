#!/bin/bash
# Uninstall script for Termote
# Usage:
#   ./uninstall.sh --docker   # Remove docker containers (all-in-one)
#   ./uninstall.sh --hybrid   # Remove hybrid setup (docker + native ttyd)
#   ./uninstall.sh --native   # Remove native setup (systemd + nginx)
#   ./uninstall.sh --all      # Remove everything

set -e

MODE="$1"

if [[ -z "$MODE" ]]; then
    echo "Usage: ./uninstall.sh <--docker|--hybrid|--native|--all>"
    echo ""
    echo "  --docker  Remove docker containers (all-in-one)"
    echo "  --hybrid  Remove hybrid setup (docker + native ttyd)"
    echo "  --native  Remove native setup (systemd + nginx)"
    echo "  --all     Remove everything"
    exit 1
fi

echo "=== Termote Uninstall ==="
echo "Mode: $MODE"
echo ""

USER=$(whoami)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Docker cleanup (docker & hybrid modes)
if [[ "$MODE" == "--docker" || "$MODE" == "--hybrid" || "$MODE" == "--all" ]]; then
    echo "Stopping docker containers..."
    cd "$PROJECT_DIR"
    # Stop all profiles
    docker compose --profile docker --profile hybrid down -v 2>/dev/null || true
    # Also stop any running containers by name
    docker stop termote termote-hybrid 2>/dev/null || true
    docker rm termote termote-hybrid 2>/dev/null || true

    echo "Cleaning temp files..."
    rm -f docker-compose.override.yml
    rm -f nginx/nginx-docker.conf.tmp
    rm -f nginx/nginx-hybrid.conf.tmp
fi

# Native ttyd cleanup (hybrid mode)
if [[ "$MODE" == "--hybrid" || "$MODE" == "--all" ]]; then
    echo "Stopping native ttyd..."
    pkill -f "ttyd.*tmux" 2>/dev/null || true

    # Stop systemd ttyd if running
    sudo systemctl stop "termote@$USER" 2>/dev/null || true
    sudo systemctl disable "termote@$USER" 2>/dev/null || true
fi

# Native cleanup (native mode)
if [[ "$MODE" == "--native" || "$MODE" == "--all" ]]; then
    echo "Stopping systemd services..."
    sudo systemctl stop "termote@$USER" 2>/dev/null || true
    sudo systemctl disable "termote@$USER" 2>/dev/null || true
    sudo systemctl stop "tmux-api@$USER" 2>/dev/null || true
    sudo systemctl disable "tmux-api@$USER" 2>/dev/null || true

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
    sudo rm -f /etc/nginx/.htpasswd
    sudo systemctl reload nginx 2>/dev/null || true
fi

# Reset Tailscale serve (if installed)
if command -v tailscale &>/dev/null; then
    echo "Resetting Tailscale serve..."
    sudo tailscale serve reset 2>/dev/null || true
fi

# Full cleanup
if [[ "$MODE" == "--all" ]]; then
    echo "Removing .htpasswd..."
    rm -f "$PROJECT_DIR/.htpasswd"
fi

echo ""
echo "=== Uninstall complete ==="
