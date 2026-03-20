#!/bin/bash
# Test cases for entrypoint.sh
# Usage: make test-entrypoints

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

test_syntax() {
    echo "=== Testing entrypoint.sh syntax ==="

    if bash -n "$PROJECT_DIR/entrypoint.sh" 2>/dev/null; then
        pass "entrypoint.sh syntax valid"
    else
        fail "syntax" "valid bash" "syntax error"
    fi
}

test_user_setup() {
    echo ""
    echo "=== Testing user setup ==="

    # Verify group creation
    if grep -q "getent group" "$PROJECT_DIR/entrypoint.sh" && \
       grep -q "/etc/group" "$PROJECT_DIR/entrypoint.sh"; then
        pass "dynamic group creation present"
    else
        fail "group creation" "present" "not found"
    fi

    # Verify user creation
    if grep -q "getent passwd" "$PROJECT_DIR/entrypoint.sh" && \
       grep -q "/etc/passwd" "$PROJECT_DIR/entrypoint.sh"; then
        pass "dynamic user creation present"
    else
        fail "user creation" "present" "not found"
    fi

    # Verify home directory
    if grep -q "/home/termote" "$PROJECT_DIR/entrypoint.sh"; then
        pass "home directory set to /home/termote"
    else
        fail "home dir" "/home/termote" "not found"
    fi
}

test_auth_setup() {
    echo ""
    echo "=== Testing auth setup ==="

    # Verify password generation
    if grep -q "openssl rand" "$PROJECT_DIR/entrypoint.sh"; then
        pass "password generation present"
    else
        fail "password gen" "openssl rand" "not found"
    fi

    # Verify NO_AUTH check
    if grep -q 'NO_AUTH.*true' "$PROJECT_DIR/entrypoint.sh"; then
        pass "NO_AUTH check present"
    else
        fail "NO_AUTH" "check" "not found"
    fi

    # Verify TERMOTE_PASS environment
    if grep -q "TERMOTE_PASS" "$PROJECT_DIR/entrypoint.sh"; then
        pass "TERMOTE_PASS environment variable"
    else
        fail "TERMOTE_PASS" "present" "not found"
    fi
}

test_services() {
    echo ""
    echo "=== Testing services ==="

    # Verify tmux-api start
    if grep -q "tmux-api" "$PROJECT_DIR/entrypoint.sh"; then
        pass "tmux-api service present"
    else
        fail "tmux-api" "present" "not found"
    fi

    # Verify ttyd start
    if grep -q "ttyd" "$PROJECT_DIR/entrypoint.sh"; then
        pass "ttyd service present"
    else
        fail "ttyd" "present" "not found"
    fi

}

test_ttyd_config() {
    echo ""
    echo "=== Testing ttyd configuration ==="

    # Verify ttyd port
    if grep -q "\-p 7681" "$PROJECT_DIR/entrypoint.sh"; then
        pass "ttyd uses port 7681"
    else
        fail "ttyd port" "7681" "not found"
    fi

    # Verify ttyd writable mode
    if grep -q "ttyd -W" "$PROJECT_DIR/entrypoint.sh"; then
        pass "ttyd has writable mode (-W)"
    else
        fail "ttyd -W" "writable mode" "not found"
    fi

    # Verify tmux session
    if grep -q "tmux new-session -A -s main" "$PROJECT_DIR/entrypoint.sh"; then
        pass "attaches to tmux session 'main'"
    else
        fail "tmux session" "main" "not found"
    fi
}

test_serve_config() {
    echo ""
    echo "=== Testing serve configuration ==="

    # Verify TERMOTE_PORT
    if grep -q "TERMOTE_PORT" "$PROJECT_DIR/entrypoint.sh"; then
        pass "TERMOTE_PORT configured"
    else
        fail "TERMOTE_PORT" "present" "not found"
    fi

    # Verify TERMOTE_PWA_DIR
    if grep -q "TERMOTE_PWA_DIR" "$PROJECT_DIR/entrypoint.sh"; then
        pass "TERMOTE_PWA_DIR configured"
    else
        fail "TERMOTE_PWA_DIR" "present" "not found"
    fi

    # Verify TERMOTE_TTYD_URL
    if grep -q "TERMOTE_TTYD_URL" "$PROJECT_DIR/entrypoint.sh"; then
        pass "TERMOTE_TTYD_URL configured"
    else
        fail "TERMOTE_TTYD_URL" "present" "not found"
    fi
}

test_signal_handling() {
    echo ""
    echo "=== Testing signal handling ==="

    # Verify trap
    if grep -q "trap cleanup" "$PROJECT_DIR/entrypoint.sh"; then
        pass "trap cleanup present"
    else
        fail "trap" "cleanup" "not found"
    fi

    # Verify SIGTERM handling
    if grep -q "SIGTERM" "$PROJECT_DIR/entrypoint.sh"; then
        pass "SIGTERM handling present"
    else
        fail "SIGTERM" "handling" "not found"
    fi

    # Verify SIGINT handling
    if grep -q "SIGINT" "$PROJECT_DIR/entrypoint.sh"; then
        pass "SIGINT handling present"
    else
        fail "SIGINT" "handling" "not found"
    fi
}

test_pid_tracking() {
    echo ""
    echo "=== Testing PID tracking ==="

    # Tracks TMUX_API_PID
    if grep -q "TMUX_API_PID" "$PROJECT_DIR/entrypoint.sh"; then
        pass "tracks TMUX_API_PID"
    else
        fail "TMUX_API_PID" "present" "not found"
    fi
}

# Run all tests
echo "Running entrypoint tests..."
echo ""

test_syntax
test_user_setup
test_auth_setup
test_services
test_ttyd_config
test_serve_config
test_signal_handling
test_pid_tracking

# Summary
echo ""
echo "=== Summary ==="
echo -e "Passed: ${GREEN}$PASSED${NC}"
echo -e "Failed: ${RED}$FAILED${NC}"

if [[ $FAILED -gt 0 ]]; then
    exit 1
fi
