#!/bin/bash
# Termote CLI - unified management tool
# Usage:
#   ./termote.sh                    # Interactive menu
#   ./termote.sh install container  # Container mode (docker/podman)
#   ./termote.sh install native     # Native mode (host tools)
#   ./termote.sh uninstall all      # Full cleanup
#   ./termote.sh health             # Check services

set -e

VERSION="0.0.10" # x-release-please-version
# Resolve symlinks (for `termote link` global command)
_script_path="${BASH_SOURCE[0]}"
while [ -L "$_script_path" ]; do
    _link_dir="$(cd "$(dirname "$_script_path")" && pwd)"
    _script_path="$(readlink "$_script_path")"
    [[ "$_script_path" != /* ]] && _script_path="$_link_dir/$_script_path"
done
SCRIPT_DIR="$(cd "$(dirname "$_script_path")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Override VERSION when running from installed location (not git repo)
if ! git -C "$SCRIPT_DIR" rev-parse --git-dir &>/dev/null && [ -f "$PROJECT_DIR/.version" ]; then
    VERSION=$(cat "$PROJECT_DIR/.version")
fi

# Cached system info (computed once)
OS="$(uname)"
_uname_m="$(uname -m)"
if [ "$_uname_m" = "x86_64" ] || [ "$_uname_m" = "amd64" ]; then
    ARCH="amd64"
elif [ "$_uname_m" = "aarch64" ] || [ "$_uname_m" = "arm64" ]; then
    ARCH="arm64"
else
    ARCH="amd64"
fi

# Constants
PORT_MAIN=7680
PORT_TTYD=7681
CONTAINER_NAME="termote"
LOG_DIR="$HOME/.termote/logs"
CONFIG_FILE="$HOME/.termote/config"

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

has_saved_tailscale_config() {
    [[ -f "$CONFIG_FILE" ]] && grep -q '^TERMOTE_TAILSCALE="[^"]' "$CONFIG_FILE" 2>/dev/null
}

get_lan_ip() {
    local ip
    ip=$(hostname -I 2>/dev/null | awk '{print $1}')
    [ -n "$ip" ] && echo "$ip" && return
    ip=$(ipconfig getifaddr en0 2>/dev/null)
    [ -n "$ip" ] && echo "$ip" && return
    echo "0.0.0.0"
}

start_ttyd() {
    # Always bind ttyd to localhost - external access via tmux-api proxy only
    # Loopback interface: lo (Linux) or lo0 (macOS)
    local lo_iface="lo"
    [[ "$OS" == "Darwin" ]] && lo_iface="lo0"

    # Ensure log directory exists
    mkdir -p "$LOG_DIR"

    local ttyd_ver
    ttyd_ver=$(ttyd --version 2>&1 | grep -oE '[0-9]+\.[0-9]+' | head -1)
    if [[ "$(printf '%s\n' "1.7" "$ttyd_ver" | sort -V | head -1)" == "1.7" ]]; then
        nohup ttyd -W -i "$lo_iface" -p $PORT_TTYD tmux new-session -A -s main >> "$LOG_DIR/ttyd.log" 2>&1 &
    else
        nohup ttyd -i "$lo_iface" -p $PORT_TTYD tmux new-session -A -s main >> "$LOG_DIR/ttyd.log" 2>&1 &
    fi
    sleep 1
}

start_serve_mode() {
    local binary="$1" pwa_dir="$2"
    # Ensure log directory exists
    mkdir -p "$LOG_DIR"
    TERMOTE_PORT="$PORT" \
    TERMOTE_BIND="$BIND_ADDR" \
    TERMOTE_PWA_DIR="$pwa_dir" \
    TERMOTE_USER="admin" \
    TERMOTE_PASS="${TERMOTE_PASS:-}" \
    TERMOTE_NO_AUTH="${NO_AUTH}" \
    nohup "$binary" >> "$LOG_DIR/tmux-api.log" 2>&1 &
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

    # Reuse saved password unless --fresh
    if [[ "$FRESH" != true && -n "$SAVED_PASS" ]]; then
        export TERMOTE_PASS="$SAVED_PASS"
        REUSED_PASS=true
        info "Using saved password (use --fresh to reset)"
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

# Derive encryption key from machine-specific data (hostname + username)
_derive_key() {
    echo -n "$(hostname)-$(whoami)-termote" | openssl dgst -sha256 -r | cut -d' ' -f1
}

# Save config after successful install
save_config() {
    local mode="$1"
    mkdir -p "$(dirname "$CONFIG_FILE")"
    local encrypted_pass=""
    if [[ -n "$TERMOTE_PASS" ]]; then
        encrypted_pass=$(echo -n "$TERMOTE_PASS" | openssl enc -aes-256-cbc -a -A -salt -pbkdf2 -pass pass:"$(_derive_key)" 2>/dev/null)
    fi
    cat > "$CONFIG_FILE" << EOF
# Termote config (auto-generated)
TERMOTE_MODE="$mode"
TERMOTE_LAN="$LAN"
TERMOTE_NO_AUTH="$NO_AUTH"
TERMOTE_PORT="${PORT:-$PORT_MAIN}"
TERMOTE_TAILSCALE="$TAILSCALE"
TERMOTE_SAVED_PASS="$encrypted_pass"
EOF
    chmod 600 "$CONFIG_FILE"
}

# Load saved config as defaults (only for values not already set by CLI)
load_config() {
    if [[ -f "$CONFIG_FILE" ]]; then
        local saved_lan saved_noauth saved_port saved_tailscale saved_pass_enc
        saved_lan=$(grep '^TERMOTE_LAN=' "$CONFIG_FILE" 2>/dev/null | cut -d= -f2- | tr -d '"')
        saved_noauth=$(grep '^TERMOTE_NO_AUTH=' "$CONFIG_FILE" 2>/dev/null | cut -d= -f2- | tr -d '"')
        saved_port=$(grep '^TERMOTE_PORT=' "$CONFIG_FILE" 2>/dev/null | cut -d= -f2- | tr -d '"')
        saved_tailscale=$(grep '^TERMOTE_TAILSCALE=' "$CONFIG_FILE" 2>/dev/null | cut -d= -f2- | tr -d '"')
        saved_pass_enc=$(grep '^TERMOTE_SAVED_PASS=' "$CONFIG_FILE" 2>/dev/null | cut -d= -f2- | tr -d '"')

        # Apply saved values only if CLI didn't explicitly set them
        [[ "$CLI_LAN" != true && "$saved_lan" == "true" ]] && LAN=true
        [[ "$CLI_NO_AUTH" != true && "$saved_noauth" == "true" ]] && NO_AUTH=true
        [[ "$CLI_PORT" != true && -n "$saved_port" && "$saved_port" != "$PORT_MAIN" ]] && PORT="$saved_port"
        [[ "$CLI_TAILSCALE" != true && -n "$saved_tailscale" ]] && TAILSCALE="$saved_tailscale"

        # Re-parse network opts with merged values
        parse_network_opts

        # Decrypt saved password (try AES-256 first, fallback to legacy base64)
        if [[ -n "$saved_pass_enc" ]]; then
            SAVED_PASS=$(echo "$saved_pass_enc" | openssl enc -aes-256-cbc -a -A -d -salt -pbkdf2 -pass pass:"$(_derive_key)" 2>/dev/null) || \
            SAVED_PASS=$(echo "$saved_pass_enc" | openssl base64 -d 2>/dev/null) || \
            SAVED_PASS=""
        fi
    fi
}

# Parse common command options (--lan, --port, --tailscale, --no-auth, --fresh)
# Sets CLI_* flags to track which options were explicitly provided
parse_cmd_opts() {
    while [[ $# -gt 0 ]]; do
        case $1 in
            --tailscale) TAILSCALE="$2"; CLI_TAILSCALE=true; shift 2 ;;
            --lan) LAN=true; CLI_LAN=true; shift ;;
            --port) PORT="$2"; CLI_PORT=true; shift 2 ;;
            --no-auth) NO_AUTH=true; CLI_NO_AUTH=true; shift ;;
            --fresh) FRESH=true; shift ;;
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

# Warn if mounting directory contains sensitive subdirectories
warn_sensitive_dirs() {
    local workspace="${WORKSPACE:-./workspace}"
    local sensitive_dirs=(".ssh" ".gnupg" ".aws" ".config/gcloud")
    local found=()
    for dir in "${sensitive_dirs[@]}"; do
        [[ -d "$workspace/$dir" ]] && found+=("$dir")
    done
    if [[ ${#found[@]} -gt 0 ]]; then
        warn "WORKSPACE contains sensitive directories: ${found[*]}"
        warn "These will be accessible inside the container. Consider using a subdirectory."
    fi
}

# Start docker mode
start_docker_mode() {
    local container_rt=$(detect_container_runtime)
    info "Using $container_rt"

    # Validate inputs before using in YAML
    validate_ip "$BIND_ADDR" || error "Invalid bind address: $BIND_ADDR"
    validate_port "$PORT" || error "Invalid port: $PORT"

    # Warn about sensitive directories in WORKSPACE
    warn_sensitive_dirs

    # Cross-compile for Linux on macOS (skip if pre-built binary exists from release mode)
    if [[ "$OS" != "Linux" && ! -f "$PROJECT_DIR/tmux-api/tmux-api" ]]; then
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

# Pre-cache sudo credentials once so tailscale commands don't prompt mid-flow
precache_sudo_for_tailscale() {
    command -v tailscale &>/dev/null && sudo -v 2>/dev/null || true
}

# Setup Tailscale serve (only reset if saved config had Tailscale previously)
setup_tailscale() {
    if [[ -n "$TAILSCALE" ]]; then
        info "Setting up Tailscale serve..."
        command -v tailscale &>/dev/null && sudo tailscale serve --bg --https="$TS_PORT" http://127.0.0.1:"$PORT"
    elif has_saved_tailscale_config; then
        # Reset Tailscale serve only if previously configured (avoid disrupting unrelated setups)
        info "Resetting previous Tailscale serve config..."
        command -v tailscale &>/dev/null && sudo tailscale serve reset 2>/dev/null || true
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
        if [[ "$REUSED_PASS" == true ]]; then
            info "Using saved password (use --fresh to reset and show)"
        else
            show_credentials "$TERMOTE_PASS"
        fi
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
    echo "$header" >&2
    echo "" >&2
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
        "View logs" \
        "Clean logs" \
        "Exit")

    case "$cmd" in
        "Install"*) interactive_install ;;
        "Uninstall"*) interactive_uninstall ;;
        "Health"*) cmd_health ;;
        "View logs"*) cmd_logs follow ;;
        "Clean logs"*) cmd_logs_clean ;;
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

    # Interactive = user chose everything explicitly, override saved config
    cmd_install "$mode" --fresh "${opts[@]}"
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

    # Parse CLI args first, then load saved config for unset values
    parse_cmd_opts "$@"
    [[ "$FRESH" != true ]] && load_config

    # Detect release mode (no pwa/package.json means this is an installed release, not the dev repo)
    local RELEASE_MODE=false
    [[ ! -f "$PROJECT_DIR/pwa/package.json" ]] && RELEASE_MODE=true
    [[ "$RELEASE_MODE" == true ]] && info "Release mode (using pre-built artifacts)"

    # Stop running services to avoid port conflicts and "Text file busy" on binary overwrite
    stop_native_services
    local crt=""
    command -v podman &>/dev/null && crt="podman"
    command -v docker &>/dev/null && crt="${crt:-docker}"
    [[ -n "$crt" ]] && $crt compose --profile docker down 2>/dev/null || true

    echo ""
    echo -e "${BOLD}=== Termote Install ($mode) ===${NC}"
    echo ""

    # Setup PWA
    step "1/4" "Setting up PWA..."
    if [[ "$RELEASE_MODE" == true ]]; then
        if [[ -d "$PROJECT_DIR/pwa-dist" ]]; then
            mkdir -p "$PROJECT_DIR/pwa/dist"
            cp -r "$PROJECT_DIR/pwa-dist/"* "$PROJECT_DIR/pwa/dist/"
            rm -rf "$PROJECT_DIR/pwa-dist"
        elif [[ ! -d "$PROJECT_DIR/pwa/dist" ]]; then
            err "PWA dist not found. Please reinstall from a release."
            return 1
        fi
    else
        (cd "$PROJECT_DIR/pwa" && pnpm install --frozen-lockfile && pnpm build)
    fi

    # Setup API
    step "2/4" "Setting up tmux-api..."
    if [[ "$RELEASE_MODE" == true ]]; then
        # Determine correct pre-built binary for the target
        local api_os="linux"
        if [[ "$mode" == "native" ]]; then
            # Native mode: use host OS binary (darwin or linux)
            api_os="$(echo "$OS" | tr '[:upper:]' '[:lower:]')"
        fi
        local prebuilt="$PROJECT_DIR/tmux-api-${api_os}-${ARCH}"
        if [[ -f "$prebuilt" ]]; then
            mkdir -p "$PROJECT_DIR/tmux-api"
            cp "$prebuilt" "$PROJECT_DIR/tmux-api/tmux-api"
            chmod +x "$PROJECT_DIR/tmux-api/tmux-api"
        else
            error "Pre-built binary not found: tmux-api-${api_os}-${ARCH}"
        fi
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

    # Only pre-cache sudo if tailscale commands will actually run
    if [[ -n "$TAILSCALE" ]] || { has_saved_tailscale_config; }; then
        precache_sudo_for_tailscale
    fi
    setup_tailscale

    # Save config for future restarts/updates
    save_config "$mode"

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
    fi

    # Tailscale reset - only if Termote was using Tailscale
    if has_saved_tailscale_config; then
        if command -v tailscale &>/dev/null; then
            precache_sudo_for_tailscale
            info "Resetting Tailscale serve..."
            sudo tailscale serve reset 2>/dev/null || true
        fi
    fi

    # Full cleanup
    if [[ "$mode" == "all" ]]; then
        rm -f "$PROJECT_DIR/tmux-api/tmux-api-native"
        if [[ -f "$CONFIG_FILE" ]]; then
            info "Removing saved config..."
            rm -f "$CONFIG_FILE"
        fi
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

    # Detect container mode (check if container is running)
    local container_mode=false
    local runtime=""
    if [[ -n "$(docker ps -q --filter "name=$CONTAINER_NAME" 2>/dev/null)" ]]; then
        container_mode=true; runtime="docker"
    elif [[ -n "$(podman ps -q --filter "name=$CONTAINER_NAME" 2>/dev/null)" ]]; then
        container_mode=true; runtime="podman"
    fi

    # Cache ss output once for bind info lookups
    local ss_cache=$(ss -tlnp 2>/dev/null || true)

    # Helper to format HTTP status
    format_status() {
        case "$1" in
            000) echo "not running" ;;
            200) echo "running" ;;
            401) echo "running (auth)" ;;
            *) echo "HTTP $1" ;;
        esac
    }

    # Get bind info from cached ss output
    get_bind_info() {
        local p="$1"
        local bind=$(echo "$ss_cache" | grep ":$p " | awk '{print $4}' | head -1)
        if [[ "$bind" == "0.0.0.0:"* || "$bind" == "*:"* ]]; then
            echo "LAN"
        elif [[ -n "$bind" ]]; then
            echo "localhost"
        fi
    }

    # Check ttyd
    if [[ "$container_mode" == true ]]; then
        local status=$($runtime exec $CONTAINER_NAME curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT_TTYD/" 2>/dev/null || true)
        if [[ "$status" == "200" ]]; then
            echo -e "  ${GREEN}[OK]${NC} ttyd :$PORT_TTYD - running (container)"
        else
            echo -e "  ${RED}[--]${NC} ttyd :$PORT_TTYD - $(format_status $status) (container)"
            : $((failed++))
        fi
    else
        local status=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT_TTYD/" 2>/dev/null || true)
        local bind_ttyd=$(get_bind_info $PORT_TTYD)
        local ttyd_info="$(format_status $status)"
        [[ -n "$bind_ttyd" ]] && ttyd_info="$ttyd_info ($bind_ttyd)"
        if [[ "$status" == "200" ]]; then
            echo -e "  ${GREEN}[OK]${NC} ttyd :$PORT_TTYD - $ttyd_info"
        else
            echo -e "  ${RED}[--]${NC} ttyd :$PORT_TTYD - $ttyd_info"
            : $((failed++))
        fi
    fi

    # Check main server
    status=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$port/" 2>/dev/null || true)
    local bind_api=$(get_bind_info $port)
    local api_info="$(format_status $status)"
    [[ -n "$bind_api" ]] && api_info="$api_info ($bind_api)"
    if [[ "$status" == "200" || "$status" == "401" ]]; then
        echo -e "  ${GREEN}[OK]${NC} tmux-api :$port - $api_info"
    else
        echo -e "  ${RED}[--]${NC} tmux-api :$port - $api_info"
        : $((failed++))
    fi

    # Check API endpoint
    status=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$port/api/tmux/health" 2>/dev/null || true)
    if [[ "$status" == "200" || "$status" == "401" ]]; then
        echo -e "  ${GREEN}[OK]${NC} API /api/tmux/health - $(format_status $status)"
    else
        echo -e "  ${YELLOW}[--]${NC} API /api/tmux/health - $(format_status $status)"
    fi

    echo ""
    if [[ $failed -eq 0 ]]; then
        echo -e "${GREEN}All services healthy!${NC}"
    else
        echo -e "${YELLOW}$failed service(s) not running${NC}"
        exit 1
    fi
}

cmd_logs() {
    local service="$1"
    local lines="${2:-50}"

    if [[ ! -d "$LOG_DIR" ]]; then
        warn "No logs found (log dir: $LOG_DIR)"
        return 0
    fi

    case "$service" in
        ttyd)
            [[ -f "$LOG_DIR/ttyd.log" ]] && tail -n "$lines" "$LOG_DIR/ttyd.log" || warn "No ttyd logs"
            ;;
        tmux-api|api)
            [[ -f "$LOG_DIR/tmux-api.log" ]] && tail -n "$lines" "$LOG_DIR/tmux-api.log" || warn "No tmux-api logs"
            ;;
        follow|tail|-f)
            # Follow all logs
            tail -f "$LOG_DIR"/*.log 2>/dev/null || warn "No logs to follow"
            ;;
        clean)
            cmd_logs_clean
            ;;
        ""|all)
            echo -e "${BOLD}=== ttyd logs ===${NC}"
            [[ -f "$LOG_DIR/ttyd.log" ]] && tail -n "$lines" "$LOG_DIR/ttyd.log" || echo "(empty)"
            echo ""
            echo -e "${BOLD}=== tmux-api logs ===${NC}"
            [[ -f "$LOG_DIR/tmux-api.log" ]] && tail -n "$lines" "$LOG_DIR/tmux-api.log" || echo "(empty)"
            ;;
        *)
            error "Unknown service: $service. Use: ttyd, tmux-api, all, follow, clean"
            ;;
    esac
}

cmd_logs_clean() {
    if [[ ! -d "$LOG_DIR" ]]; then
        info "No logs to clean"
        return 0
    fi

    local size_before=$(du -sh "$LOG_DIR" 2>/dev/null | cut -f1)
    rm -f "$LOG_DIR"/*.log
    info "Logs cleaned (was: $size_before)"
}

cmd_help() {
    show_header
    echo "Usage: termote.sh [command] [options]"
    echo ""
    echo "Commands:"
    echo "  install <mode>    Install and start services"
    echo "  uninstall <mode>  Remove installation"
    echo "  health            Check service health"
    echo "  logs [service]    View logs (ttyd, tmux-api, all, follow, clean)"
    echo "  link              Create 'termote' symlink in /usr/local/bin"
    echo "  unlink            Remove 'termote' symlink"
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
    echo "  --fresh           Ignore saved password, prompt again"
    echo ""
    echo "Examples:"
    echo "  termote.sh                           # Interactive menu"
    echo "  termote.sh install container         # Container mode"
    echo "  termote.sh install native --lan      # Native + LAN"
    echo "  termote.sh install native --no-auth  # Without auth"
    echo "  termote.sh uninstall all             # Full cleanup"
    echo "  termote.sh link                      # Create 'termote' command"
}

# =============================================================================
# LINK/UNLINK COMMANDS
# =============================================================================

cmd_link() {
    local target="/usr/local/bin/termote"
    local source="$SCRIPT_DIR/termote.sh"
    local display_source="${source/#$HOME/\$HOME}"

    # Detect context: git repo (dev) or installed (~/.termote)
    local context="installed"
    if git -C "$SCRIPT_DIR" rev-parse --git-dir &>/dev/null; then
        context="development"
    fi

    # Check if already linked to this source
    if [[ -L "$target" ]]; then
        local current_target
        current_target=$(readlink "$target")
        if [[ "$current_target" == "$source" ]]; then
            info "Already linked: $target -> $display_source"
            return 0
        else
            # Linked to different location
            local display_current="${current_target/#$HOME/\$HOME}"
            warn "Currently linked to: $display_current"
            info "Updating to: $display_source"
        fi
    fi

    # Try to create symlink: /usr/local/bin first, then ~/.local/bin
    if ln -sf "$source" "$target" 2>/dev/null; then
        info "Created symlink: $target -> $display_source"
        [[ "$context" == "development" ]] && info "Linked to git repo (development mode)"
        info "You can now run 'termote' from anywhere"
    else
        # Try ~/.local/bin (user-writable, no sudo needed)
        local user_bin="$HOME/.local/bin"
        local user_target="$user_bin/termote"
        mkdir -p "$user_bin" 2>/dev/null
        if ln -sf "$source" "$user_target" 2>/dev/null; then
            info "Created symlink: $user_target -> $display_source"
            [[ "$context" == "development" ]] && info "Linked to git repo (development mode)"
            # Check if ~/.local/bin is in PATH
            if [[ ":$PATH:" != *":$user_bin:"* ]]; then
                warn "\$HOME/.local/bin is not in PATH"
                echo "Add to ~/.bashrc or ~/.zshrc:"
                echo -e "  ${CYAN}export PATH=\"\$HOME/.local/bin:\$PATH\"${NC}"
            else
                info "You can now run 'termote' from anywhere"
            fi
        else
            # Both failed, show manual instructions
            warn "Cannot create symlink (no write permission)"
            echo ""
            echo "Run with sudo:"
            echo -e "  ${CYAN}sudo ln -sf \"$display_source\" $target${NC}"
        fi
    fi
}

cmd_unlink() {
    local removed=false

    # Check both locations
    for target in "/usr/local/bin/termote" "$HOME/.local/bin/termote"; do
        if [[ -L "$target" ]]; then
            local current_target
            current_target=$(readlink "$target")
            local display_current="${current_target/#$HOME/\$HOME}"
            local display_target="${target/#$HOME/\$HOME}"

            if rm "$target" 2>/dev/null; then
                info "Removed symlink: $display_target"
                removed=true
                info "To restore: ./scripts/termote.sh link"
                info "If 'termote' still cached, run 'hash -r' (bash) or 'rehash' (zsh)"
            else
                warn "Cannot remove $display_target (no write permission)"
                echo -e "Run: ${CYAN}sudo rm $target${NC}"
            fi
        fi
    done

    [[ "$removed" == false ]] && info "No symlink found"
    return 0
}

# =============================================================================
# MAIN
# =============================================================================

# Default values
LAN=false
NO_AUTH=false
PORT=""
TAILSCALE=""
FRESH=false
SAVED_PASS=""
REUSED_PASS=false
CLI_LAN=false
CLI_NO_AUTH=false
CLI_PORT=false
CLI_TAILSCALE=false

# No args = interactive mode
if [[ $# -eq 0 ]]; then
    interactive_menu
    exit 0
fi

# Parse command
CMD="$1"; shift

case "$CMD" in
    install)   cmd_install "$@" ;;
    uninstall) cmd_uninstall "$@" ;;
    health)    cmd_health ;;
    logs)      cmd_logs "$@" ;;
    link)      cmd_link ;;
    unlink)    cmd_unlink ;;
    help|-h|--help) cmd_help ;;
    *)
        error "Unknown command: $CMD"
        cmd_help
        ;;
esac
