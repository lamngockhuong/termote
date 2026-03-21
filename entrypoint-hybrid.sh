#!/bin/bash
# Hybrid entrypoint: nginx + tmux-api (ttyd runs native on host)

# Setup authentication
source /usr/local/bin/setup-auth.sh
setup_auth

# Start tmux-api in background
/usr/local/bin/tmux-api &
TMUX_API_PID=$!

# Trap to cleanup on exit
cleanup() {
    kill $TMUX_API_PID 2>/dev/null
    exit 0
}
trap cleanup SIGTERM SIGINT

# Start nginx (foreground)
exec nginx -g 'daemon off;'
