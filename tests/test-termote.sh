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

    # get.sh auto-links after install
    if grep -q 'termote.sh link' "$PROJECT_DIR/scripts/get.sh"; then
        pass "get.sh auto-links after install"
    else
        fail "get.sh auto-link" "calls termote.sh link" "not found"
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

    # Verify sudo pre-cache helper exists and is used
    if grep -q 'precache_sudo_for_tailscale' "$SCRIPT"; then
        pass "precache_sudo_for_tailscale helper defined"
    else
        fail "sudo helper" "precache_sudo_for_tailscale" "not found"
    fi
    if grep -B5 'setup_tailscale' "$SCRIPT" | grep -q 'precache_sudo_for_tailscale'; then
        pass "sudo pre-cache before setup_tailscale"
    else
        fail "sudo pre-cache install" "precache_sudo_for_tailscale before setup_tailscale" "not found"
    fi
    if grep -B3 'sudo tailscale serve reset' "$SCRIPT" | grep -q 'precache_sudo_for_tailscale'; then
        pass "sudo pre-cache before tailscale reset in uninstall"
    else
        fail "sudo pre-cache uninstall" "precache_sudo_for_tailscale before serve reset" "not found"
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

test_link_unlink() {
    echo ""
    echo "=== Link/Unlink Commands ==="

    # cmd_link function exists
    if grep -q 'cmd_link()' "$SCRIPT"; then
        pass "cmd_link() function present"
    else
        fail "cmd_link" "function defined" "not found"
    fi

    # cmd_unlink function exists
    if grep -q 'cmd_unlink()' "$SCRIPT"; then
        pass "cmd_unlink() function present"
    else
        fail "cmd_unlink" "function defined" "not found"
    fi

    # Help shows link command
    if grep -q 'link.*symlink' "$SCRIPT"; then
        pass "help shows link command"
    else
        fail "help link" "link command in help" "not found"
    fi

    # Help shows unlink command
    if grep -q 'unlink.*symlink' "$SCRIPT"; then
        pass "help shows unlink command"
    else
        fail "help unlink" "unlink command in help" "not found"
    fi

    # Uses $HOME substitution for cleaner output
    if grep -q '\${.*/#\$HOME' "$SCRIPT"; then
        pass "\$HOME path substitution present"
    else
        fail "\$HOME substitution" "path display with \$HOME" "not found"
    fi

    # Detects git repo vs installed context
    if grep -q 'context=.*development\|installed' "$SCRIPT"; then
        pass "context detection (dev vs installed)"
    else
        fail "context detection" "dev/installed detection" "not found"
    fi

    # Fallback options when no write permission
    if grep -q 'sudo ln -sf' "$SCRIPT"; then
        pass "sudo fallback option present"
    else
        fail "sudo fallback" "sudo ln -sf suggestion" "not found"
    fi

    # Case statement includes link/unlink
    if grep -q 'link).*cmd_link' "$SCRIPT" && grep -q 'unlink).*cmd_unlink' "$SCRIPT"; then
        pass "link/unlink in command dispatch"
    else
        fail "command dispatch" "link/unlink cases" "not found"
    fi

    # Auto-fallback to ~/.local/bin
    if grep -q '\.local/bin' "$SCRIPT"; then
        pass "~/.local/bin fallback present"
    else
        fail "local bin fallback" "~/.local/bin" "not found"
    fi

    # Unlink checks both locations
    if grep -q 'for target in.*local/bin' "$SCRIPT"; then
        pass "unlink checks both locations"
    else
        fail "unlink locations" "checks /usr/local/bin and ~/.local/bin" "not found"
    fi

    # Shell cache hint (bash + zsh)
    if grep -q 'hash -r.*bash.*rehash.*zsh' "$SCRIPT"; then
        pass "shell cache hint (bash/zsh)"
    else
        fail "shell cache hint" "hash -r and rehash" "not found"
    fi

    # Symlink resolution - critical for link command to work
    if grep -q 'while.*-L.*_script_path' "$SCRIPT" && grep -q 'readlink' "$SCRIPT"; then
        pass "symlink resolution logic present"
    else
        fail "symlink resolution" "while loop with readlink" "not found"
    fi

    # Functional test: symlink resolves to correct PROJECT_DIR
    local test_link="/tmp/termote-symlink-test-$$"
    ln -sf "$SCRIPT" "$test_link" 2>/dev/null
    if [ -L "$test_link" ]; then
        # Run from /tmp, verify it finds pwa directory
        local output
        output=$("$test_link" health 2>&1 | head -5)
        rm -f "$test_link"
        if echo "$output" | grep -q "Health Check"; then
            pass "symlink execution works from different dir"
        else
            fail "symlink execution" "health check output" "$output"
        fi
    else
        fail "symlink creation" "create test symlink" "failed"
    fi
}

# =============================================================================
# UPDATE COMMAND TESTS
# =============================================================================
test_update_command() {
    echo ""
    echo "=== Update Command ==="

    # Function existence
    if grep -q 'cmd_update()' "$SCRIPT"; then
        pass "cmd_update() function present"
    else
        fail "cmd_update" "function present" "not found"
    fi

    # Helper functions
    if grep -q 'get_latest_version_api()' "$SCRIPT"; then
        pass "get_latest_version_api() helper present"
    else
        fail "get_latest_version_api" "function present" "not found"
    fi

    if grep -q 'verify_checksum_update()' "$SCRIPT"; then
        pass "verify_checksum_update() helper present"
    else
        fail "verify_checksum_update" "function present" "not found"
    fi

    if grep -q 'get_config_value()' "$SCRIPT"; then
        pass "get_config_value() helper present"
    else
        fail "get_config_value" "function present" "not found"
    fi

    # CLI wiring
    if grep -q 'update).*cmd_update' "$SCRIPT"; then
        pass "update command wired in case statement"
    else
        fail "CLI wiring" "update) cmd_update" "not found"
    fi

    # Interactive menu
    if grep -q '"Update"' "$SCRIPT"; then
        pass "Update option in interactive menu"
    else
        fail "interactive menu" "Update option" "not found"
    fi

    # Help text
    local help_output
    help_output=$("$SCRIPT" help 2>&1)

    if echo "$help_output" | grep -q "update"; then
        pass "help shows update command"
    else
        fail "help" "update command" "not found"
    fi

    if echo "$help_output" | grep -q "\-\-version"; then
        pass "help shows --version option"
    else
        fail "help" "--version option" "not found"
    fi

    if echo "$help_output" | grep -q "\-\-force"; then
        pass "help shows --force option"
    else
        fail "help" "--force option" "not found"
    fi

    # Arg parsing: --version flag
    if grep -q '\-\-version.*pin_version' "$SCRIPT"; then
        pass "update parses --version flag"
    else
        fail "update --version" "pin_version parsing" "not found"
    fi

    # Arg parsing: --force flag
    if grep -q '\-\-force.*force=true' "$SCRIPT"; then
        pass "update parses --force flag"
    else
        fail "update --force" "force=true" "not found"
    fi

    # Version format validation
    local output
    output=$("$SCRIPT" update --version "abc" 2>&1 || true)
    if echo "$output" | grep -qi "invalid version format"; then
        pass "update rejects invalid version format"
    else
        fail "version validation" "Invalid version format" "$output"
    fi

    # Dev repo guard (running from git repo should fail)
    output=$("$SCRIPT" update 2>&1 || true)
    if echo "$output" | grep -qi "cannot update from a git repo"; then
        pass "update refuses to run from git repo"
    else
        fail "git repo guard" "Cannot update from a git repo" "$output"
    fi

    # Unknown option handling
    output=$("$SCRIPT" update --foo 2>&1 || true)
    if echo "$output" | grep -qi "unknown option"; then
        pass "update rejects unknown options"
    else
        fail "unknown option" "Unknown option" "$output"
    fi

    # Security: temp dir cleanup via trap
    if grep -q '_update_cleanup' "$SCRIPT"; then
        pass "update uses function-based trap cleanup"
    else
        fail "trap cleanup" "_update_cleanup function" "not found"
    fi

    # Security: checksum verification calls error on mismatch
    if grep -A15 'verify_checksum_update()' "$SCRIPT" | grep -q 'error.*Checksum mismatch'; then
        pass "checksum mismatch is fatal"
    else
        fail "checksum" "fatal on mismatch" "not found"
    fi

    # Safety: exec into new script (avoids stale code execution)
    if grep -q 'exec.*scripts/termote.sh.*install' "$SCRIPT"; then
        pass "update uses exec for re-install (safe self-replacement)"
    else
        fail "exec re-install" "exec into new script" "not found"
    fi

    # Config preservation: uses get_config_value helper in cmd_update
    if sed -n '/^cmd_update()/,/^}/p' "$SCRIPT" | grep -q 'get_config_value'; then
        pass "update reads config via get_config_value helper"
    else
        fail "config reading" "get_config_value" "not found"
    fi

    # Symlink re-link check
    if grep -A80 'cmd_update' "$SCRIPT" | grep -q 'had_symlink'; then
        pass "update checks and re-links symlink"
    else
        fail "symlink re-link" "had_symlink check" "not found"
    fi

    # Downgrade warning
    if grep -A60 'cmd_update' "$SCRIPT" | grep -q 'Downgrading'; then
        pass "update warns on version downgrade"
    else
        fail "downgrade warning" "Downgrading message" "not found"
    fi

    # Uses PORT_MAIN constant (not magic "7680")
    if sed -n '/^cmd_update()/,/^}/p' "$SCRIPT" | grep -q 'PORT_MAIN'; then
        pass "update uses PORT_MAIN constant"
    else
        fail "PORT_MAIN" "uses constant" "hardcoded 7680"
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
test_link_unlink
test_update_command

# Summary
echo ""
echo "=== Summary ==="
echo -e "Passed: ${GREEN}$PASSED${NC}"
echo -e "Failed: ${RED}$FAILED${NC}"

if [[ $FAILED -gt 0 ]]; then
    exit 1
fi
