#!/bin/bash
# All-in-one entrypoint: a tmux session or a herdr server (TERMOTE_MUX) +
# termote (serve mode). tini runs as PID 1 (see Dockerfile) and reaps the
# daemonized tmux or herdr server.

# Add current user/group to passwd/group if not exists
if ! getent group $(id -g) >/dev/null 2>&1; then
    echo "termote:x:$(id -g):" >> /etc/group 2>/dev/null || true
fi
if ! getent passwd $(id -u) >/dev/null 2>&1; then
    echo "termote:x:$(id -u):$(id -g)::/home/termote:/bin/bash" >> /etc/passwd 2>/dev/null || true
fi
# Lock down passwd/group after entrypoint writes
chmod 644 /etc/passwd /etc/group 2>/dev/null || true

# Create home directory structure
mkdir -p /home/termote/.local/share/nano 2>/dev/null || true
export HOME=/home/termote

# Basic auth username; termote serve refuses one with ":".
export TERMOTE_USER="${TERMOTE_USER:-admin}"

# Show auth status
if [[ "$NO_AUTH" != "true" ]]; then
    if [[ -z "$TERMOTE_PASS" ]]; then
        # Auto-generate password if not provided
        export TERMOTE_PASS=$(openssl rand -base64 16 | tr -dc 'a-zA-Z0-9' | head -c 12)
        echo ""
        echo "============================================"
        echo "  TERMOTE CREDENTIALS (auto-generated)"
        echo "  Username: $TERMOTE_USER"
        echo "  Password: $TERMOTE_PASS"
        echo "============================================"
        echo ""
    else
        echo ""
        echo "============================================"
        echo "  TERMOTE CREDENTIALS (user-provided)"
        echo "  Username: $TERMOTE_USER"
        echo "  Password: ********"
        echo "============================================"
        echo ""
    fi
fi

# Set environment for termote serve mode
export TERMOTE_PORT="${TERMOTE_PORT:-7680}"
export TERMOTE_BIND="${TERMOTE_BIND:-0.0.0.0}"
[[ "$NO_AUTH" == "true" ]] && export TERMOTE_NO_AUTH="true"

# Start the backend and its shared "main" session every client attaches to
# (the tmux backend would create it on first use too; doing it here keeps it
# alive from container start). The tmux or herdr server keeps this
# environment for every shell, so no TERMOTE_* variable (the password above
# all) goes in; the termote server reads them and removes them from its own env.
unset_termote=()
for v in $(compgen -e); do
    [[ "$v" == TERMOTE_* ]] && unset_termote+=(-u "$v")
done
case "${TERMOTE_MUX:-tmux}" in
tmux)
    tmux has-session -t main 2>/dev/null || env "${unset_termote[@]}" tmux new-session -d -s main
    ;;
herdr)
    # A short path under /tmp: any uid can write it (the container runs as
    # the host user, who cannot write /home/termote), and a Unix socket path
    # must fit in sun_path. termote serve finds the socket through
    # HERDR_SOCKET_PATH. XDG_CONFIG_HOME is set for herdr only: termote serve
    # reads its config from there, and /tmp is writable by anyone.
    export HERDR_SOCKET_PATH=/tmp/herdr/herdr.sock
    herdr() { XDG_CONFIG_HOME=/tmp command herdr "$@"; }
    mkdir -p /tmp/herdr
    # The subshell exits at once, so herdr becomes an orphan that tini (-s)
    # reaps, not a child of termote.
    (env "${unset_termote[@]}" XDG_CONFIG_HOME=/tmp herdr server >/tmp/herdr/server.out 2>&1 &)
    up=false
    for _ in $(seq 1 50); do
        if herdr status server 2>/dev/null | grep -q '^status: running'; then
            up=true
            break
        fi
        sleep 0.2
    done
    if [[ "$up" != true ]]; then
        echo "herdr server did not start within 10s" >&2
        cat /tmp/herdr/server.out /tmp/herdr/herdr-server.log >&2 2>/dev/null
        exit 1
    fi
    if ! herdr workspace list | grep -q '"label":"main"'; then
        env "${unset_termote[@]}" XDG_CONFIG_HOME=/tmp herdr workspace create --label main --cwd "$PWD" >/dev/null ||
            { echo "cannot create the herdr workspace 'main'" >&2; exit 1; }
    fi
    ;;
*)
    echo "unknown TERMOTE_MUX '$TERMOTE_MUX' (use: tmux, herdr)" >&2
    exit 1
    ;;
esac

# The server replaces this shell, so SIGTERM from tini reaches it directly.
# It serves the PWA embedded in the binary.
exec /usr/local/bin/termote serve
