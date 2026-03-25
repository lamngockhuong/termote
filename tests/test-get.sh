#!/bin/bash
# Test cases for get.sh (online installer)
# Usage: make test-get

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

    if bash -n "$PROJECT_DIR/scripts/get.sh" 2>/dev/null; then
        pass "get.sh syntax valid"
    else
        fail "syntax" "valid bash" "syntax error"
    fi
}

test_repo_config() {
    echo ""
    echo "=== Testing repository configuration ==="

    # Verify REPO variable
    if grep -q 'REPO="lamngockhuong/termote"' "$PROJECT_DIR/scripts/get.sh"; then
        pass "REPO set to lamngockhuong/termote"
    else
        fail "REPO" "lamngockhuong/termote" "incorrect"
    fi

    # Verify INSTALL_DIR default
    if grep -q 'INSTALL_DIR=.*\.termote' "$PROJECT_DIR/scripts/get.sh"; then
        pass "default INSTALL_DIR is ~/.termote"
    else
        fail "INSTALL_DIR" "~/.termote" "not found"
    fi

    # Verify TERMOTE_INSTALL_DIR override
    if grep -q 'TERMOTE_INSTALL_DIR' "$PROJECT_DIR/scripts/get.sh"; then
        pass "TERMOTE_INSTALL_DIR override supported"
    else
        fail "env override" "TERMOTE_INSTALL_DIR" "not found"
    fi
}

test_arch_detection() {
    echo ""
    echo "=== Testing architecture detection ==="

    # Verify get_arch function
    if grep -q "get_arch()" "$PROJECT_DIR/scripts/get.sh"; then
        pass "get_arch function present"
    else
        fail "get_arch" "function present" "not found"
    fi

    # Verify supported architectures
    if grep -q "x86_64\|amd64" "$PROJECT_DIR/scripts/get.sh" && \
       grep -q "aarch64\|arm64" "$PROJECT_DIR/scripts/get.sh"; then
        pass "supports amd64 and arm64"
    else
        fail "arch support" "amd64+arm64" "missing some"
    fi
}

test_version_detection() {
    echo ""
    echo "=== Testing version detection ==="

    # Verify get_latest_version function
    if grep -q "get_latest_version()" "$PROJECT_DIR/scripts/get.sh"; then
        pass "get_latest_version function present"
    else
        fail "get_latest_version" "function present" "not found"
    fi

    # Verify GitHub API usage
    if grep -q "api.github.com.*releases/latest" "$PROJECT_DIR/scripts/get.sh"; then
        pass "uses GitHub API for version"
    else
        fail "GitHub API" "releases/latest" "not found"
    fi
}

test_checksum_verification() {
    echo ""
    echo "=== Testing checksum verification ==="

    # Verify verify_checksum function
    if grep -q "verify_checksum()" "$PROJECT_DIR/scripts/get.sh"; then
        pass "verify_checksum function present"
    else
        fail "verify_checksum" "function present" "not found"
    fi

    # Verify sha256sum support
    if grep -q "sha256sum" "$PROJECT_DIR/scripts/get.sh"; then
        pass "sha256sum command used"
    else
        fail "sha256sum" "command present" "not found"
    fi

    # Verify shasum fallback (macOS)
    if grep -q "shasum -a 256" "$PROJECT_DIR/scripts/get.sh"; then
        pass "shasum fallback for macOS"
    else
        fail "shasum fallback" "shasum -a 256" "not found"
    fi

    # Verify checksums.txt download
    if grep -q "checksums.txt" "$PROJECT_DIR/scripts/get.sh"; then
        pass "checksums.txt download present"
    else
        fail "checksums.txt" "download present" "not found"
    fi
}

test_dependency_checks() {
    echo ""
    echo "=== Testing dependency checks ==="

    # Verify curl check
    if grep -q 'command -v curl' "$PROJECT_DIR/scripts/get.sh"; then
        pass "curl dependency check present"
    else
        fail "curl check" "command -v curl" "not found"
    fi

    # Verify tar check
    if grep -q 'command -v tar' "$PROJECT_DIR/scripts/get.sh"; then
        pass "tar dependency check present"
    else
        fail "tar check" "command -v tar" "not found"
    fi
}

test_error_handling() {
    echo ""
    echo "=== Testing error handling ==="

    # Verify set -e
    if grep -q "set -e" "$PROJECT_DIR/scripts/get.sh"; then
        pass "set -e (exit on error) present"
    else
        fail "set -e" "present" "not found"
    fi

    # Verify error function
    if grep -q 'error()' "$PROJECT_DIR/scripts/get.sh" && \
       grep -q 'exit 1' "$PROJECT_DIR/scripts/get.sh"; then
        pass "error function with exit 1"
    else
        fail "error function" "with exit 1" "incomplete"
    fi
}

test_tarball_extraction() {
    echo ""
    echo "=== Testing tarball extraction ==="

    # Verify tar extraction with strip-components
    if grep -q "tar xzf.*--strip-components=1" "$PROJECT_DIR/scripts/get.sh"; then
        pass "tar extracts with --strip-components=1"
    else
        fail "tar extract" "--strip-components=1" "not found"
    fi

    # Verify tarball cleanup
    if grep -q 'rm -f.*TARBALL' "$PROJECT_DIR/scripts/get.sh" || \
       grep -q 'rm -f "\$TARBALL"' "$PROJECT_DIR/scripts/get.sh"; then
        pass "tarball cleanup after extraction"
    else
        fail "cleanup" "rm tarball" "not found"
    fi
}

test_install_script_call() {
    echo ""
    echo "=== Testing install script invocation ==="

    # Verify termote.sh install is called
    if grep -q "termote.sh install" "$PROJECT_DIR/scripts/get.sh"; then
        pass "calls termote.sh install"
    else
        fail "termote.sh install" "present" "not found"
    fi

    # Verify default mode is native
    if grep -q 'mode="native"' "$PROJECT_DIR/scripts/get.sh"; then
        pass "default mode is native"
    else
        fail "default mode" "native" "not found"
    fi

    # Verify mode extraction from args (supports --container/--native flags)
    if grep -q '\-\-container|container)' "$PROJECT_DIR/scripts/get.sh"; then
        pass "mode extraction from args (--container/container)"
    else
        fail "mode extraction" "--container pattern" "not found"
    fi
}

test_update_mode() {
    echo ""
    echo "=== Testing --update mode ==="

    # Verify UPDATE_MODE variable
    if grep -q 'UPDATE_MODE=true' "$PROJECT_DIR/scripts/get.sh"; then
        pass "--update flag sets UPDATE_MODE"
    else
        fail "--update" "UPDATE_MODE=true" "not found"
    fi

    # Verify --update implies --yes
    if grep -q 'UPDATE_MODE=true.*AUTO_YES=true' "$PROJECT_DIR/scripts/get.sh" || \
       grep -A1 'UPDATE_MODE=true' "$PROJECT_DIR/scripts/get.sh" | grep -q 'AUTO_YES=true'; then
        pass "--update implies auto-yes"
    else
        fail "--update auto-yes" "AUTO_YES=true" "not found"
    fi

    # Verify config loading uses grep/cut (not sourcing)
    if grep -q "grep.*TERMOTE_MODE.*cut" "$PROJECT_DIR/scripts/get.sh"; then
        pass "config parsed safely (grep/cut, no sourcing)"
    else
        fail "safe parsing" "grep/cut" "not found"
    fi

    # Verify quote stripping on read
    if grep -q 'tr -d.*"' "$PROJECT_DIR/scripts/get.sh"; then
        pass "quotes stripped on config read"
    else
        fail "strip quotes" "tr -d" "not found"
    fi

    # Verify stop_services preserves config (no 'uninstall all')
    if grep -A5 'stop_services()' "$PROJECT_DIR/scripts/get.sh" | grep -q 'uninstall all'; then
        fail "stop_services" "no uninstall all" "found uninstall all"
    else
        pass "stop_services preserves config (no uninstall all)"
    fi
}

test_version_pinning() {
    echo ""
    echo "=== Testing --version pinning ==="

    # Verify PIN_VERSION variable
    if grep -q 'PIN_VERSION=' "$PROJECT_DIR/scripts/get.sh"; then
        pass "PIN_VERSION variable present"
    else
        fail "PIN_VERSION" "variable" "not found"
    fi

    # Verify version format validation
    if grep -q '\^\\[0-9\\]' "$PROJECT_DIR/scripts/get.sh" || \
       grep -q 'Invalid version format' "$PROJECT_DIR/scripts/get.sh"; then
        pass "version format validation"
    else
        fail "version validation" "regex check" "not found"
    fi

    # Verify v-prefix stripping
    if grep -q '{2#v}' "$PROJECT_DIR/scripts/get.sh"; then
        pass "strips v prefix from version"
    else
        fail "v-prefix" "strip" "not found"
    fi
}

test_help_output() {
    echo ""
    echo "=== Testing --help ==="

    # Verify show_help function
    if grep -q 'show_help()' "$PROJECT_DIR/scripts/get.sh"; then
        pass "show_help() function present"
    else
        fail "show_help" "function" "not found"
    fi

    # Verify --help exits early
    if grep -q '\-\-help|-h) show_help; exit 0' "$PROJECT_DIR/scripts/get.sh"; then
        pass "--help exits before download"
    else
        fail "--help exit" "early exit" "not found"
    fi
}

test_helper_functions() {
    echo ""
    echo "=== Testing helper functions ==="

    # Verify info function
    if grep -q 'info()' "$PROJECT_DIR/scripts/get.sh"; then
        pass "info() helper present"
    else
        fail "info()" "present" "not found"
    fi

    # Verify warn function
    if grep -q 'warn()' "$PROJECT_DIR/scripts/get.sh"; then
        pass "warn() helper present"
    else
        fail "warn()" "present" "not found"
    fi

    # Verify error function
    if grep -q 'error()' "$PROJECT_DIR/scripts/get.sh"; then
        pass "error() helper present"
    else
        fail "error()" "present" "not found"
    fi
}

# Run all tests
echo "Running get.sh tests..."
echo ""

test_script_syntax
test_repo_config
test_arch_detection
test_version_detection
test_checksum_verification
test_dependency_checks
test_error_handling
test_tarball_extraction
test_install_script_call
test_update_mode
test_version_pinning
test_help_output
test_helper_functions

# Summary
echo ""
echo "=== Summary ==="
echo -e "Passed: ${GREEN}$PASSED${NC}"
echo -e "Failed: ${RED}$FAILED${NC}"

if [[ $FAILED -gt 0 ]]; then
    exit 1
fi
