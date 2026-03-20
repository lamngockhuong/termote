#!/bin/bash
# Test cases for deploy.sh argument parsing and logic
# Usage: make test-deploy

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$TEST_DIR")"
PASSED=0
FAILED=0

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

pass() {
    echo -e "${GREEN}PASS${NC}: $1"
    PASSED=$((PASSED + 1))
}

fail() {
    echo -e "${RED}FAIL${NC}: $1 (expected: $2, got: $3)"
    FAILED=$((FAILED + 1))
}

# Source deploy.sh functions by parsing it (without executing)
# We'll test by simulating argument parsing

# Helper to parse args (simulates deploy.sh logic)
parse_args() {
    MODE=""
    TAILSCALE=""
    LAN=false
    local args=("$@")
    for i in "${!args[@]}"; do
        case "${args[$i]}" in
            --docker) MODE="docker" ;;
            --hybrid) MODE="hybrid" ;;
            --native) MODE="native" ;;
            --tailscale) TAILSCALE="${args[$((i+1))]}" ;;
            --lan) LAN=true ;;
        esac
    done
}

test_arg_parsing() {
    echo "=== Testing argument parsing ==="

    # Test 1: --docker mode
    parse_args --docker
    [[ "$MODE" == "docker" ]] && pass "--docker sets MODE=docker" || fail "--docker" "docker" "$MODE"

    # Test 2: --hybrid mode
    parse_args --hybrid
    [[ "$MODE" == "hybrid" ]] && pass "--hybrid sets MODE=hybrid" || fail "--hybrid" "hybrid" "$MODE"

    # Test 3: --native mode
    parse_args --native
    [[ "$MODE" == "native" ]] && pass "--native sets MODE=native" || fail "--native" "native" "$MODE"

    # Test 4: --lan flag
    parse_args --docker --lan
    [[ "$LAN" == true ]] && pass "--lan sets LAN=true" || fail "--lan" "true" "$LAN"

    # Test 5: --tailscale with hostname
    parse_args --docker --tailscale myhost.ts.net
    [[ "$TAILSCALE" == "myhost.ts.net" ]] && pass "--tailscale captures hostname" || fail "--tailscale" "myhost.ts.net" "$TAILSCALE"

    # Test 6: --tailscale with hostname:port
    parse_args --docker --tailscale myhost.ts.net:443
    [[ "$TAILSCALE" == "myhost.ts.net:443" ]] && pass "--tailscale captures hostname:port" || fail "--tailscale" "myhost.ts.net:443" "$TAILSCALE"
}

test_tailscale_parsing() {
    echo ""
    echo "=== Testing Tailscale hostname:port parsing ==="

    # Test 1: hostname only (default port)
    TAILSCALE="myhost.ts.net"
    if [[ "$TAILSCALE" == *":"* ]]; then
        TS_HOST="${TAILSCALE%%:*}"
        TS_PORT="${TAILSCALE##*:}"
    else
        TS_HOST="$TAILSCALE"
        TS_PORT="7680"
    fi
    [[ "$TS_HOST" == "myhost.ts.net" && "$TS_PORT" == "7680" ]] && \
        pass "hostname only: host=myhost.ts.net, port=7680" || \
        fail "hostname only" "host=myhost.ts.net,port=7680" "host=$TS_HOST,port=$TS_PORT"

    # Test 2: hostname:port
    TAILSCALE="myhost.ts.net:443"
    if [[ "$TAILSCALE" == *":"* ]]; then
        TS_HOST="${TAILSCALE%%:*}"
        TS_PORT="${TAILSCALE##*:}"
    else
        TS_HOST="$TAILSCALE"
        TS_PORT="7680"
    fi
    [[ "$TS_HOST" == "myhost.ts.net" && "$TS_PORT" == "443" ]] && \
        pass "hostname:port: host=myhost.ts.net, port=443" || \
        fail "hostname:port" "host=myhost.ts.net,port=443" "host=$TS_HOST,port=$TS_PORT"

    # Test 3: hostname with custom port
    TAILSCALE="company.bigscale-ruffe.ts.net:9000"
    if [[ "$TAILSCALE" == *":"* ]]; then
        TS_HOST="${TAILSCALE%%:*}"
        TS_PORT="${TAILSCALE##*:}"
    else
        TS_HOST="$TAILSCALE"
        TS_PORT="7680"
    fi
    [[ "$TS_HOST" == "company.bigscale-ruffe.ts.net" && "$TS_PORT" == "9000" ]] && \
        pass "complex hostname:port parsed correctly" || \
        fail "complex hostname:port" "host=company.bigscale-ruffe.ts.net,port=9000" "host=$TS_HOST,port=$TS_PORT"
}

test_bind_addr_logic() {
    echo ""
    echo "=== Testing BIND_ADDR logic ==="

    # Test 1: default (no --lan)
    LAN=false
    if [[ "$LAN" == true ]]; then
        BIND_ADDR="0.0.0.0"
    else
        BIND_ADDR="127.0.0.1"
    fi
    [[ "$BIND_ADDR" == "127.0.0.1" ]] && pass "default: BIND_ADDR=127.0.0.1" || fail "default" "127.0.0.1" "$BIND_ADDR"

    # Test 2: with --lan
    LAN=true
    if [[ "$LAN" == true ]]; then
        BIND_ADDR="0.0.0.0"
    else
        BIND_ADDR="127.0.0.1"
    fi
    [[ "$BIND_ADDR" == "0.0.0.0" ]] && pass "--lan: BIND_ADDR=0.0.0.0" || fail "--lan" "0.0.0.0" "$BIND_ADDR"
}

test_flag_combinations() {
    echo ""
    echo "=== Testing flag combinations ==="

    # Test 1: --docker --lan --tailscale
    parse_args --docker --lan --tailscale myhost.ts.net
    [[ "$MODE" == "docker" && "$LAN" == true && "$TAILSCALE" == "myhost.ts.net" ]] && \
        pass "--docker --lan --tailscale all captured" || \
        fail "all flags" "docker,true,myhost.ts.net" "$MODE,$LAN,$TAILSCALE"

    # Test 2: order independence
    parse_args --tailscale myhost.ts.net --lan --docker
    [[ "$MODE" == "docker" && "$LAN" == true && "$TAILSCALE" == "myhost.ts.net" ]] && \
        pass "flag order independence" || \
        fail "order independence" "docker,true,myhost.ts.net" "$MODE,$LAN,$TAILSCALE"
}

test_nginx_config_templates() {
    echo ""
    echo "=== Testing nginx config templates ==="

    # Test nginx-local.conf has placeholder
    if grep -q "<bind_addr>" "$PROJECT_DIR/nginx/nginx-local.conf"; then
        pass "nginx-local.conf has <bind_addr> placeholder"
    else
        fail "nginx-local.conf" "<bind_addr> placeholder" "not found"
    fi

    # Test nginx-tailscale.conf has placeholders
    if grep -q "<hostname>" "$PROJECT_DIR/nginx/nginx-tailscale.conf" && \
       grep -q "<port>" "$PROJECT_DIR/nginx/nginx-tailscale.conf" && \
       grep -q "<tailscale_ip>" "$PROJECT_DIR/nginx/nginx-tailscale.conf"; then
        pass "nginx-tailscale.conf has all placeholders"
    else
        fail "nginx-tailscale.conf" "all placeholders" "missing some"
    fi
}

test_sed_substitution() {
    echo ""
    echo "=== Testing sed substitution ==="

    # Test sed on nginx-local.conf
    BIND_ADDR="127.0.0.1"
    RESULT=$(sed -e "s/<bind_addr>/$BIND_ADDR/g" "$PROJECT_DIR/nginx/nginx-local.conf" | grep "listen")
    if [[ "$RESULT" == *"127.0.0.1:7680"* ]]; then
        pass "sed substitutes <bind_addr> correctly"
    else
        fail "sed <bind_addr>" "127.0.0.1:7680" "$RESULT"
    fi

    # Test sed on nginx-tailscale.conf
    TS_HOST="test.ts.net"
    TS_PORT="8443"
    TS_IP="100.64.0.1"
    RESULT=$(sed -e "s/<hostname>/$TS_HOST/g" \
                 -e "s/<port>/$TS_PORT/g" \
                 -e "s/<tailscale_ip>/$TS_IP/g" \
                 "$PROJECT_DIR/nginx/nginx-tailscale.conf" | grep "listen")
    if [[ "$RESULT" == *"100.64.0.1:8443"* ]]; then
        pass "sed substitutes tailscale placeholders correctly"
    else
        fail "sed tailscale" "100.64.0.1:8443" "$RESULT"
    fi
}

# Run all tests
echo "Running deploy.sh tests..."
echo ""

test_arg_parsing
test_tailscale_parsing
test_bind_addr_logic
test_flag_combinations
test_nginx_config_templates
test_sed_substitution

# Summary
echo ""
echo "=== Summary ==="
echo -e "Passed: ${GREEN}$PASSED${NC}"
echo -e "Failed: ${RED}$FAILED${NC}"

if [[ $FAILED -gt 0 ]]; then
    exit 1
fi
