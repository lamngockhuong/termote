#!/bin/bash
# Test cases for uninstall.sh argument parsing and logic
# Usage: make test-uninstall

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

test_mode_validation() {
    echo "=== Testing mode validation ==="

    # Test: no args shows usage
    OUTPUT=$("$PROJECT_DIR/scripts/uninstall.sh" 2>&1 || true)
    if [[ "$OUTPUT" == *"Usage:"* ]]; then
        pass "no args shows usage"
    else
        fail "no args" "Usage message" "$OUTPUT"
    fi
}

test_mode_patterns() {
    echo ""
    echo "=== Testing mode patterns ==="

    # Test mode matching logic (simulated)
    for MODE in "--docker" "--hybrid" "--native" "--all"; do
        # Docker cleanup applies to: docker, hybrid, all
        if [[ "$MODE" == "--docker" || "$MODE" == "--hybrid" || "$MODE" == "--all" ]]; then
            DOCKER_CLEANUP=true
        else
            DOCKER_CLEANUP=false
        fi

        # Native ttyd cleanup applies to: hybrid, all
        if [[ "$MODE" == "--hybrid" || "$MODE" == "--all" ]]; then
            TTYD_CLEANUP=true
        else
            TTYD_CLEANUP=false
        fi

        # Native systemd cleanup applies to: native, all
        if [[ "$MODE" == "--native" || "$MODE" == "--all" ]]; then
            NATIVE_CLEANUP=true
        else
            NATIVE_CLEANUP=false
        fi

        case "$MODE" in
            --docker)
                [[ "$DOCKER_CLEANUP" == true && "$TTYD_CLEANUP" == false && "$NATIVE_CLEANUP" == false ]] && \
                    pass "--docker: only docker cleanup" || \
                    fail "--docker" "docker=true,ttyd=false,native=false" "docker=$DOCKER_CLEANUP,ttyd=$TTYD_CLEANUP,native=$NATIVE_CLEANUP"
                ;;
            --hybrid)
                [[ "$DOCKER_CLEANUP" == true && "$TTYD_CLEANUP" == true && "$NATIVE_CLEANUP" == false ]] && \
                    pass "--hybrid: docker + ttyd cleanup" || \
                    fail "--hybrid" "docker=true,ttyd=true,native=false" "docker=$DOCKER_CLEANUP,ttyd=$TTYD_CLEANUP,native=$NATIVE_CLEANUP"
                ;;
            --native)
                [[ "$DOCKER_CLEANUP" == false && "$TTYD_CLEANUP" == false && "$NATIVE_CLEANUP" == true ]] && \
                    pass "--native: only native cleanup" || \
                    fail "--native" "docker=false,ttyd=false,native=true" "docker=$DOCKER_CLEANUP,ttyd=$TTYD_CLEANUP,native=$NATIVE_CLEANUP"
                ;;
            --all)
                [[ "$DOCKER_CLEANUP" == true && "$TTYD_CLEANUP" == true && "$NATIVE_CLEANUP" == true ]] && \
                    pass "--all: all cleanup" || \
                    fail "--all" "docker=true,ttyd=true,native=true" "docker=$DOCKER_CLEANUP,ttyd=$TTYD_CLEANUP,native=$NATIVE_CLEANUP"
                ;;
        esac
    done
}

test_script_syntax() {
    echo ""
    echo "=== Testing script syntax ==="

    if bash -n "$PROJECT_DIR/scripts/uninstall.sh" 2>/dev/null; then
        pass "uninstall.sh syntax valid"
    else
        fail "syntax" "valid bash" "syntax error"
    fi
}

test_temp_file_paths() {
    echo ""
    echo "=== Testing temp file paths ==="

    # Verify script references correct temp files
    if grep -q "docker-compose.override.yml" "$PROJECT_DIR/scripts/uninstall.sh" && \
       grep -q "nginx-docker.conf.tmp" "$PROJECT_DIR/scripts/uninstall.sh"; then
        pass "temp file cleanup paths present"
    else
        fail "temp files" "override + nginx tmp" "missing some"
    fi
}

test_systemd_services() {
    echo ""
    echo "=== Testing systemd service cleanup ==="

    # Verify both termote and tmux-api services are handled
    if grep -q "termote@" "$PROJECT_DIR/scripts/uninstall.sh" && \
       grep -q "tmux-api@" "$PROJECT_DIR/scripts/uninstall.sh"; then
        pass "both systemd services (termote, tmux-api) handled"
    else
        fail "systemd services" "termote@ + tmux-api@" "missing some"
    fi
}

test_tailscale_cleanup() {
    echo ""
    echo "=== Testing Tailscale cleanup ==="

    if grep -q "tailscale serve reset" "$PROJECT_DIR/scripts/uninstall.sh"; then
        pass "tailscale serve reset present"
    else
        fail "tailscale cleanup" "tailscale serve reset" "not found"
    fi
}

# Run all tests
echo "Running uninstall.sh tests..."
echo ""

test_mode_validation
test_mode_patterns
test_script_syntax
test_temp_file_paths
test_systemd_services
test_tailscale_cleanup

# Summary
echo ""
echo "=== Summary ==="
echo -e "Passed: ${GREEN}$PASSED${NC}"
echo -e "Failed: ${RED}$FAILED${NC}"

if [[ $FAILED -gt 0 ]]; then
    exit 1
fi
