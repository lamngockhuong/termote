#!/bin/bash
# All-in-one entrypoint: tmux session + termote (serve mode).
# tini runs as PID 1 (see Dockerfile) and reaps the daemonized tmux server.

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

# Show auth status
if [[ "$NO_AUTH" != "true" ]]; then
    if [[ -z "$TERMOTE_PASS" ]]; then
        # Auto-generate password if not provided
        export TERMOTE_PASS=$(openssl rand -base64 16 | tr -dc 'a-zA-Z0-9' | head -c 12)
        echo ""
        echo "============================================"
        echo "  TERMOTE CREDENTIALS (auto-generated)"
        echo "  Username: admin"
        echo "  Password: $TERMOTE_PASS"
        echo "============================================"
        echo ""
    else
        echo ""
        echo "============================================"
        echo "  TERMOTE CREDENTIALS (user-provided)"
        echo "  Username: admin"
        echo "  Password: ********"
        echo "============================================"
        echo ""
    fi
fi

# Set environment for termote serve mode
export TERMOTE_PORT="${TERMOTE_PORT:-7680}"
export TERMOTE_BIND="${TERMOTE_BIND:-0.0.0.0}"
export TERMOTE_PWA_DIR="/var/www/termote"
export TERMOTE_USER="${TERMOTE_USER:-admin}"
[[ "$NO_AUTH" == "true" ]] && export TERMOTE_NO_AUTH="true"

# Create the shared session every client attaches to (the server would create
# it on first use too; doing it here keeps it alive from container start).
# The tmux server keeps this environment for every shell, so the password
# stays out of it; the server reads it and removes it from its own env.
tmux has-session -t main 2>/dev/null || env -u TERMOTE_PASS tmux new-session -d -s main

# The server replaces this shell, so SIGTERM from tini reaches it directly
exec /usr/local/bin/termote
