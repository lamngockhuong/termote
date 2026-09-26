#!/bin/bash
# Tests for scripts/get.sh, run end to end against a fake curl that serves a
# local release (tarball + checksums.txt) and a fake shim that logs its calls.
# Usage: make test-get

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$TEST_DIR")"
GET_SCRIPT="$PROJECT_DIR/scripts/get.sh"
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

check() {
    if [[ "$2" == "$3" ]]; then pass "$1"; else fail "$1" "$2" "$3"; fi
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
RELEASES="$TMP/releases" # releases/<version>/{tarball,checksums.txt}
FAKE_PATH="$TMP/bin"
mkdir -p "$RELEASES" "$FAKE_PATH"

sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | awk '{print $1}'; }

# Fake curl: GitHub API "latest" returns $FAKE_LATEST; release downloads come
# from $RELEASES; everything else fails like a 404 does with -f.
cat >"$FAKE_PATH/curl" <<'EOF'
#!/bin/bash
out="" url=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        -o) out="$2"; shift ;;
        -*) ;;
        *) url="$1" ;;
    esac
    shift
done
echo "$url" >>"$CURL_LOG"
case "$url" in
    */releases/latest) body=$(printf '{\n  "tag_name": "v%s",\n}\n' "$FAKE_LATEST") ;;
    */releases/download/v*)
        rest="${url#*/releases/download/v}"
        file="$RELEASES/${rest%%/*}/${rest#*/}"
        [[ -f "$file" ]] || exit 22
        if [[ -n "$out" ]]; then cp "$file" "$out"; exit 0; fi
        body=$(cat "$file") ;;
    *) exit 22 ;;
esac
if [[ -n "$out" ]]; then echo "$body" >"$out"; else echo "$body"; fi
EOF
chmod +x "$FAKE_PATH/curl"

# make_release <version> [checksums: good|bad|none]
make_release() {
    local v="$1" dir="$RELEASES/$1" stage="$TMP/stage/termote-v$1"
    mkdir -p "$dir" "$stage/scripts"
    # The shim logs each call; `help` lists `link` like the real CLI does.
    cat >"$stage/scripts/termote.sh" <<'EOF'
#!/bin/bash
echo "$*" >>"$SHIM_LOG"
[[ "$1" == "help" ]] && echo "  link              Create 'termote' global command"
exit 0
EOF
    chmod +x "$stage/scripts/termote.sh"
    echo "payload $v" >"$stage/README.md"
    tar czf "$dir/termote-v$v.tar.gz" -C "$TMP/stage" "termote-v$v"
    case "${2:-good}" in
        good) echo "$(sha256 "$dir/termote-v$v.tar.gz")  termote-v$v.tar.gz" >"$dir/checksums.txt" ;;
        bad) echo "0000000000000000000000000000000000000000000000000000000000000000  termote-v$v.tar.gz" >"$dir/checksums.txt" ;;
    esac
}

# run_get <case> [args...]: fresh HOME and install dir per case; sets
# INSTALL, SHIM_CALLS and STATUS.
run_get() {
    local name="$1"
    shift
    export HOME="$TMP/home-$name" TERMOTE_INSTALL_DIR="$TMP/home-$name/.termote"
    export SHIM_LOG="$TMP/shim-$name.log" CURL_LOG="$TMP/curl-$name.log" RELEASES FAKE_LATEST
    mkdir -p "$HOME"
    [[ -n "$SAVED_CONFIG" ]] && mkdir -p "$HOME/.termote" && printf '%s\n' "$SAVED_CONFIG" >"$HOME/.termote/config"
    : >"$SHIM_LOG"
    OUTPUT=$(PATH="$FAKE_PATH:$PATH" ${GET_WRAP:-} bash "$GET_SCRIPT" "$@" </dev/null 2>&1)
    STATUS=$?
    INSTALL="$TERMOTE_INSTALL_DIR"
    SHIM_CALLS=$(paste -sd';' - <"$SHIM_LOG")
}

FAKE_LATEST="1.0.0"
SAVED_CONFIG=""
make_release 1.0.0
make_release 1.0.0-rc.1
make_release 0.9.0 bad
make_release 0.8.0 none

test_syntax() {
    echo "=== Syntax ==="
    if bash -n "$GET_SCRIPT"; then pass "get.sh syntax valid"; else fail "syntax" "valid" "error"; fi
    if grep -qi ttyd "$GET_SCRIPT"; then fail "no ttyd" "none" "$(grep -i ttyd "$GET_SCRIPT" | head -1)"; else pass "no ttyd step"; fi
}

test_default_install() {
    echo ""
    echo "=== Install latest (--yes) ==="
    run_get default --yes
    check "exit status" "0" "$STATUS"
    check "extracts into the install dir" "payload 1.0.0" "$(cat "$INSTALL/README.md" 2>/dev/null)"
    check "writes .version" "1.0.0" "$(cat "$INSTALL/.version" 2>/dev/null)"
    check "installs native, then links" "install native;help;link" "$SHIM_CALLS"
    if echo "$OUTPUT" | grep -q "Checksum verified"; then pass "verifies the checksum"; else fail "checksum" "verified" "$OUTPUT"; fi
    if ls "$INSTALL"/*.tar.gz >/dev/null 2>&1; then fail "tarball cleanup" "none left" "tarball in install dir"; else pass "leaves no tarball behind"; fi
}

test_install_flags() {
    echo ""
    echo "=== Mode and pass-through flags ==="
    run_get flags --yes --container --lan --allow-host box.local
    check "container mode with flags" "install container --lan --allow-host box.local;help;link" "$SHIM_CALLS"
    run_get positional -y native --mux herdr
    check "positional mode" "install native --mux herdr;help;link" "$SHIM_CALLS"
}

test_download_only() {
    echo ""
    echo "=== --download-only ==="
    run_get download --download-only
    check "exit status" "0" "$STATUS"
    check "extracts" "payload 1.0.0" "$(cat "$INSTALL/README.md" 2>/dev/null)"
    check "does not run the CLI" "" "$SHIM_CALLS"
}

test_version_pin() {
    echo ""
    echo "=== --version ==="
    run_get pin --yes --version v1.0.0-rc.1
    check "installs a pre-release" "1.0.0-rc.1" "$(cat "$INSTALL/.version" 2>/dev/null)"
    if grep -q "releases/latest" "$CURL_LOG"; then fail "pinned version" "no latest lookup" "looked up latest"; else pass "skips the latest lookup"; fi
    run_get badpin --yes --version 1.0
    if [[ $STATUS -ne 0 ]] && echo "$OUTPUT" | grep -q "Invalid version format"; then pass "rejects an invalid version"; else fail "invalid version" "error" "$OUTPUT"; fi
    run_get missing --yes --version 2.0.0
    if [[ $STATUS -ne 0 && -z "$SHIM_CALLS" ]]; then pass "missing release fails before install"; else fail "missing release" "error" "status $STATUS"; fi
}

test_checksums() {
    echo ""
    echo "=== Checksums ==="
    run_get mismatch --yes --version 0.9.0
    if [[ $STATUS -ne 0 ]] && echo "$OUTPUT" | grep -q "Checksum mismatch"; then pass "mismatch fails"; else fail "mismatch" "error" "$OUTPUT"; fi
    check "mismatch extracts nothing" "false" "$([[ -e "$INSTALL/README.md" ]] && echo true || echo false)"
    check "mismatch runs nothing" "" "$SHIM_CALLS"

    run_get nosums --yes --version 0.8.0
    check "missing checksums only warn" "0" "$STATUS"
    if echo "$OUTPUT" | grep -q "skipping verification"; then pass "warns about skipped verification"; else fail "warning" "skipping verification" "$OUTPUT"; fi
    run_get strict --yes --strict --version 0.8.0
    if [[ $STATUS -ne 0 && -z "$SHIM_CALLS" ]]; then pass "--strict requires checksums"; else fail "--strict" "error" "status $STATUS"; fi
}

test_update() {
    echo ""
    echo "=== --update ==="
    SAVED_CONFIG='TERMOTE_MODE="container"
TERMOTE_LAN="true"'
    run_get update --update
    check "uses the saved mode; install merges the rest" "install container;help;link" "$SHIM_CALLS"
    run_get update-mode --update --native
    check "explicit mode wins" "install native;help;link" "$SHIM_CALLS"
    SAVED_CONFIG=""
    run_get update-noconfig --update
    if [[ $STATUS -ne 0 ]] && echo "$OUTPUT" | grep -q "No saved config"; then pass "--update without config fails"; else fail "--update without config" "error" "$OUTPUT"; fi
    check "--update without config runs nothing" "" "$SHIM_CALLS"
}

test_prompt() {
    echo ""
    echo "=== Prompt ==="
    # Without a controlling tty the confirmation read fails, so nothing is
    # installed; setsid detaches it (skipped where setsid is missing).
    if command -v setsid >/dev/null 2>&1; then
        GET_WRAP="setsid" run_get prompt
        check "no confirmation, no install" "" "$SHIM_CALLS"
    else
        echo "SKIP: setsid not available; prompt test"
    fi
    run_get help --help
    if echo "$OUTPUT" | grep -q -- "--download-only" && [[ ! -e "$INSTALL" ]]; then pass "--help prints usage only"; else fail "--help" "usage" "$OUTPUT"; fi
}

test_syntax
test_default_install
test_install_flags
test_download_only
test_version_pin
test_checksums
test_update
test_prompt

echo ""
echo "=== Results ==="
echo -e "Passed: ${GREEN}$PASSED${NC}"
echo -e "Failed: ${RED}$FAILED${NC}"
[[ $FAILED -eq 0 ]]
