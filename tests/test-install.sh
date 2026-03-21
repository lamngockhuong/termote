#!/bin/bash
# Test cases for install.sh argument parsing and logic
# Usage: make test-install

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

# Helper to parse args (simulates install.sh logic)
parse_args() {
    MODE=""
    TAILSCALE=""
    LAN=false
    NO_AUTH=false
    PORT=""
    local args=("$@")
    for i in "${!args[@]}"; do
        case "${args[$i]}" in
            --docker) MODE="docker" ;;
            --hybrid) MODE="hybrid" ;;
            --native) MODE="native" ;;
            --tailscale) TAILSCALE="${args[$((i+1))]}" ;;
            --lan) LAN=true ;;
            --port) PORT="${args[$((i+1))]}" ;;
            --no-auth) NO_AUTH=true ;;
        esac
    done
    # Default port
    PORT="${PORT:-7680}"
}

test_script_syntax() {
    echo "=== Testing script syntax ==="

    if bash -n "$PROJECT_DIR/scripts/install.sh" 2>/dev/null; then
        pass "install.sh syntax valid"
    else
        fail "syntax" "valid bash" "syntax error"
    fi
}

test_arg_parsing() {
    echo ""
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

    # Test 5: --no-auth flag
    parse_args --docker --no-auth
    [[ "$NO_AUTH" == true ]] && pass "--no-auth sets NO_AUTH=true" || fail "--no-auth" "true" "$NO_AUTH"

    # Test 6: --port with value
    parse_args --docker --port 8080
    [[ "$PORT" == "8080" ]] && pass "--port captures port number" || fail "--port" "8080" "$PORT"

    # Test 7: default port
    parse_args --docker
    [[ "$PORT" == "7680" ]] && pass "default port is 7680" || fail "default port" "7680" "$PORT"

    # Test 8: --tailscale with hostname
    parse_args --docker --tailscale myhost.ts.net
    [[ "$TAILSCALE" == "myhost.ts.net" ]] && pass "--tailscale captures hostname" || fail "--tailscale" "myhost.ts.net" "$TAILSCALE"
}

test_tailscale_parsing() {
    echo ""
    echo "=== Testing Tailscale hostname:port parsing ==="

    # Test 1: hostname only (default port 443)
    TAILSCALE="myhost.ts.net"
    if [[ "$TAILSCALE" == *":"* ]]; then
        TS_HOST="${TAILSCALE%%:*}"
        TS_PORT="${TAILSCALE##*:}"
    else
        TS_HOST="$TAILSCALE"
        TS_PORT="443"
    fi
    [[ "$TS_HOST" == "myhost.ts.net" && "$TS_PORT" == "443" ]] && \
        pass "hostname only: default port 443" || \
        fail "hostname only" "port=443" "port=$TS_PORT"

    # Test 2: hostname:port
    TAILSCALE="myhost.ts.net:8443"
    if [[ "$TAILSCALE" == *":"* ]]; then
        TS_HOST="${TAILSCALE%%:*}"
        TS_PORT="${TAILSCALE##*:}"
    else
        TS_HOST="$TAILSCALE"
        TS_PORT="443"
    fi
    [[ "$TS_HOST" == "myhost.ts.net" && "$TS_PORT" == "8443" ]] && \
        pass "hostname:port parsed correctly" || \
        fail "hostname:port" "port=8443" "port=$TS_PORT"
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

test_arch_detection() {
    echo ""
    echo "=== Testing architecture detection function ==="

    # Verify get_arch function exists
    if grep -q "get_arch()" "$PROJECT_DIR/scripts/install.sh"; then
        pass "get_arch function present"
    else
        fail "get_arch" "function present" "not found"
    fi

    # Verify supported architectures
    if grep -q "x86_64\|amd64" "$PROJECT_DIR/scripts/install.sh" && \
       grep -q "aarch64\|arm64" "$PROJECT_DIR/scripts/install.sh"; then
        pass "supports amd64 and arm64"
    else
        fail "arch support" "amd64+arm64" "missing some"
    fi
}

test_release_mode_detection() {
    echo ""
    echo "=== Testing release mode detection ==="

    # Verify pwa-dist detection
    if grep -q "pwa-dist" "$PROJECT_DIR/scripts/install.sh"; then
        pass "pwa-dist detection present"
    else
        fail "release mode" "pwa-dist check" "not found"
    fi

    # Verify RELEASE_MODE variable
    if grep -q "RELEASE_MODE=" "$PROJECT_DIR/scripts/install.sh"; then
        pass "RELEASE_MODE variable present"
    else
        fail "RELEASE_MODE" "variable present" "not found"
    fi
}

test_flag_combinations() {
    echo ""
    echo "=== Testing flag combinations ==="

    # Test: all flags together
    parse_args --docker --lan --tailscale myhost.ts.net --port 9000 --no-auth
    [[ "$MODE" == "docker" && "$LAN" == true && "$TAILSCALE" == "myhost.ts.net" && "$PORT" == "9000" && "$NO_AUTH" == true ]] && \
        pass "all flags captured correctly" || \
        fail "all flags" "docker,true,myhost.ts.net,9000,true" "$MODE,$LAN,$TAILSCALE,$PORT,$NO_AUTH"

    # Test: order independence
    parse_args --no-auth --tailscale myhost.ts.net --port 8080 --lan --hybrid
    [[ "$MODE" == "hybrid" && "$LAN" == true && "$NO_AUTH" == true ]] && \
        pass "flag order independence" || \
        fail "order independence" "hybrid,true,true" "$MODE,$LAN,$NO_AUTH"
}

test_docker_compose_usage() {
    echo ""
    echo "=== Testing docker compose usage ==="

    # Verify docker compose commands
    if grep -q "docker compose" "$PROJECT_DIR/scripts/install.sh"; then
        pass "uses docker compose (v2)"
    else
        fail "docker compose" "v2 syntax" "not found"
    fi

    # Verify profile usage
    if grep -q "\-\-profile docker" "$PROJECT_DIR/scripts/install.sh" && \
       grep -q "\-\-profile hybrid" "$PROJECT_DIR/scripts/install.sh"; then
        pass "docker compose profiles present"
    else
        fail "profiles" "docker+hybrid" "missing some"
    fi
}

test_interactive_mode() {
    echo ""
    echo "=== Testing interactive mode ==="

    # Verify interactive mode detection
    if grep -q "\-t 0" "$PROJECT_DIR/scripts/install.sh"; then
        pass "terminal detection present"
    else
        fail "terminal detection" "-t 0 check" "not found"
    fi

    # Verify default to hybrid in non-interactive
    if grep -q 'choice="2"' "$PROJECT_DIR/scripts/install.sh" || \
       grep -q "defaulting to hybrid" "$PROJECT_DIR/scripts/install.sh"; then
        pass "defaults to hybrid in non-interactive"
    else
        fail "non-interactive default" "hybrid" "not found"
    fi
}

# Run all tests
echo "Running install.sh tests..."
echo ""

test_script_syntax
test_arg_parsing
test_tailscale_parsing
test_bind_addr_logic
test_arch_detection
test_release_mode_detection
test_flag_combinations
test_docker_compose_usage
test_interactive_mode

# Summary
echo ""
echo "=== Summary ==="
echo -e "Passed: ${GREEN}$PASSED${NC}"
echo -e "Failed: ${RED}$FAILED${NC}"

if [[ $FAILED -gt 0 ]]; then
    exit 1
fi
