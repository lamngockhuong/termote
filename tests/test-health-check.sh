#!/bin/bash
# Test cases for health-check.sh
# Usage: make test-health-check

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

    if bash -n "$PROJECT_DIR/scripts/health-check.sh" 2>/dev/null; then
        pass "health-check.sh syntax valid"
    else
        fail "syntax" "valid bash" "syntax error"
    fi
}

test_service_checks() {
    echo ""
    echo "=== Testing service check endpoints ==="

    # Verify ttyd check
    if grep -q "127.0.0.1:7681" "$PROJECT_DIR/scripts/health-check.sh"; then
        pass "ttyd check on port 7681"
    else
        fail "ttyd check" "port 7681" "not found"
    fi

    # Verify tmux-api check
    if grep -q "127.0.0.1:7682/windows" "$PROJECT_DIR/scripts/health-check.sh"; then
        pass "tmux-api check on port 7682/windows"
    else
        fail "tmux-api check" "port 7682/windows" "not found"
    fi

    # Verify nginx check
    if grep -q ":7680\|PORT" "$PROJECT_DIR/scripts/health-check.sh"; then
        pass "nginx check present"
    else
        fail "nginx check" "port 7680 or PORT" "not found"
    fi
}

test_port_parameter() {
    echo ""
    echo "=== Testing port parameter ==="

    # Verify PORT parameter support
    if grep -q 'PORT="\${1:-7680}"' "$PROJECT_DIR/scripts/health-check.sh"; then
        pass "PORT parameter with default 7680"
    else
        fail "PORT param" "default 7680" "not found"
    fi
}

test_tailscale_support() {
    echo ""
    echo "=== Testing Tailscale support ==="

    # Verify Tailscale IP detection
    if grep -q "tailscale ip" "$PROJECT_DIR/scripts/health-check.sh"; then
        pass "Tailscale IP detection present"
    else
        fail "tailscale ip" "command present" "not found"
    fi

    # Verify HTTPS check for Tailscale
    if grep -q "https://.*TS_IP" "$PROJECT_DIR/scripts/health-check.sh"; then
        pass "HTTPS check for Tailscale"
    else
        fail "Tailscale HTTPS" "https check" "not found"
    fi
}

test_http_status_codes() {
    echo ""
    echo "=== Testing HTTP status code handling ==="

    # Verify 200 OK handling
    if grep -q '"200"' "$PROJECT_DIR/scripts/health-check.sh"; then
        pass "handles HTTP 200 OK"
    else
        fail "HTTP 200" "status check" "not found"
    fi

    # Verify 401 Unauthorized handling (basic auth)
    if grep -q '"401"' "$PROJECT_DIR/scripts/health-check.sh"; then
        pass "handles HTTP 401 (basic auth)"
    else
        fail "HTTP 401" "status check" "not found"
    fi
}

test_exit_codes() {
    echo ""
    echo "=== Testing exit codes ==="

    # Verify exit 0 on success
    if grep -q "exit 0" "$PROJECT_DIR/scripts/health-check.sh"; then
        pass "exit 0 on success"
    else
        fail "exit 0" "present" "not found"
    fi

    # Verify exit 1 on failure
    if grep -q "exit 1" "$PROJECT_DIR/scripts/health-check.sh"; then
        pass "exit 1 on failure"
    else
        fail "exit 1" "present" "not found"
    fi
}

test_failure_counter() {
    echo ""
    echo "=== Testing failure counter ==="

    # Verify failed counter
    if grep -q "failed=0" "$PROJECT_DIR/scripts/health-check.sh"; then
        pass "failed counter initialized"
    else
        fail "failed counter" "initialized" "not found"
    fi

    # Verify failed increment
    if grep -q "((failed++))" "$PROJECT_DIR/scripts/health-check.sh" || \
       grep -q "failed=\$((failed" "$PROJECT_DIR/scripts/health-check.sh"; then
        pass "failed counter incremented"
    else
        fail "failed increment" "present" "not found"
    fi
}

test_curl_options() {
    echo ""
    echo "=== Testing curl options ==="

    # Verify silent mode
    if grep -q "curl -s" "$PROJECT_DIR/scripts/health-check.sh"; then
        pass "curl uses silent mode"
    else
        fail "curl -s" "silent mode" "not found"
    fi

    # Verify HTTP status code extraction
    if grep -q '"%{http_code}"' "$PROJECT_DIR/scripts/health-check.sh"; then
        pass "extracts HTTP status code"
    else
        fail "http_code" "extraction" "not found"
    fi

    # Verify insecure flag for self-signed certs
    if grep -q "curl -sk" "$PROJECT_DIR/scripts/health-check.sh"; then
        pass "supports self-signed certs (-k)"
    else
        fail "curl -k" "insecure flag" "not found"
    fi
}

test_https_fallback() {
    echo ""
    echo "=== Testing HTTPS/HTTP fallback ==="

    # Verify HTTPS check first
    if grep -q "https://localhost" "$PROJECT_DIR/scripts/health-check.sh"; then
        pass "tries HTTPS first"
    else
        fail "HTTPS first" "present" "not found"
    fi

    # Verify HTTP fallback
    if grep -q "http://localhost" "$PROJECT_DIR/scripts/health-check.sh"; then
        pass "falls back to HTTP"
    else
        fail "HTTP fallback" "present" "not found"
    fi
}

test_output_messages() {
    echo ""
    echo "=== Testing output messages ==="

    # Verify [OK] message
    if grep -q "\[OK\]" "$PROJECT_DIR/scripts/health-check.sh"; then
        pass "[OK] status message present"
    else
        fail "[OK] message" "present" "not found"
    fi

    # Verify [FAIL] message
    if grep -q "\[FAIL\]" "$PROJECT_DIR/scripts/health-check.sh"; then
        pass "[FAIL] status message present"
    else
        fail "[FAIL] message" "present" "not found"
    fi

    # Verify [WARN] message
    if grep -q "\[WARN\]" "$PROJECT_DIR/scripts/health-check.sh"; then
        pass "[WARN] status message present"
    else
        fail "[WARN] message" "present" "not found"
    fi
}

# Run all tests
echo "Running health-check.sh tests..."
echo ""

test_script_syntax
test_service_checks
test_port_parameter
test_tailscale_support
test_http_status_codes
test_exit_codes
test_failure_counter
test_curl_options
test_https_fallback
test_output_messages

# Summary
echo ""
echo "=== Summary ==="
echo -e "Passed: ${GREEN}$PASSED${NC}"
echo -e "Failed: ${RED}$FAILED${NC}"

if [[ $FAILED -gt 0 ]]; then
    exit 1
fi
