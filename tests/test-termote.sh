#!/bin/bash
# Tests for the scripts/termote.sh checkout shim: build on demand (Go sources
# and the PWA build), argument pass-through and exit status. The commands
# themselves are tested in Go (server/cli*_test.go).
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

# args_of <output>: the argument lines after DIR=
args_of() { echo "$1" | sed '1d' | paste -sd' ' -; }

# new_checkout <dir>: a checkout whose server/ is a Go program printing the
# project dir, then one argument per line, exiting with $ECHO_EXIT.
new_checkout() {
    mkdir -p "$1/scripts" "$1/server/webui/dist"
    cp "$SHIM" "$1/scripts/termote.sh"
    touch "$1/server/webui/dist/.gitkeep"
    printf 'module echoargs\n\ngo 1.24\n' >"$1/server/go.mod"
    cat >"$1/server/main.go" <<'EOF'
package main

import (
	"fmt"
	"os"
	"strconv"
)

func main() {
	fmt.Println("DIR=" + os.Getenv("TERMOTE_PROJECT_DIR"))
	for _, a := range os.Args[1:] {
		fmt.Println(a)
	}
	code, _ := strconv.Atoi(os.Getenv("ECHO_EXIT"))
	os.Exit(code)
}
EOF
}

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

test_not_a_checkout() {
    echo ""
    echo "=== Outside a checkout ==="
    local dir="$TMP/copy" out
    mkdir -p "$dir/scripts"
    cp "$SHIM" "$dir/scripts/termote.sh"
    if out=$("$dir/scripts/termote.sh" version 2>&1); then
        fail "no server/go.mod" "non-zero exit" "exit 0"
    elif echo "$out" | grep -q "not a Termote checkout"; then
        pass "refuses to run outside a checkout"
    else
        fail "outside a checkout message" "not a Termote checkout" "$out"
    fi
}

test_checkout() {
    echo ""
    echo "=== Checkout (dev build) ==="
    local dir="$TMP/checkout" out embed
    new_checkout "$dir"
    embed="$dir/server/webui/dist"

    # Without Go and without a binary there is nothing to run
    if out=$(PATH="/usr/bin:/bin" "$dir/scripts/termote.sh" version 2>&1); then
        # Check the same restricted PATH: a runner image can ship a system Go
        # in /usr/bin even when setup-go puts another one first on PATH
        if PATH="/usr/bin:/bin" command -v go >/dev/null 2>&1; then
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
    # Start from no binary: the check above builds one when a system Go exists
    rm -f "$dir/server/termote-dev"
    out=$("$dir/scripts/termote.sh" start --mux herdr 2>"$TMP/build.err")
    check "builds termote-dev on first run" "start --mux herdr" "$(args_of "$out")"
    if grep -q "Building termote" "$TMP/build.err" && [[ -x "$dir/server/termote-dev" ]]; then
        pass "build message on stderr, binary in server/"
    else
        fail "first build" "server/termote-dev" "$(cat "$TMP/build.err")"
    fi
    check "exports TERMOTE_PROJECT_DIR" "DIR=$dir" "$(echo "$out" | head -1)"

    # The binary opens the menu itself; the shim passes no argument.
    out=$("$dir/scripts/termote.sh" 2>/dev/null)
    check "no args passes none" "" "$(args_of "$out")"

    out=$("$dir/scripts/termote.sh" start --allow-host "my host" 2>/dev/null)
    check "keeps arguments with spaces" "my host" "$(echo "$out" | tail -1)"

    # The global command is a symlink; the shim must find the checkout
    ln -s "$dir/scripts/termote.sh" "$TMP/termote-link"
    out=$("$TMP/termote-link" version 2>/dev/null)
    check "resolves the global symlink" "DIR=$dir" "$(echo "$out" | head -1)"

    ECHO_EXIT=7 "$dir/scripts/termote.sh" health >/dev/null 2>&1
    check "passes the exit status through" "7" "$?"

    "$dir/scripts/termote.sh" version >/dev/null 2>"$TMP/build.err"
    if grep -q "Building" "$TMP/build.err"; then
        fail "up-to-date binary" "no rebuild" "rebuilt"
    else
        pass "does not rebuild an up-to-date binary"
    fi

    sleep 1
    touch "$dir/server/main.go"
    "$dir/scripts/termote.sh" version >/dev/null 2>"$TMP/build.err"
    if grep -q "Building" "$TMP/build.err"; then pass "rebuilds when a source is newer"; else fail "stale binary" "rebuild" "no rebuild"; fi

    # A newer PWA build is copied into server/webui/dist and embedded; the
    # previous copy (stale hashed assets) is removed, .gitkeep kept.
    touch "$embed/old-asset.js"
    mkdir -p "$dir/pwa/dist/assets"
    echo '{}' >"$dir/pwa/package.json"
    echo '<html>app</html>' >"$dir/pwa/dist/index.html"
    echo 'js' >"$dir/pwa/dist/assets/app.js"
    sleep 1
    touch "$dir/pwa/dist/index.html"
    "$dir/scripts/termote.sh" version >/dev/null 2>"$TMP/build.err"
    if grep -q "Building termote" "$TMP/build.err" && [[ -f "$embed/assets/app.js" && -f "$embed/.gitkeep" && ! -e "$embed/old-asset.js" ]]; then
        pass "rebuilds with a newer PWA build copied into webui/dist"
    else
        fail "PWA copy" "webui/dist synced" "$(ls -A "$embed" | paste -sd' ' -)"
    fi
}

test_real_binary() {
    echo ""
    echo "=== Real CLI through the shim ==="
    if ! command -v go >/dev/null 2>&1 && [[ ! -x "$PROJECT_DIR/server/termote-dev" ]]; then
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
test_not_a_checkout
test_checkout
test_real_binary

echo ""
echo "=== Results ==="
echo -e "Passed: ${GREEN}$PASSED${NC}"
echo -e "Failed: ${RED}$FAILED${NC}"
[[ $FAILED -eq 0 ]]
