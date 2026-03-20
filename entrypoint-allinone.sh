#!/bin/bash
# All-in-one entrypoint: nginx + ttyd + tmux-api

# Add current user/group to passwd/group if not exists
if ! getent group $(id -g) >/dev/null 2>&1; then
    echo "termote:x:$(id -g):" >> /etc/group 2>/dev/null || true
fi
if ! getent passwd $(id -u) >/dev/null 2>&1; then
    echo "termote:x:$(id -u):$(id -g)::/home/termote:/bin/bash" >> /etc/passwd 2>/dev/null || true
fi

# Create home directory structure
mkdir -p /home/termote/.local/share/nano 2>/dev/null || true
export HOME=/home/termote

# Start nginx
nginx -g 'daemon off;' &
NGINX_PID=$!

# Start tmux-api
/usr/local/bin/tmux-api &
TMUX_API_PID=$!

# Trap to cleanup on exit
cleanup() {
    kill $NGINX_PID $TMUX_API_PID 2>/dev/null
    exit 0
}
trap cleanup SIGTERM SIGINT

# Start ttyd with tmux (foreground)
exec ttyd -W -p 7681 -t fontSize=14 -t theme='{"background":"#1e1e1e"}' \
    tmux new-session -A -s main
