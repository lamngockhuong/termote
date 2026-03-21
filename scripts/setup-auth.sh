#!/bin/bash
# Shared auth setup for Docker entrypoints
# Sources: entrypoint-allinone.sh, entrypoint-hybrid.sh

setup_auth() {
    if [[ "$NO_AUTH" == "true" ]]; then
        sed -i '/auth_basic/d' /etc/nginx/nginx.conf
        echo "[INFO] Basic auth disabled"
    elif [[ -n "$TERMOTE_USER" ]] && [[ -n "$TERMOTE_PASS" ]]; then
        echo "$TERMOTE_USER:$(openssl passwd -apr1 "$TERMOTE_PASS")" > /etc/nginx/.htpasswd
        echo "[INFO] Using provided credentials (user: $TERMOTE_USER)"
    elif grep -q 'placeholder' /etc/nginx/.htpasswd 2>/dev/null; then
        local user="admin"
        # Generate 16 bytes to ensure 12+ alphanumeric chars after filtering
        local pass=$(openssl rand -base64 16 | tr -dc 'a-zA-Z0-9' | head -c 12)
        echo "$user:$(openssl passwd -apr1 "$pass")" > /etc/nginx/.htpasswd
        echo ""
        echo "============================================"
        echo "  TERMOTE CREDENTIALS (auto-generated)"
        echo "  Username: $user"
        echo "  Password: $pass"
        echo "============================================"
        echo "  To set custom credentials, use:"
        echo "  -e TERMOTE_USER=myuser -e TERMOTE_PASS=mypass"
        echo "  To disable auth: -e NO_AUTH=true"
        echo "============================================"
        echo ""
    fi
}
