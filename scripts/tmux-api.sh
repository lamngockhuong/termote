#!/bin/bash
# Simple tmux API server using socat
# Listens on port 7682, handles REST-like requests

SESSION="${TMUX_SESSION:-main}"

handle_request() {
    read -r request
    path=$(echo "$request" | cut -d' ' -f2)

    # Read headers until empty line
    while read -r header && [ -n "$header" ] && [ "$header" != $'\r' ]; do
        :
    done

    response=""
    status="200 OK"

    case "$path" in
        /windows)
            windows=$(tmux list-windows -t "$SESSION" -F '{"id":#{window_index},"name":"#{window_name}","active":#{?window_active,true,false}}' 2>/dev/null | paste -sd,)
            response="{\"windows\":[$windows]}"
            ;;
        /select/*)
            id="${path#/select/}"
            if tmux select-window -t "$SESSION:$id" 2>/dev/null; then
                response='{"ok":true}'
            else
                response='{"ok":false,"error":"window not found"}'
            fi
            ;;
        /new*)
            name=$(echo "$path" | grep -oP 'name=\K[^&]+' || echo "")
            if [ -n "$name" ]; then
                tmux new-window -t "$SESSION" -n "$name" 2>/dev/null
            else
                tmux new-window -t "$SESSION" 2>/dev/null
            fi
            response='{"ok":true}'
            ;;
        /kill/*)
            id="${path#/kill/}"
            if tmux kill-window -t "$SESSION:$id" 2>/dev/null; then
                response='{"ok":true}'
            else
                response='{"ok":false,"error":"window not found"}'
            fi
            ;;
        *)
            status="404 Not Found"
            response='{"error":"not found"}'
            ;;
    esac

    echo -e "HTTP/1.1 $status\r"
    echo -e "Content-Type: application/json\r"
    echo -e "Content-Length: ${#response}\r"
    echo -e "Access-Control-Allow-Origin: *\r"
    echo -e "\r"
    echo -n "$response"
}

# Handle mode (called by socat)
if [[ "$1" == "--handle" ]]; then
    handle_request
    exit 0
fi

# Server mode
PORT="${1:-7682}"
export TMUX_SESSION="${2:-main}"

echo "tmux API server starting on port $PORT (session: $TMUX_SESSION)"
socat TCP-LISTEN:$PORT,reuseaddr,fork EXEC:"$0 --handle"
