#!/bin/bash
# Hybrid entrypoint: nginx + tmux-api (ttyd runs native on host)

# Disable basic auth if NO_AUTH=true
if [[ "$NO_AUTH" == "true" ]]; then
    sed -i '/auth_basic/d' /etc/nginx/nginx.conf
fi

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
