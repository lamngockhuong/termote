#!/bin/bash
# Test cases for herdr-plugin/bin/termote.sh (the Herdr plugin's launcher)
# Usage: make test-herdr-plugin

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$TEST_DIR")"
LAUNCHER="$PROJECT_DIR/herdr-plugin/bin/termote.sh"
MANIFEST="$PROJECT_DIR/herdr-plugin/herdr-plugin.toml"
PASSED=0
FAILED=0

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

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# fake_termote <path> <yes|no|broken>: a stand-in whose help lists `panel`
# (yes), does not (no, an old release) or fails (broken, a dev shim that
# cannot build). It records its arguments and exits with $FAKE_EXIT.
fake_termote() {
    mkdir -p "$(dirname "$1")"
    cat > "$1" <<EOF
#!/bin/sh
case "\$1" in
help) [ "$2" = broken ] && { echo "[ERROR] Go is required to build termote-dev" >&2; exit 1; }
    echo "Termote v1.5.0"; [ "$2" = yes ] && echo "  panel                Status, links and a QR code"; echo "  start" ;;
version) echo "Termote v1.3.0" ;;
*) echo "\$@" > "$WORK/args"; exit \${FAKE_EXIT:-0} ;;
esac
EOF
    chmod +x "$1"
}

# run_launcher <home> <args...>: runs it with a PATH holding only the basics,
# like Herdr's server; stdin is not a terminal (an action).
run_launcher() {
    local home="$1"
    shift
    rm -f "$WORK/args"
    HOME="$home" XDG_DATA_HOME= PATH="$WORK/sysbin:/usr/bin:/bin" sh "$LAUNCHER" "$@" > "$WORK/out" 2> "$WORK/err" < /dev/null
}

test_syntax() {
    echo "=== Syntax ==="
    if sh -n "$LAUNCHER"; then pass "launcher syntax valid"; else fail "syntax" "valid sh" "error"; fi
    if [ -x "$LAUNCHER" ]; then pass "launcher is executable"; else fail "mode" "executable" "not"; fi
}

test_finds_termote() {
    echo ""
    echo "=== Finding termote ==="
    mkdir -p "$WORK/sysbin"

    # ~/.local/bin, which Herdr's PATH lacks
    local h1="$WORK/h1"
    fake_termote "$h1/.local/bin/termote" yes
    run_launcher "$h1" url --herdr --open
    local code=$?
    if [ "$code" = 0 ] && [ "$(cat "$WORK/args" 2>/dev/null)" = "url --herdr --open" ]; then
        pass "~/.local/bin/termote runs with the arguments"
    else
        fail "~/.local/bin" "exit 0, args passed" "exit $code, $(cat "$WORK/args" 2>/dev/null)"
    fi

    # the install's current version, without `termote link`
    local h2="$WORK/h2"
    fake_termote "$h2/.local/share/termote/current/bin/termote" yes
    run_launcher "$h2" panel
    if [ "$(cat "$WORK/args" 2>/dev/null)" = "panel" ]; then
        pass "install's current/bin/termote is used"
    else
        fail "current/bin" "panel" "$(cat "$WORK/args" 2>/dev/null)"
    fi

    # PATH first
    local h3="$WORK/h3"
    fake_termote "$h3/.local/bin/termote" no
    fake_termote "$WORK/sysbin/termote" yes
    run_launcher "$h3" stop
    if [ "$(cat "$WORK/args" 2>/dev/null)" = "stop" ]; then
        pass "termote on PATH wins"
    else
        fail "PATH first" "stop" "$(cat "$WORK/args" 2>/dev/null) $(cat "$WORK/err")"
    fi
    rm -f "$WORK/sysbin/termote"

    # An old copy on PATH does not hide a current install.
    local h5="$WORK/h5"
    fake_termote "$WORK/sysbin/termote" no
    fake_termote "$h5/.local/share/termote/current/bin/termote" yes
    run_launcher "$h5" copy-check
    if [ "$(cat "$WORK/args" 2>/dev/null)" = "copy-check" ] && [ ! -s "$WORK/err" ]; then
        pass "old termote on PATH skipped for a current install"
    else
        fail "old on PATH" "install used" "$(cat "$WORK/args" 2>/dev/null) $(cat "$WORK/err")"
    fi
    rm -f "$WORK/sysbin/termote"

    # A path with spaces stays one path.
    local h6="$WORK/h 6"
    fake_termote "$h6/.local/bin/termote" yes
    run_launcher "$h6" stop
    if [ "$(cat "$WORK/args" 2>/dev/null)" = "stop" ]; then
        pass "a home with spaces works"
    else
        fail "spaces" "stop" "$(cat "$WORK/err")"
    fi
}

test_errors() {
    echo ""
    echo "=== Errors ==="
    run_launcher "$WORK/empty" panel
    local code=$?
    if [ "$code" = 127 ] && grep -q "termote was not found" "$WORK/err" && grep -q "install.sh" "$WORK/err"; then
        pass "missing termote: exit 127 with install hint"
    else
        fail "missing" "127 + hint" "$code $(cat "$WORK/err")"
    fi

    local old="$WORK/old"
    fake_termote "$old/.local/bin/termote" no
    run_launcher "$old" panel
    code=$?
    if [ "$code" = 1 ] && grep -q "Termote v1.3.0 is too old" "$WORK/err" && [ ! -f "$WORK/args" ]; then
        pass "old termote: refused with update hint, not run"
    else
        fail "too old" "exit 1, not run" "$code $(cat "$WORK/err")"
    fi

    local dev="$WORK/dev"
    fake_termote "$dev/.local/bin/termote" broken
    run_launcher "$dev" panel
    code=$?
    if [ "$code" = 1 ] && grep -q "termote failed to run" "$WORK/err" && grep -q "Go is required" "$WORK/err" &&
        ! grep -q "too old" "$WORK/err"; then
        pass "a dev shim that cannot build shows its own error, not 'too old'"
    else
        fail "broken shim" "exit 1 + shim error" "$code $(cat "$WORK/err")"
    fi

    fake_termote "$WORK/h4/.local/bin/termote" yes
    FAKE_EXIT=3 run_launcher "$WORK/h4" restart
    code=$?
    if [ "$code" = 3 ] && ! grep -q "Press Enter" "$WORK/out"; then
        pass "a failing command keeps its exit status; no prompt without a terminal"
    else
        fail "exit status" "3, no prompt" "$code $(cat "$WORK/out")"
    fi
}

test_open_panel() {
    echo ""
    echo "=== open-panel ==="
    cat > "$WORK/fake-herdr" <<EOF
#!/bin/sh
echo "\$@" > "$WORK/herdr-args"
EOF
    chmod +x "$WORK/fake-herdr"
    HERDR_BIN_PATH="$WORK/fake-herdr" HERDR_PLUGIN_ID=lamngockhuong.termote sh "$LAUNCHER" open-panel < /dev/null
    local got
    got="$(cat "$WORK/herdr-args" 2>/dev/null)"
    if [ "$got" = "plugin pane open --plugin lamngockhuong.termote --entrypoint panel" ]; then
        pass "open-panel opens the popup through HERDR_BIN_PATH"
    else
        fail "open-panel" "plugin pane open ..." "$got"
    fi
    rm -f "$WORK/herdr-args"
    env -u HERDR_PLUGIN_ID HERDR_BIN_PATH="$WORK/fake-herdr" sh "$LAUNCHER" open-panel < /dev/null
    if grep -q -- "--plugin lamngockhuong.termote --entrypoint panel" "$WORK/herdr-args" 2>/dev/null; then
        pass "open-panel defaults to the plugin's own id"
    else
        fail "open-panel default" "lamngockhuong.termote" "$(cat "$WORK/herdr-args" 2>/dev/null)"
    fi
}

test_manifest() {
    echo ""
    echo "=== Manifest ==="
    # Herdr refuses an id repeated among actions (or among panes), whatever
    # the platforms; an action and a pane may share one.
    local dup
    dup="$(awk '/^\[\[/ {kind=$0} /^id = / && kind != "" {print kind, $3}' "$MANIFEST" | sort | uniq -d)"
    if [ -z "$dup" ]; then pass "no repeated id"; else fail "ids" "unique" "$dup"; fi
    for id in panel open copy start stop restart; do
        if grep -q "^id = \"$id\"$" "$MANIFEST" && grep -q "^id = \"$id-windows\"$" "$MANIFEST"; then
            pass "$id has a Linux/macOS and a Windows entry"
        else
            fail "$id" "$id and $id-windows" "missing"
        fi
    done
    # Each entry runs what its id says, on the right platforms.
    local entries
    entries="$(awk '/^\[\[/ {id=""; plat=""} /^id = / {id=$3} /^platforms = / {plat=$0} /^command = / {print id "|" plat "|" $0}' "$MANIFEST" | tr -d '"')"
    for want in \
        'panel|platforms = [linux, macos]|command = [sh, bin/termote.sh, panel]' \
        'panel-windows|platforms = [windows]|command = [termote, panel]' \
        'open|platforms = [linux, macos]|command = [sh, bin/termote.sh, url, --herdr, --open]' \
        'open-windows|platforms = [windows]|command = [termote, url, --herdr, --open]' \
        'copy|platforms = [linux, macos]|command = [sh, bin/termote.sh, url, --herdr, --copy]' \
        'copy-windows|platforms = [windows]|command = [termote, url, --herdr, --copy]' \
        'start|platforms = [linux, macos]|command = [sh, bin/termote.sh, start]' \
        'stop-windows|platforms = [windows]|command = [termote, stop]' \
        'restart|platforms = [linux, macos]|command = [sh, bin/termote.sh, restart]'; do
        if printf '%s\n' "$entries" | grep -qxF "$want"; then
            pass "entry ${want%%|*}"
        else
            fail "entry ${want%%|*}" "$want" "missing"
        fi
    done
    if grep -q 'entrypoint", "panel-windows"' "$MANIFEST"; then
        pass "panel-windows action opens the Windows popup"
    else
        fail "panel-windows" "opens panel-windows" "other"
    fi
}

test_syntax
test_finds_termote
test_errors
test_open_panel
test_manifest

echo ""
echo -e "Passed: ${GREEN}$PASSED${NC}"
echo -e "Failed: ${RED}$FAILED${NC}"
[ "$FAILED" = 0 ]
