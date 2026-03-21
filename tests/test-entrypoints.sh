#!/bin/bash
# Test cases for entrypoint scripts (entrypoint-allinone.sh, entrypoint-hybrid.sh)
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

# ============================================
# entrypoint-allinone.sh tests
# ============================================

test_allinone_syntax() {
    echo "=== Testing entrypoint-allinone.sh syntax ==="

    if bash -n "$PROJECT_DIR/entrypoint-allinone.sh" 2>/dev/null; then
        pass "entrypoint-allinone.sh syntax valid"
    else
        fail "syntax" "valid bash" "syntax error"
    fi
}

test_allinone_user_setup() {
    echo ""
    echo "=== Testing all-in-one user setup ==="

    # Verify group creation
    if grep -q "getent group" "$PROJECT_DIR/entrypoint-allinone.sh" && \
       grep -q "/etc/group" "$PROJECT_DIR/entrypoint-allinone.sh"; then
        pass "dynamic group creation present"
    else
        fail "group creation" "present" "not found"
    fi

    # Verify user creation
    if grep -q "getent passwd" "$PROJECT_DIR/entrypoint-allinone.sh" && \
       grep -q "/etc/passwd" "$PROJECT_DIR/entrypoint-allinone.sh"; then
        pass "dynamic user creation present"
    else
        fail "user creation" "present" "not found"
    fi

    # Verify home directory
    if grep -q "/home/termote" "$PROJECT_DIR/entrypoint-allinone.sh"; then
        pass "home directory set to /home/termote"
    else
        fail "home dir" "/home/termote" "not found"
    fi
}

test_allinone_auth_setup() {
    echo ""
    echo "=== Testing all-in-one auth setup ==="

    # Verify setup-auth.sh sourcing
    if grep -q "source.*setup-auth.sh" "$PROJECT_DIR/entrypoint-allinone.sh"; then
        pass "sources setup-auth.sh"
    else
        fail "source auth" "setup-auth.sh" "not found"
    fi

    # Verify setup_auth call
    if grep -q "setup_auth" "$PROJECT_DIR/entrypoint-allinone.sh"; then
        pass "calls setup_auth function"
    else
        fail "setup_auth" "function call" "not found"
    fi
}

test_allinone_services() {
    echo ""
    echo "=== Testing all-in-one services ==="

    # Verify nginx start
    if grep -q "nginx -g 'daemon off;'" "$PROJECT_DIR/entrypoint-allinone.sh"; then
        pass "nginx started with daemon off"
    else
        fail "nginx" "daemon off" "not found"
    fi

    # Verify tmux-api start
    if grep -q "tmux-api" "$PROJECT_DIR/entrypoint-allinone.sh"; then
        pass "tmux-api service present"
    else
        fail "tmux-api" "present" "not found"
    fi

    # Verify ttyd start
    if grep -q "ttyd" "$PROJECT_DIR/entrypoint-allinone.sh"; then
        pass "ttyd service present"
    else
        fail "ttyd" "present" "not found"
    fi
}

test_allinone_ttyd_config() {
    echo ""
    echo "=== Testing all-in-one ttyd configuration ==="

    # Verify ttyd port
    if grep -q "\-p 7681" "$PROJECT_DIR/entrypoint-allinone.sh"; then
        pass "ttyd uses port 7681"
    else
        fail "ttyd port" "7681" "not found"
    fi

    # Verify ttyd writable mode
    if grep -q "ttyd -W" "$PROJECT_DIR/entrypoint-allinone.sh"; then
        pass "ttyd has writable mode (-W)"
    else
        fail "ttyd -W" "writable mode" "not found"
    fi

    # Verify tmux session
    if grep -q "tmux new-session -A -s main" "$PROJECT_DIR/entrypoint-allinone.sh"; then
        pass "attaches to tmux session 'main'"
    else
        fail "tmux session" "main" "not found"
    fi
}

test_allinone_signal_handling() {
    echo ""
    echo "=== Testing all-in-one signal handling ==="

    # Verify trap
    if grep -q "trap cleanup" "$PROJECT_DIR/entrypoint-allinone.sh"; then
        pass "trap cleanup present"
    else
        fail "trap" "cleanup" "not found"
    fi

    # Verify SIGTERM handling
    if grep -q "SIGTERM" "$PROJECT_DIR/entrypoint-allinone.sh"; then
        pass "SIGTERM handling present"
    else
        fail "SIGTERM" "handling" "not found"
    fi

    # Verify SIGINT handling
    if grep -q "SIGINT" "$PROJECT_DIR/entrypoint-allinone.sh"; then
        pass "SIGINT handling present"
    else
        fail "SIGINT" "handling" "not found"
    fi
}

# ============================================
# entrypoint-hybrid.sh tests
# ============================================

test_hybrid_syntax() {
    echo ""
    echo "=== Testing entrypoint-hybrid.sh syntax ==="

    if bash -n "$PROJECT_DIR/entrypoint-hybrid.sh" 2>/dev/null; then
        pass "entrypoint-hybrid.sh syntax valid"
    else
        fail "syntax" "valid bash" "syntax error"
    fi
}

test_hybrid_auth_setup() {
    echo ""
    echo "=== Testing hybrid auth setup ==="

    # Verify setup-auth.sh sourcing
    if grep -q "source.*setup-auth.sh" "$PROJECT_DIR/entrypoint-hybrid.sh"; then
        pass "sources setup-auth.sh"
    else
        fail "source auth" "setup-auth.sh" "not found"
    fi

    # Verify setup_auth call
    if grep -q "setup_auth" "$PROJECT_DIR/entrypoint-hybrid.sh"; then
        pass "calls setup_auth function"
    else
        fail "setup_auth" "function call" "not found"
    fi
}

test_hybrid_services() {
    echo ""
    echo "=== Testing hybrid services ==="

    # Verify nginx (foreground)
    if grep -q "exec nginx -g 'daemon off;'" "$PROJECT_DIR/entrypoint-hybrid.sh"; then
        pass "nginx exec in foreground"
    else
        fail "nginx exec" "foreground" "not found"
    fi

    # Verify tmux-api (background)
    if grep -q "tmux-api &" "$PROJECT_DIR/entrypoint-hybrid.sh"; then
        pass "tmux-api in background"
    else
        fail "tmux-api" "background" "not found"
    fi

    # Verify NO ttyd command (runs native on host)
    # Exclude comments (lines starting with #)
    if grep -v "^#" "$PROJECT_DIR/entrypoint-hybrid.sh" | grep -q "ttyd"; then
        fail "hybrid ttyd" "should not be present" "found ttyd command"
    else
        pass "no ttyd command (runs native on host)"
    fi
}

test_hybrid_signal_handling() {
    echo ""
    echo "=== Testing hybrid signal handling ==="

    # Verify trap
    if grep -q "trap cleanup" "$PROJECT_DIR/entrypoint-hybrid.sh"; then
        pass "trap cleanup present"
    else
        fail "trap" "cleanup" "not found"
    fi

    # Verify SIGTERM handling
    if grep -q "SIGTERM" "$PROJECT_DIR/entrypoint-hybrid.sh"; then
        pass "SIGTERM handling present"
    else
        fail "SIGTERM" "handling" "not found"
    fi
}

# ============================================
# Common tests
# ============================================

test_entrypoint_differences() {
    echo ""
    echo "=== Testing entrypoint differences ==="

    # All-in-one has ttyd command, hybrid does not (excluding comments)
    ALLINONE_HAS_TTYD=false
    HYBRID_HAS_TTYD=false
    grep -v "^#" "$PROJECT_DIR/entrypoint-allinone.sh" | grep -q "ttyd" && ALLINONE_HAS_TTYD=true
    grep -v "^#" "$PROJECT_DIR/entrypoint-hybrid.sh" | grep -q "ttyd" && HYBRID_HAS_TTYD=true

    if [[ "$ALLINONE_HAS_TTYD" == true && "$HYBRID_HAS_TTYD" == false ]]; then
        pass "ttyd command only in all-in-one (hybrid uses native)"
    else
        fail "ttyd distribution" "allinone=true,hybrid=false" "allinone=$ALLINONE_HAS_TTYD,hybrid=$HYBRID_HAS_TTYD"
    fi

    # Both have tmux-api
    if grep -q "tmux-api" "$PROJECT_DIR/entrypoint-allinone.sh" && \
       grep -q "tmux-api" "$PROJECT_DIR/entrypoint-hybrid.sh"; then
        pass "both have tmux-api"
    else
        fail "tmux-api" "in both" "missing in one"
    fi

    # Both have nginx
    if grep -q "nginx" "$PROJECT_DIR/entrypoint-allinone.sh" && \
       grep -q "nginx" "$PROJECT_DIR/entrypoint-hybrid.sh"; then
        pass "both have nginx"
    else
        fail "nginx" "in both" "missing in one"
    fi
}

test_pid_tracking() {
    echo ""
    echo "=== Testing PID tracking ==="

    # All-in-one tracks NGINX_PID
    if grep -q "NGINX_PID" "$PROJECT_DIR/entrypoint-allinone.sh"; then
        pass "all-in-one tracks NGINX_PID"
    else
        fail "NGINX_PID" "in all-in-one" "not found"
    fi

    # All-in-one tracks TMUX_API_PID
    if grep -q "TMUX_API_PID" "$PROJECT_DIR/entrypoint-allinone.sh"; then
        pass "all-in-one tracks TMUX_API_PID"
    else
        fail "TMUX_API_PID" "in all-in-one" "not found"
    fi

    # Hybrid tracks TMUX_API_PID
    if grep -q "TMUX_API_PID" "$PROJECT_DIR/entrypoint-hybrid.sh"; then
        pass "hybrid tracks TMUX_API_PID"
    else
        fail "TMUX_API_PID" "in hybrid" "not found"
    fi
}

# Run all tests
echo "Running entrypoint tests..."
echo ""

test_allinone_syntax
test_allinone_user_setup
test_allinone_auth_setup
test_allinone_services
test_allinone_ttyd_config
test_allinone_signal_handling

test_hybrid_syntax
test_hybrid_auth_setup
test_hybrid_services
test_hybrid_signal_handling

test_entrypoint_differences
test_pid_tracking

# Summary
echo ""
echo "=== Summary ==="
echo -e "Passed: ${GREEN}$PASSED${NC}"
echo -e "Failed: ${RED}$FAILED${NC}"

if [[ $FAILED -gt 0 ]]; then
    exit 1
fi
