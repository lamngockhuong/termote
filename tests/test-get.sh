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

    # Verify install.sh is called
    if grep -q "scripts/install.sh" "$PROJECT_DIR/scripts/get.sh"; then
        pass "calls scripts/install.sh"
    else
        fail "install.sh call" "present" "not found"
    fi

    # Verify arguments are forwarded
    if grep -q 'install.sh "\$@"' "$PROJECT_DIR/scripts/get.sh"; then
        pass "forwards arguments to install.sh"
    else
        fail "arg forwarding" '$@' "not found"
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
test_helper_functions

# Summary
echo ""
echo "=== Summary ==="
echo -e "Passed: ${GREEN}$PASSED${NC}"
echo -e "Failed: ${RED}$FAILED${NC}"

if [[ $FAILED -gt 0 ]]; then
    exit 1
fi
