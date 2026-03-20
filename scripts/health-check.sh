#!/bin/bash
# Health check for Termote services

echo "Checking Termote services..."
echo ""

failed=0

# Check ttyd (localhost only)
status=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:7681/" 2>/dev/null)
if [[ "$status" == "200" ]]; then
    echo "  [OK] ttyd (port 7681)"
else
    echo "  [FAIL] ttyd (port 7681) - HTTP $status"
    ((failed++))
fi

# Check tmux-api
status=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:7682/windows" 2>/dev/null)
if [[ "$status" == "200" ]]; then
    echo "  [OK] tmux-api (port 7682)"
else
    echo "  [WARN] tmux-api (port 7682) - HTTP $status (optional)"
fi

# Check nginx
PORT="${1:-7680}"

# Try Tailscale IP first
TS_IP=$(tailscale ip -4 2>/dev/null)
if [[ -n "$TS_IP" ]]; then
    status=$(curl -sk -o /dev/null -w "%{http_code}" "https://$TS_IP:$PORT/" 2>/dev/null)
    if [[ "$status" == "200" || "$status" == "401" ]]; then
        echo "  [OK] nginx HTTPS @ $TS_IP:$PORT"
    else
        echo "  [FAIL] nginx (Tailscale $TS_IP:$PORT) - HTTP $status"
        ((failed++))
    fi
else
    # Fallback to localhost
    status=$(curl -sk -o /dev/null -w "%{http_code}" "https://localhost:$PORT/" 2>/dev/null)
    if [[ "$status" == "200" || "$status" == "401" ]]; then
        echo "  [OK] nginx HTTPS (port $PORT)"
    else
        status=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$PORT/" 2>/dev/null)
        if [[ "$status" == "200" || "$status" == "401" ]]; then
            echo "  [OK] nginx HTTP (port $PORT)"
        else
            echo "  [FAIL] nginx (port $PORT) - HTTP $status"
            ((failed++))
        fi
    fi
fi

echo ""

if [[ $failed -eq 0 ]]; then
    echo "All services healthy!"
    exit 0
else
    echo "$failed service(s) unhealthy"
    exit 1
fi
