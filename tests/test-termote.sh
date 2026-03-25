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

    # Verify ttyd binds to localhost only (lo on Linux, lo0 on macOS)
    if grep -q 'lo_iface=' "$SCRIPT" && grep -q '\-i.*lo_iface' "$SCRIPT"; then
        pass "ttyd binds to localhost only (cross-platform)"
    else
        fail "ttyd binding" "lo_iface" "not found"
    fi
}

# =============================================================================
# CONFIG PERSISTENCE TESTS
# =============================================================================
test_config_persistence() {
    echo ""
    echo "=== Config Persistence ==="

    # Verify save_config function
    if grep -q 'save_config()' "$SCRIPT"; then
        pass "save_config() present"
    else
        fail "save_config" "function present" "not found"
    fi

    # Verify load_config function
    if grep -q 'load_config()' "$SCRIPT"; then
        pass "load_config() present"
    else
        fail "load_config" "function present" "not found"
    fi

    # Verify config file chmod 600
    if grep -q 'chmod 600.*CONFIG_FILE' "$SCRIPT"; then
        pass "config file chmod 600"
    else
        fail "chmod" "600" "not found"
    fi

    # Verify --fresh flag handling
    if grep -q 'FRESH=true' "$SCRIPT"; then
        pass "--fresh flag handling"
    else
        fail "--fresh" "FRESH=true" "not found"
    fi

    # Verify CLI override tracking
    if grep -q 'CLI_LAN=true' "$SCRIPT" && grep -q 'CLI_NO_AUTH=true' "$SCRIPT"; then
        pass "CLI override flags tracked"
    else
        fail "CLI flags" "CLI_LAN/CLI_NO_AUTH" "not found"
    fi

    # Verify interactive install forces --fresh
    if grep -q 'cmd_install.*--fresh' "$SCRIPT"; then
        pass "interactive install forces --fresh"
    else
        fail "interactive --fresh" "cmd_install --fresh" "not found"
    fi

    # Verify config values are quoted
    if grep -q 'TERMOTE_MODE="' "$SCRIPT"; then
        pass "config values are quoted"
    else
        fail "quoting" "quoted values" "unquoted"
    fi

    # Verify quote stripping on read
    if grep -q 'tr -d.*"' "$SCRIPT"; then
        pass "quotes stripped on config read"
    else
        fail "strip quotes" "tr -d" "not found"
    fi
}

# =============================================================================
# PASSWORD ENCRYPTION TESTS
# =============================================================================
test_password_encryption() {
    echo ""
    echo "=== Password Encryption ==="

    # Verify AES-256-CBC encryption
    if grep -q 'aes-256-cbc' "$SCRIPT"; then
        pass "AES-256-CBC encryption used"
    else
        fail "encryption" "aes-256-cbc" "not found"
    fi

    # Verify PBKDF2 key derivation
    if grep -q 'pbkdf2' "$SCRIPT"; then
        pass "PBKDF2 key derivation"
    else
        fail "pbkdf2" "present" "not found"
    fi

    # Verify machine-derived key
    if grep -q '_derive_key()' "$SCRIPT"; then
        pass "_derive_key() function present"
    else
        fail "_derive_key" "function" "not found"
    fi

    # Verify single-line output (-A flag)
    if grep -q '\-A' "$SCRIPT" && grep -q 'aes-256-cbc -a -A' "$SCRIPT"; then
        pass "single-line ciphertext (-A flag)"
    else
        fail "-A flag" "present" "not found"
    fi

    # Verify legacy base64 fallback
    if grep -q 'openssl base64 -d' "$SCRIPT"; then
        pass "legacy base64 decrypt fallback"
    else
        fail "base64 fallback" "openssl base64 -d" "not found"
    fi

    # Verify password hidden on reuse
    if grep -q 'REUSED_PASS' "$SCRIPT"; then
        pass "password hidden on reuse (REUSED_PASS flag)"
    else
        fail "REUSED_PASS" "flag" "not found"
    fi

    # Functional: encrypt/decrypt roundtrip
    local key
    key=$(echo -n "$(hostname)-$(whoami)-termote" | openssl dgst -sha256 -r | cut -d' ' -f1)
    local test_pass="TestP@ss!123"
    local encrypted decrypted
    encrypted=$(echo -n "$test_pass" | openssl enc -aes-256-cbc -a -A -salt -pbkdf2 -pass pass:"$key" 2>/dev/null)
    decrypted=$(echo "$encrypted" | openssl enc -aes-256-cbc -a -A -d -salt -pbkdf2 -pass pass:"$key" 2>/dev/null)
    if [[ "$decrypted" == "$test_pass" ]]; then
        pass "AES-256 encrypt/decrypt roundtrip"
    else
        fail "roundtrip" "$test_pass" "$decrypted"
    fi
}

# =============================================================================
# HEALTH CHECK TESTS
# =============================================================================
test_health_check() {
    echo ""
    echo "=== Health Check ==="

    # Verify CONTAINER_NAME constant
    if grep -q 'CONTAINER_NAME=' "$SCRIPT"; then
        pass "CONTAINER_NAME constant defined"
    else
        fail "CONTAINER_NAME" "constant" "not found"
    fi

    # Verify container mode detection
    if grep -q 'container_mode=false' "$SCRIPT" && grep -q 'container_mode=true' "$SCRIPT"; then
        pass "container mode detection"
    else
        fail "container detection" "container_mode var" "not found"
    fi

    # Verify format_status helper
    if grep -q 'format_status()' "$SCRIPT"; then
        pass "format_status helper present"
    else
        fail "format_status" "function" "not found"
    fi

    # Verify ss output caching
    if grep -q 'ss_cache=' "$SCRIPT"; then
        pass "ss output cached for efficiency"
    else
        fail "ss caching" "ss_cache var" "not found"
    fi

    # Verify health output shows LAN/localhost
    if grep -q 'LAN' "$SCRIPT" && grep -q 'localhost' "$SCRIPT"; then
        pass "health shows bind info (LAN/localhost)"
    else
        fail "bind info" "LAN/localhost" "not found"
    fi
}

# =============================================================================
# RUN ALL TESTS
# =============================================================================
test_version_display() {
    echo ""
    echo "=== Version Display ==="

    # Verify git-aware version override exists
    if grep -q 'git -C.*rev-parse.*git-dir' "$SCRIPT"; then
        pass "git-aware version detection present"
    else
        fail "git detection" "git rev-parse check" "not found"
    fi

    # Verify .version file read for installed mode
    if grep -q '\.version' "$SCRIPT"; then
        pass ".version file support present"
    else
        fail ".version support" "reads .version" "not found"
    fi

    # Verify VERSION constant still exists (for release-please)
    if grep -q '^VERSION=.*x-release-please-version' "$SCRIPT"; then
        pass "release-please VERSION marker present"
    else
        fail "VERSION marker" "x-release-please-version" "not found"
    fi
}

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
test_config_persistence
test_password_encryption
test_health_check
test_version_display

# Summary
echo ""
echo "=== Summary ==="
echo -e "Passed: ${GREEN}$PASSED${NC}"
echo -e "Failed: ${RED}$FAILED${NC}"

if [[ $FAILED -gt 0 ]]; then
    exit 1
fi
