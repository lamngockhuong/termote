#!/bin/bash
# Test cases for setup-auth.sh
# Usage: make test-setup-auth

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

test_script_syntax() {
    echo "=== Testing script syntax ==="

    if bash -n "$PROJECT_DIR/scripts/setup-auth.sh" 2>/dev/null; then
        pass "setup-auth.sh syntax valid"
    else
        fail "syntax" "valid bash" "syntax error"
    fi
}

test_setup_auth_function() {
    echo ""
    echo "=== Testing setup_auth function ==="

    # Verify setup_auth function exists
    if grep -q "setup_auth()" "$PROJECT_DIR/scripts/setup-auth.sh"; then
        pass "setup_auth function present"
    else
        fail "setup_auth" "function present" "not found"
    fi
}

test_no_auth_mode() {
    echo ""
    echo "=== Testing NO_AUTH mode ==="

    # Verify NO_AUTH handling
    if grep -q 'NO_AUTH.*true' "$PROJECT_DIR/scripts/setup-auth.sh"; then
        pass "NO_AUTH=true handling present"
    else
        fail "NO_AUTH" "true handling" "not found"
    fi

    # Verify auth_basic removal with sed
    if grep -q "sed -i.*auth_basic" "$PROJECT_DIR/scripts/setup-auth.sh"; then
        pass "removes auth_basic with sed"
    else
        fail "auth_basic removal" "sed command" "not found"
    fi
}

test_custom_credentials() {
    echo ""
    echo "=== Testing custom credentials ==="

    # Verify TERMOTE_USER handling
    if grep -q "TERMOTE_USER" "$PROJECT_DIR/scripts/setup-auth.sh"; then
        pass "TERMOTE_USER env var supported"
    else
        fail "TERMOTE_USER" "env var" "not found"
    fi

    # Verify TERMOTE_PASS handling
    if grep -q "TERMOTE_PASS" "$PROJECT_DIR/scripts/setup-auth.sh"; then
        pass "TERMOTE_PASS env var supported"
    else
        fail "TERMOTE_PASS" "env var" "not found"
    fi
}

test_auto_generation() {
    echo ""
    echo "=== Testing auto-generated credentials ==="

    # Verify placeholder detection
    if grep -q "placeholder" "$PROJECT_DIR/scripts/setup-auth.sh"; then
        pass "placeholder detection present"
    else
        fail "placeholder" "detection" "not found"
    fi

    # Verify openssl rand for password generation
    if grep -q "openssl rand" "$PROJECT_DIR/scripts/setup-auth.sh"; then
        pass "uses openssl rand for password"
    else
        fail "openssl rand" "password generation" "not found"
    fi

    # Verify default admin user
    if grep -q 'user="admin"' "$PROJECT_DIR/scripts/setup-auth.sh"; then
        pass "default user is admin"
    else
        fail "default user" "admin" "not found"
    fi
}

test_htpasswd_file() {
    echo ""
    echo "=== Testing .htpasswd file ==="

    # Verify .htpasswd path
    if grep -q "/etc/nginx/.htpasswd" "$PROJECT_DIR/scripts/setup-auth.sh"; then
        pass ".htpasswd at /etc/nginx/.htpasswd"
    else
        fail ".htpasswd path" "/etc/nginx/.htpasswd" "not found"
    fi

    # Verify openssl passwd for hashing
    if grep -q "openssl passwd -apr1" "$PROJECT_DIR/scripts/setup-auth.sh"; then
        pass "uses openssl passwd -apr1"
    else
        fail "password hash" "openssl passwd -apr1" "not found"
    fi
}

test_password_security() {
    echo ""
    echo "=== Testing password security ==="

    # Verify base64 encoding
    if grep -q "base64" "$PROJECT_DIR/scripts/setup-auth.sh"; then
        pass "uses base64 encoding"
    else
        fail "base64" "encoding" "not found"
    fi

    # Verify character filtering (alphanumeric only)
    if grep -q "tr -dc.*a-zA-Z0-9" "$PROJECT_DIR/scripts/setup-auth.sh"; then
        pass "filters to alphanumeric chars"
    else
        fail "char filter" "alphanumeric" "not found"
    fi

    # Verify password length (12+ chars)
    if grep -q "head -c 12" "$PROJECT_DIR/scripts/setup-auth.sh"; then
        pass "password length >= 12 chars"
    else
        fail "password length" "12 chars" "not found"
    fi
}

test_credential_display() {
    echo ""
    echo "=== Testing credential display ==="

    # Verify credentials banner
    if grep -q "TERMOTE CREDENTIALS" "$PROJECT_DIR/scripts/setup-auth.sh"; then
        pass "credentials banner present"
    else
        fail "credentials banner" "present" "not found"
    fi

    # Verify Username display
    if grep -q "Username:" "$PROJECT_DIR/scripts/setup-auth.sh"; then
        pass "username displayed"
    else
        fail "Username" "display" "not found"
    fi

    # Verify Password display
    if grep -q "Password:" "$PROJECT_DIR/scripts/setup-auth.sh"; then
        pass "password displayed"
    else
        fail "Password" "display" "not found"
    fi
}

test_info_messages() {
    echo ""
    echo "=== Testing info messages ==="

    # Verify [INFO] messages
    if grep -q "\[INFO\]" "$PROJECT_DIR/scripts/setup-auth.sh"; then
        pass "[INFO] messages present"
    else
        fail "[INFO]" "messages" "not found"
    fi

    # Verify auth disabled message
    if grep -q "auth disabled" "$PROJECT_DIR/scripts/setup-auth.sh"; then
        pass "auth disabled message present"
    else
        fail "auth disabled" "message" "not found"
    fi
}

# Run all tests
echo "Running setup-auth.sh tests..."
echo ""

test_script_syntax
test_setup_auth_function
test_no_auth_mode
test_custom_credentials
test_auto_generation
test_htpasswd_file
test_password_security
test_credential_display
test_info_messages

# Summary
echo ""
echo "=== Summary ==="
echo -e "Passed: ${GREEN}$PASSED${NC}"
echo -e "Failed: ${RED}$FAILED${NC}"

if [[ $FAILED -gt 0 ]]; then
    exit 1
fi
