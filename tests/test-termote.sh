#!/bin/bash
# Test cases for termote.sh unified CLI
# Usage: make test

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$TEST_DIR")"
SCRIPT="$PROJECT_DIR/scripts/termote.sh"
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

# =============================================================================
# SYNTAX TESTS
# =============================================================================
test_syntax() {
    echo "=== Script Syntax ==="

    if bash -n "$SCRIPT" 2>/dev/null; then
        pass "termote.sh syntax valid"
    else
        fail "syntax" "valid bash" "syntax error"
    fi

    if bash -n "$PROJECT_DIR/scripts/get.sh" 2>/dev/null; then
        pass "get.sh syntax valid"
    else
        fail "get.sh syntax" "valid bash" "syntax error"
    fi
}

# =============================================================================
# HELP OUTPUT TESTS
# =============================================================================
test_help() {
    echo ""
    echo "=== Help Output ==="

    local output
    output=$("$SCRIPT" help 2>&1)

    if echo "$output" | grep -q "install"; then
        pass "help shows install command"
    else
        fail "help" "install command" "not found"
    fi

    if echo "$output" | grep -q "uninstall"; then
        pass "help shows uninstall command"
    else
        fail "help" "uninstall command" "not found"
    fi

    if echo "$output" | grep -q "health"; then
        pass "help shows health command"
    else
        fail "help" "health command" "not found"
    fi
}

# =============================================================================
# FUNCTION PRESENCE TESTS
# =============================================================================
test_functions() {
    echo ""
    echo "=== Required Functions ==="

    local funcs=("detect_container_runtime" "get_arch" "start_ttyd" "start_serve_mode" "show_credentials" "setup_auth")

    for func in "${funcs[@]}"; do
        if grep -q "${func}()" "$SCRIPT"; then
            pass "$func() present"
        else
            fail "$func" "function present" "not found"
        fi
    done
}

# =============================================================================
# ARGUMENT PARSING TESTS
# =============================================================================
test_arg_parsing() {
    echo ""
    echo "=== Argument Parsing ==="

    # Verify --lan handling
    if grep -q 'LAN=true' "$SCRIPT"; then
        pass "--lan flag handling"
    else
        fail "--lan" "LAN=true" "not found"
    fi

    # Verify --no-auth handling
    if grep -q 'NO_AUTH=true' "$SCRIPT"; then
        pass "--no-auth flag handling"
    else
        fail "--no-auth" "NO_AUTH=true" "not found"
    fi

    # Verify --port handling
    if grep -q 'PORT=' "$SCRIPT"; then
        pass "--port flag handling"
    else
        fail "--port" "PORT=" "not found"
    fi

    # Verify --tailscale handling
    if grep -q 'TAILSCALE=' "$SCRIPT"; then
        pass "--tailscale flag handling"
    else
        fail "--tailscale" "TAILSCALE=" "not found"
    fi
}

# =============================================================================
# ARCHITECTURE TESTS
# =============================================================================
test_architecture() {
    echo ""
    echo "=== Architecture Support ==="

    if grep -q "amd64" "$SCRIPT" && grep -q "arm64" "$SCRIPT"; then
        pass "supports amd64 and arm64"
    else
        fail "arch support" "amd64+arm64" "missing"
    fi
}

# =============================================================================
# DOCKER COMPOSE TESTS
# =============================================================================
test_docker_compose() {
    echo ""
    echo "=== Docker Compose ==="

    if grep -q "compose" "$SCRIPT"; then
        pass "uses docker compose v2"
    else
        fail "compose" "v2 syntax" "not found"
    fi

    if grep -q "\-\-profile docker" "$SCRIPT"; then
        pass "docker compose profiles"
    else
        fail "profiles" "--profile docker" "not found"
    fi
}

# =============================================================================
# INTERACTIVE MODE TESTS
# =============================================================================
test_interactive() {
    echo ""
    echo "=== Interactive Mode ==="

    if grep -q "HAS_GUM" "$SCRIPT"; then
        pass "gum detection present"
    else
        fail "gum" "HAS_GUM" "not found"
    fi

    if grep -q "interactive_menu" "$SCRIPT"; then
        pass "interactive_menu function"
    else
        fail "interactive_menu" "function" "not found"
    fi

    if grep -q "select_with_bash" "$SCRIPT"; then
        pass "bash select fallback"
    else
        fail "bash select" "fallback" "not found"
    fi
}

# =============================================================================
# ENTRYPOINT TESTS
# =============================================================================
test_entrypoints() {
    echo ""
    echo "=== Entrypoint Scripts ==="

    if bash -n "$PROJECT_DIR/entrypoint.sh" 2>/dev/null; then
        pass "entrypoint.sh syntax valid"
    else
        fail "entrypoint.sh" "valid bash" "syntax error"
    fi

    if grep -q "TERMOTE_PASS" "$PROJECT_DIR/entrypoint.sh"; then
        pass "entrypoint handles TERMOTE_PASS"
    else
        fail "entrypoint" "TERMOTE_PASS" "not found"
    fi
}

# =============================================================================
# SECURITY TESTS
# =============================================================================
test_security() {
    echo ""
    echo "=== Security ==="

    if grep -q "openssl rand" "$SCRIPT"; then
        pass "uses openssl for password generation"
    else
        fail "password gen" "openssl rand" "not found"
    fi

    if grep -q 'read -s' "$SCRIPT"; then
        pass "password input is hidden"
    else
        fail "password input" "read -s" "not found"
    fi
}

# =============================================================================
# RUN ALL TESTS
# =============================================================================
echo "Running termote.sh tests..."
echo ""

test_syntax
test_help
test_functions
test_arg_parsing
test_architecture
test_docker_compose
test_interactive
test_entrypoints
test_security

# Summary
echo ""
echo "=== Summary ==="
echo -e "Passed: ${GREEN}$PASSED${NC}"
echo -e "Failed: ${RED}$FAILED${NC}"

if [[ $FAILED -gt 0 ]]; then
    exit 1
fi
