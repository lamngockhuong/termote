#!/bin/bash
# Termote CLI - unified management tool
# Usage:
#   ./termote.sh                    # Interactive menu
#   ./termote.sh install container  # Container mode (docker/podman)
#   ./termote.sh install native     # Native mode (host tools)
#   ./termote.sh uninstall all      # Full cleanup
#   ./termote.sh health             # Check services

set -e

VERSION="0.0.2" # x-release-please-version
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Cached system info (computed once)
OS="$(uname)"
ARCH="$(case "$(uname -m)" in x86_64|amd64) echo amd64;; aarch64|arm64) echo arm64;; *) echo amd64;; esac)"

# Constants
PORT_MAIN=7680
PORT_TTYD=7681

# =============================================================================
# COLORS & UI
# =============================================================================
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

# Check if gum is available for fancy UI
HAS_GUM=$(command -v gum &>/dev/null && echo true || echo false)

info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }
step()  { echo -e "${CYAN}[$1]${NC} $2"; }

# Fancy header
show_header() {
    echo -e "${BOLD}${BLUE}"
    echo "  ████████╗███████╗██████╗ ███╗   ███╗ ██████╗ ████████╗███████╗"
    echo "  ╚══██╔══╝██╔════╝██╔══██╗████╗ ████║██╔═══██╗╚══██╔══╝██╔════╝"
    echo "     ██║   █████╗  ██████╔╝██╔████╔██║██║   ██║   ██║   █████╗  "
    echo "     ██║   ██╔══╝  ██╔══██╗██║╚██╔╝██║██║   ██║   ██║   ██╔══╝  "
    echo "     ██║   ███████╗██║  ██║██║ ╚═╝ ██║╚██████╔╝   ██║   ███████╗"
    echo "     ╚═╝   ╚══════╝╚═╝  ╚═╝╚═╝     ╚═╝ ╚═════╝    ╚═╝   ╚══════╝"
    echo -e "${NC}"
    echo -e "${DIM}  Terminal + Remote | v${VERSION}${NC}"
    echo ""
}

# =============================================================================
# COMMON FUNCTIONS
# =============================================================================

detect_container_runtime() {
    if command -v podman &>/dev/null; then
        echo "podman"
    elif command -v docker &>/dev/null; then
        echo "docker"
    else
        error "Neither podman nor docker found. Please install one."
    fi
}

get_arch() { echo "$ARCH"; }

get_lan_ip() {
    hostname -I 2>/dev/null | awk '{print $1}' || \
    ipconfig getifaddr en0 2>/dev/null || \
    echo "0.0.0.0"
}

start_ttyd() {
    local ttyd_ver
    ttyd_ver=$(ttyd --version 2>&1 | grep -oE '[0-9]+\.[0-9]+' | head -1)
    if [[ "$(printf '%s\n' "1.7" "$ttyd_ver" | sort -V | head -1)" == "1.7" ]]; then
        nohup ttyd -W -p $PORT_TTYD tmux new-session -A -s main > /dev/null 2>&1 &
    else
        nohup ttyd -p $PORT_TTYD tmux new-session -A -s main > /dev/null 2>&1 &
    fi
    sleep 1
}

start_serve_mode() {
    local binary="$1" pwa_dir="$2"
    TERMOTE_PORT="$PORT" \
    TERMOTE_BIND="$BIND_ADDR" \
    TERMOTE_PWA_DIR="$pwa_dir" \
    TERMOTE_USER="admin" \
    TERMOTE_PASS="${TERMOTE_PASS:-}" \
    TERMOTE_NO_AUTH="${NO_AUTH}" \
    nohup "$binary" > /dev/null 2>&1 &
}

stop_native_services() {
    pkill -f "ttyd" 2>/dev/null || true
    pkill -f "tmux-api" 2>/dev/null || true
}

show_credentials() {
    local pass="$1" type="${2:-auto-generated}"
    echo ""
    echo -e "${BOLD}============================================${NC}"
    echo -e "  ${GREEN}TERMOTE CREDENTIALS${NC} ($type)"
    echo -e "  Username: ${CYAN}admin${NC}"
    echo -e "  Password: ${CYAN}$pass${NC}"
    echo -e "${DIM}  (credentials shown once, not logged)${NC}"
    echo -e "${BOLD}============================================${NC}"
}

setup_auth() {
    if [[ "$NO_AUTH" == true ]]; then
        info "Basic auth disabled"
        return
    fi

    if [[ -t 0 ]]; then
        # Interactive mode
        local prompt="Enter password for admin (Enter = auto-generate): "
        if [[ "$HAS_GUM" == true ]]; then
            USER_PASS=$(gum input --password --placeholder "Leave empty to auto-generate" --header "Admin Password")
        else
            echo -n "$prompt"
            read -s USER_PASS
            echo ""
        fi

        if [[ -n "$USER_PASS" ]]; then
            export TERMOTE_PASS="$USER_PASS"
            info "Using provided password"
        else
            export TERMOTE_PASS=$(openssl rand -base64 16 | tr -dc 'a-zA-Z0-9' | head -c 12)
            info "Auto-generated password"
        fi
    else
        # Non-interactive
        export TERMOTE_PASS=$(openssl rand -base64 16 | tr -dc 'a-zA-Z0-9' | head -c 12)
        info "Auto-generated password"
    fi
}

parse_network_opts() {
    # Determine bind address
    if [[ "$LAN" == true ]]; then
        BIND_ADDR="0.0.0.0"
        LAN_IP=$(get_lan_ip)
    else
        BIND_ADDR="127.0.0.1"
    fi

    # Parse Tailscale
    if [[ -n "$TAILSCALE" ]]; then
        if [[ "$TAILSCALE" == *":"* ]]; then
            TS_HOST="${TAILSCALE%%:*}"
            TS_PORT="${TAILSCALE##*:}"
        else
            TS_HOST="$TAILSCALE"
            TS_PORT="443"
        fi
    fi
}

# Parse common command options (--lan, --port, --tailscale, --no-auth)
parse_cmd_opts() {
    while [[ $# -gt 0 ]]; do
        case $1 in
            --tailscale) TAILSCALE="$2"; shift 2 ;;
            --lan) LAN=true; shift ;;
            --port) PORT="$2"; shift 2 ;;
            --no-auth) NO_AUTH=true; shift ;;
            *) shift ;;
        esac
    done
    PORT="${PORT:-$PORT_MAIN}"
    parse_network_opts
}

# Common export block for docker-compose
export_env() {
    export USER_ID=$(id -u)
    export GROUP_ID=$(id -g)
    export NO_AUTH
    export TERMOTE_PASS
}

# Validate IP address format
validate_ip() {
    local ip="$1"
    [[ "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]
}

# Validate port number
validate_port() {
    local port="$1"
    [[ "$port" =~ ^[0-9]+$ ]] && (( port >= 1 && port <= 65535 ))
}

# Start docker mode
start_docker_mode() {
    local container_rt=$(detect_container_runtime)
    info "Using $container_rt"

    # Validate inputs before using in YAML
    validate_ip "$BIND_ADDR" || error "Invalid bind address: $BIND_ADDR"
    validate_port "$PORT" || error "Invalid port: $PORT"

    # Cross-compile for Linux on macOS
    if [[ "$OS" != "Linux" ]]; then
        info "Cross-compiling tmux-api (linux/$ARCH)..."
        (cd "$PROJECT_DIR/tmux-api" && CGO_ENABLED=0 GOOS=linux GOARCH="$ARCH" go build -ldflags="-s -w" -o tmux-api .) || error "Build failed"
    fi

    $container_rt compose down 2>/dev/null || true
    cat > "$PROJECT_DIR/docker-compose.override.yml" << EOF
services:
  termote:
    ports:
      - "${BIND_ADDR}:${PORT}:${PORT_MAIN}"
EOF
    $container_rt compose --profile docker up -d --build
    rm -f "$PROJECT_DIR/docker-compose.override.yml"
}

# Start native mode
start_native_mode() {
    command -v tmux &>/dev/null || error "tmux required"
    command -v ttyd &>/dev/null || error "ttyd required"

    stop_native_services
    # Stop any running containers
    command -v podman &>/dev/null && podman compose down 2>/dev/null || true
    command -v docker &>/dev/null && docker compose down 2>/dev/null || true

    tmux has-session -t main 2>/dev/null || tmux new-session -d -s main
    start_ttyd
}

# Setup Tailscale serve
setup_tailscale() {
    if [[ -n "$TAILSCALE" ]]; then
        info "Setting up Tailscale serve..."
        command -v tailscale &>/dev/null && sudo tailscale serve --bg --https="$TS_PORT" http://127.0.0.1:"$PORT"
    fi
}

show_access_info() {
    echo ""
    echo -e "${BOLD}=== Access Info ===${NC}"
    if [[ -n "$TAILSCALE" ]]; then
        echo -e "Tailscale: ${CYAN}https://$TS_HOST:$TS_PORT${NC}"
    fi
    if [[ "$LAN" == true ]]; then
        echo -e "LAN: ${CYAN}http://$LAN_IP:$PORT${NC}"
    elif [[ -z "$TAILSCALE" ]]; then
        echo -e "Local: ${CYAN}http://localhost:$PORT${NC}"
    fi

    if [[ "$NO_AUTH" != true && -n "$TERMOTE_PASS" ]]; then
        show_credentials "$TERMOTE_PASS"
    fi
}

# =============================================================================
# INTERACTIVE MENU
# =============================================================================

select_with_gum() {
    local header="$1"; shift
    gum choose --header "$header" "$@"
}

select_with_bash() {
    local header="$1"; shift
    echo "$header"
    echo ""
    select choice in "$@"; do
        [[ -n "$choice" ]] && echo "$choice" && break
    done
}

interactive_select() {
    local header="$1"; shift
    if [[ "$HAS_GUM" == true ]]; then
        select_with_gum "$header" "$@"
    else
        select_with_bash "$header" "$@"
    fi
}

confirm_action() {
    local msg="$1"
    if [[ "$HAS_GUM" == true ]]; then
        gum confirm "$msg" && echo "yes" || echo "no"
    else
        read -p "$msg [y/N]: " yn
        [[ "$yn" =~ ^[Yy] ]] && echo "yes" || echo "no"
    fi
}

interactive_menu() {
    show_header

    local cmd
    cmd=$(interactive_select "Select action:" \
        "Install" \
        "Uninstall" \
        "Health check" \
        "Exit")

    case "$cmd" in
        "Install"*) interactive_install ;;
        "Uninstall"*) interactive_uninstall ;;
        "Health"*) cmd_health ;;
        "Exit"|*) exit 0 ;;
    esac
}

interactive_install() {
    local mode
    mode=$(interactive_select "Select mode:" \
        "native - Host tool access (claude, gh)" \
        "container - Isolated container (docker/podman)")
    mode="${mode%% *}"  # Extract first word

    # Use array for safe option passing
    local opts=()
    if [[ $(confirm_action "Expose to LAN?") == "yes" ]]; then
        opts+=("--lan")
    fi
    if [[ $(confirm_action "Disable authentication?") == "yes" ]]; then
        opts+=("--no-auth")
    fi
    if [[ $(confirm_action "Enable Tailscale HTTPS?") == "yes" ]]; then
        local ts_host
        if [[ "$HAS_GUM" == true ]]; then
            ts_host=$(gum input --placeholder "Tailscale hostname (e.g. myhost.ts.net)")
        else
            read -p "Tailscale hostname (e.g. myhost.ts.net): " ts_host
        fi
        [[ -n "$ts_host" ]] && opts+=("--tailscale" "$ts_host")
    fi

    cmd_install "$mode" "${opts[@]}"
}

interactive_uninstall() {
    local mode
    mode=$(interactive_select "What to remove:" "container" "native" "all")
    cmd_uninstall "$mode"
}

# =============================================================================
# COMMANDS
# =============================================================================

cmd_install() {
    local mode="$1"; shift
    [[ -z "$mode" ]] && error "Usage: termote.sh install <container|native> [options]"

    parse_cmd_opts "$@"

    # Check if release mode (pre-built artifacts)
    local RELEASE_MODE=false
    local PWA_DIST="$PROJECT_DIR/pwa/dist"
    if [[ -d "$PROJECT_DIR/pwa-dist" ]]; then
        RELEASE_MODE=true
        PWA_DIST="$PROJECT_DIR/pwa-dist"
        info "Release mode (using pre-built artifacts)"
    fi

    echo ""
    echo -e "${BOLD}=== Termote Install ($mode) ===${NC}"
    echo ""

    # Setup PWA
    step "1/4" "Setting up PWA..."
    if [[ "$RELEASE_MODE" == true ]]; then
        mkdir -p "$PROJECT_DIR/pwa/dist"
        cp -r "$PWA_DIST/"* "$PROJECT_DIR/pwa/dist/"
    else
        (cd "$PROJECT_DIR/pwa" && pnpm install --frozen-lockfile && pnpm build)
    fi

    # Setup API
    step "2/4" "Setting up tmux-api..."
    if [[ "$RELEASE_MODE" == true ]] && [[ -f "$PROJECT_DIR/tmux-api-linux-$ARCH" ]]; then
        mkdir -p "$PROJECT_DIR/tmux-api"
        cp "$PROJECT_DIR/tmux-api-linux-$ARCH" "$PROJECT_DIR/tmux-api/tmux-api"
        chmod +x "$PROJECT_DIR/tmux-api/tmux-api"
    elif [[ ("$mode" == "container" || "$mode" == "docker") && "$OS" != "Linux" ]]; then
        (cd "$PROJECT_DIR/tmux-api" && CGO_ENABLED=0 GOOS=linux GOARCH="$ARCH" go build -ldflags="-s -w" -o tmux-api .)
    else
        (cd "$PROJECT_DIR/tmux-api" && CGO_ENABLED=0 go build -ldflags="-s -w" -o tmux-api-native .)
    fi

    step "3/4" "Setting up auth..."
    setup_auth

    step "4/4" "Starting services..."
    export_env

    case $mode in
        container|docker) start_docker_mode ;;
        native)
            start_native_mode
            local binary="$PROJECT_DIR/tmux-api/tmux-api-native"
            [[ ! -f "$binary" ]] && binary="$PROJECT_DIR/tmux-api/tmux-api"
            start_serve_mode "$binary" "$PROJECT_DIR/pwa/dist"
            ;;
        *) error "Unknown mode: $mode" ;;
    esac

    setup_tailscale

    show_access_info
}

cmd_uninstall() {
    local mode="$1"
    [[ -z "$mode" ]] && error "Usage: termote.sh uninstall <container|native|all>"

    echo ""
    echo -e "${BOLD}=== Termote Uninstall ($mode) ===${NC}"
    echo ""

    # Detect container runtime
    local CONTAINER_RT=""
    command -v podman &>/dev/null && CONTAINER_RT="podman"
    command -v docker &>/dev/null && CONTAINER_RT="docker"

    # Docker cleanup
    if [[ "$mode" == "container" || "$mode" == "docker" || "$mode" == "all" ]]; then
        info "Stopping containers..."
        if [[ -n "$CONTAINER_RT" ]]; then
            cd "$PROJECT_DIR"
            $CONTAINER_RT compose --profile docker down -v 2>/dev/null || true
            $CONTAINER_RT stop termote 2>/dev/null || true
            $CONTAINER_RT rm termote 2>/dev/null || true
        fi
        rm -f "$PROJECT_DIR/docker-compose.override.yml"
    fi

    # Native cleanup
    if [[ "$mode" == "native" || "$mode" == "all" ]]; then
        info "Stopping native services..."
        pkill -f "ttyd" 2>/dev/null || true
        pkill -f "tmux-api" 2>/dev/null || true

        # Systemd cleanup (Linux only)
        if command -v systemctl &>/dev/null; then
            sudo systemctl stop "termote@$USER" 2>/dev/null || true
            sudo systemctl disable "termote@$USER" 2>/dev/null || true
            sudo rm -f /etc/systemd/system/termote@.service
            sudo systemctl daemon-reload 2>/dev/null || true
        fi
    fi

    # Tailscale reset
    if command -v tailscale &>/dev/null; then
        info "Resetting Tailscale serve..."
        sudo tailscale serve reset 2>/dev/null || true
    fi

    # Full cleanup
    if [[ "$mode" == "all" ]]; then
        rm -f "$PROJECT_DIR/tmux-api/tmux-api-native"
    fi

    echo ""
    info "Uninstall complete!"
}

cmd_health() {
    echo ""
    echo -e "${BOLD}=== Termote Health Check ===${NC}"
    echo ""

    local failed=0
    local port="${PORT:-$PORT_MAIN}"

    # Check ttyd
    local status=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT_TTYD/" 2>/dev/null)
    if [[ "$status" == "200" ]]; then
        echo -e "  ${GREEN}[OK]${NC} ttyd (port $PORT_TTYD)"
    else
        echo -e "  ${RED}[FAIL]${NC} ttyd (port $PORT_TTYD) - HTTP $status"
        ((failed++))
    fi

    # Check main server
    status=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$port/" 2>/dev/null)
    if [[ "$status" == "200" || "$status" == "401" ]]; then
        echo -e "  ${GREEN}[OK]${NC} termote (port $port)"
    else
        echo -e "  ${RED}[FAIL]${NC} termote (port $port) - HTTP $status"
        ((failed++))
    fi

    # Check API
    status=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$port/api/tmux/health" 2>/dev/null)
    if [[ "$status" == "200" || "$status" == "401" ]]; then
        echo -e "  ${GREEN}[OK]${NC} API (/api/tmux/health)"
    else
        echo -e "  ${YELLOW}[WARN]${NC} API - HTTP $status"
    fi

    echo ""
    if [[ $failed -eq 0 ]]; then
        echo -e "${GREEN}All services healthy!${NC}"
    else
        echo -e "${RED}$failed service(s) unhealthy${NC}"
        exit 1
    fi
}

cmd_help() {
    show_header
    echo "Usage: termote.sh [command] [options]"
    echo ""
    echo "Commands:"
    echo "  install <mode>    Install and start services"
    echo "  uninstall <mode>  Remove installation"
    echo "  health            Check service health"
    echo "  help              Show this help"
    echo ""
    echo "Modes:"
    echo "  container         Container mode (docker/podman)"
    echo "  native            Native (host tool access)"
    echo "  all               For uninstall: remove everything"
    echo ""
    echo "Options:"
    echo "  --port <port>     Host port (default: $PORT_MAIN)"
    echo "  --lan             Expose to LAN"
    echo "  --tailscale <h>   Enable Tailscale HTTPS"
    echo "  --no-auth         Disable authentication"
    echo ""
    echo "Examples:"
    echo "  termote.sh                           # Interactive menu"
    echo "  termote.sh install container         # Container mode"
    echo "  termote.sh install native --lan      # Native + LAN"
    echo "  termote.sh install native --no-auth  # Without auth"
    echo "  termote.sh uninstall all             # Full cleanup"
}

# =============================================================================
# MAIN
# =============================================================================

# Default values
LAN=false
NO_AUTH=false
PORT=""
TAILSCALE=""

# No args = interactive mode
if [[ $# -eq 0 ]]; then
    interactive_menu
    exit 0
fi

# Parse command
CMD="$1"; shift

case "$CMD" in
    install)  cmd_install "$@" ;;
    uninstall) cmd_uninstall "$@" ;;
    health)   cmd_health ;;
    help|-h|--help) cmd_help ;;
    *)
        error "Unknown command: $CMD"
        cmd_help
        ;;
esac
