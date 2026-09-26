#!/bin/bash
# Tests for the scripts/termote.sh shim: binary selection (installed release
# and checkout build), argument pass-through, and the 0.x update contract.
# The commands themselves are tested in Go (tmux-api/cli*_test.go).
# Usage: make test-cli

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$TEST_DIR")"
SHIM="$PROJECT_DIR/scripts/termote.sh"
PASSED=0
FAILED=0

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() {
    echo -e "${GREEN}PASS${NC}: $1"
    PASSED=$((PASSED + 1))
}

fail() {
    echo -e "${RED}FAIL${NC}: $1 (expected: $2, got: $3)"
    FAILED=$((FAILED + 1))
}

skip() { echo -e "${YELLOW}SKIP${NC}: $1"; }

# check <name> <expected> <actual>
check() {
    if [[ "$2" == "$3" ]]; then pass "$1"; else fail "$1" "$2" "$3"; fi
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

case "$(uname -s)" in Darwin) OS=darwin ;; *) OS=linux ;; esac
case "$(uname -m)" in aarch64 | arm64) ARCH=arm64 ;; *) ARCH=amd64 ;; esac

# Fake binary: prints the project dir, then one argument per line.
FAKE_BIN='#!/bin/bash
echo "DIR=$TERMOTE_PROJECT_DIR"
printf "%s\n" "$@"'

# new_install <dir>: installed-release layout with a fake platform binary
new_install() {
    mkdir -p "$1/scripts"
    cp "$SHIM" "$1/scripts/termote.sh"
    printf '%s\n' "$FAKE_BIN" >"$1/tmux-api-$OS-$ARCH"
    chmod +x "$1/tmux-api-$OS-$ARCH"
}

# args_of <output>: the argument lines after DIR=
args_of() { echo "$1" | sed '1d' | paste -sd' ' -; }

test_syntax() {
    echo "=== Shim syntax and size ==="
    if bash -n "$SHIM"; then pass "termote.sh syntax valid"; else fail "syntax" "valid" "error"; fi
    local lines
    lines=$(wc -l <"$SHIM" | tr -d ' ')
    if [[ "$lines" -le 60 ]]; then pass "termote.sh is $lines lines (<= 60)"; else fail "shim size" "<= 60 lines" "$lines"; fi
    if grep -qiE 'ttyd|docker|podman|tailscale|openssl' "$SHIM"; then
        fail "no install logic" "none" "$(grep -iE 'ttyd|docker|podman|tailscale|openssl' "$SHIM" | head -1)"
    else
        pass "no install logic in shim"
    fi
}

test_installed_release() {
    echo ""
    echo "=== Installed release ==="
    local dir="$TMP/install" out
    new_install "$dir"

    out=$("$dir/scripts/termote.sh")
    check "no args opens the menu" "menu" "$(args_of "$out")"
    check "exports TERMOTE_PROJECT_DIR" "DIR=$dir" "$(echo "$out" | head -1)"

    # The exact command lines 0.1.0 `update` runs after extracting 1.0.0
    out=$("$dir/scripts/termote.sh" link)
    check "0.x update: link" "link" "$(args_of "$out")"
    out=$("$dir/scripts/termote.sh" install native --lan --no-auth --port 7700 --tailscale myhost:8443)
    check "0.x update: install with saved flags" "install native --lan --no-auth --port 7700 --tailscale myhost:8443" "$(args_of "$out")"

    out=$("$dir/scripts/termote.sh" install native --allow-host "my host")
    check "keeps arguments with spaces" "my host" "$(echo "$out" | tail -1)"

    # The global command is a symlink; the shim must find the install dir
    ln -s "$dir/scripts/termote.sh" "$TMP/termote-link"
    out=$("$TMP/termote-link" version)
    check "resolves the global symlink" "DIR=$dir" "$(echo "$out" | head -1)"

    chmod -x "$dir/tmux-api-$OS-$ARCH"
    out=$("$dir/scripts/termote.sh" health)
    check "restores the exec bit" "health" "$(args_of "$out")"

    rm "$dir/tmux-api-$OS-$ARCH"
    if out=$("$dir/scripts/termote.sh" health 2>&1); then
        fail "missing binary" "non-zero exit" "exit 0"
    elif echo "$out" | grep -q "reinstall Termote"; then
        pass "missing binary fails with a reinstall hint"
    else
        fail "missing binary message" "reinstall hint" "$out"
    fi

    printf '%s\n' '#!/bin/bash' 'exit 7' >"$dir/tmux-api-$OS-$ARCH"
    chmod +x "$dir/tmux-api-$OS-$ARCH"
    "$dir/scripts/termote.sh" health
    check "passes the exit status through" "7" "$?"
}

test_checkout() {
    echo ""
    echo "=== Checkout (dev build) ==="
    local dir="$TMP/checkout" out
    mkdir -p "$dir/scripts" "$dir/tmux-api"
    cp "$SHIM" "$dir/scripts/termote.sh"
    printf 'module echoargs\n\ngo 1.24\n' >"$dir/tmux-api/go.mod"
    cat >"$dir/tmux-api/main.go" <<'EOF'
package main

import (
	"fmt"
	"os"
)

func main() {
	fmt.Println("DIR=" + os.Getenv("TERMOTE_PROJECT_DIR"))
	for _, a := range os.Args[1:] {
		fmt.Println(a)
	}
}
EOF

    # Without Go and without a binary there is nothing to run
    if out=$(PATH="/usr/bin:/bin" "$dir/scripts/termote.sh" version 2>&1); then
        if command -v go 2>/dev/null | grep -qE '^/(usr/)?bin/'; then
            skip "go lives in /usr/bin or /bin; cannot hide it"
        else
            fail "no go, no binary" "non-zero exit" "exit 0"
        fi
    elif echo "$out" | grep -q "Go is required"; then
        pass "no go and no binary: asks for Go"
    else
        fail "no go message" "Go is required" "$out"
    fi

    if ! command -v go >/dev/null 2>&1; then
        skip "go not installed; checkout build tests"
        return
    fi
    out=$("$dir/scripts/termote.sh" install native --mux herdr 2>"$TMP/build.err")
    check "builds tmux-api-native on first run" "install native --mux herdr" "$(args_of "$out")"
    if grep -q "Building tmux-api" "$TMP/build.err" && [[ -x "$dir/tmux-api/tmux-api-native" ]]; then
        pass "build message on stderr, binary in tmux-api/"
    else
        fail "first build" "tmux-api/tmux-api-native" "$(cat "$TMP/build.err")"
    fi

    "$dir/scripts/termote.sh" version >/dev/null 2>"$TMP/build.err"
    if grep -q "Building" "$TMP/build.err"; then
        fail "up-to-date binary" "no rebuild" "rebuilt"
    else
        pass "does not rebuild an up-to-date binary"
    fi

    sleep 1
    touch "$dir/tmux-api/main.go"
    "$dir/scripts/termote.sh" version >/dev/null 2>"$TMP/build.err"
    if grep -q "Building" "$TMP/build.err"; then pass "rebuilds when a source is newer"; else fail "stale binary" "rebuild" "no rebuild"; fi
}

test_real_binary() {
    echo ""
    echo "=== Real CLI through the shim ==="
    if ! command -v go >/dev/null 2>&1 && [[ ! -x "$PROJECT_DIR/tmux-api/tmux-api-native" ]]; then
        skip "go not installed"
        return
    fi
    local out
    out=$("$SHIM" version 2>/dev/null)
    if [[ "$out" =~ ^Termote\ v[0-9] ]]; then pass "version: $out"; else fail "version" "Termote vX.Y.Z" "$out"; fi
    out=$("$SHIM" help 2>/dev/null)
    if echo "$out" | grep -q "show-password"; then pass "help lists show-password"; else fail "help" "show-password" "missing"; fi
}

test_syntax
test_installed_release
test_checkout
test_real_binary

echo ""
echo "=== Results ==="
echo -e "Passed: ${GREEN}$PASSED${NC}"
echo -e "Failed: ${RED}$FAILED${NC}"
[[ $FAILED -eq 0 ]]
