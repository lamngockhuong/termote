#!/bin/bash
# Tests for scripts/install.sh, run end to end against a fake curl that
# serves the tag list and release archives from a local directory, with a
# fake termote binary that logs its calls.
# Usage: make test-install

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$TEST_DIR")"
INSTALL_SCRIPT="$PROJECT_DIR/scripts/install.sh"
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
RELEASES="$TMP/releases" # releases/v<version>/<asset>
FAKE_PATH="$TMP/bin"
mkdir -p "$RELEASES" "$FAKE_PATH"

case "$(uname -s)" in Darwin) OS=darwin ;; *) OS=linux ;; esac
case "$(uname -m)" in aarch64 | arm64) ARCH=arm64 ;; *) ARCH=amd64 ;; esac

sha256() { if command -v sha256sum >/dev/null; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }

# Fake curl: the tag list comes from $FAKE_TAGS (HTTP $FAKE_TAGS_CODE),
# release downloads from $RELEASES; anything else fails like a 404 with -f.
cat >"$FAKE_PATH/curl" <<'EOF'
#!/bin/bash
out="" url="" write=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        -o) out="$2"; shift ;;
        -w) write="$2"; shift ;;
        -H | -K) shift ;;
        -*) ;;
        *) url="$1" ;;
    esac
    shift
done
echo "$url" >>"$CURL_LOG"
case "$url" in
    */tags\?per_page=100)
        code="${FAKE_TAGS_CODE:-200}"
        body="["
        for t in $FAKE_TAGS; do body="$body{\"name\":\"$t\",\"commit\":{\"sha\":\"x\"}},"; done
        echo "${body%,}]" >"$out"
        [[ -n "$write" ]] && printf '%s' "$code"
        exit 0 ;;
    */releases/download/*)
        file="$RELEASES/${url#*/releases/download/}"
        [[ -f "$file" ]] || exit 22
        cp "$file" "$out" ;;
    *) exit 22 ;;
esac
EOF
chmod +x "$FAKE_PATH/curl"

# make_release <version> [checksum: good|bad|none]
make_release() {
    local v="$1" name="termote-$1-$OS-$ARCH" dir="$RELEASES/v$1" stage="$TMP/stage"
    mkdir -p "$dir" "$stage/$name/bin"
    cat >"$stage/$name/bin/termote" <<EOF
#!/bin/bash
echo "$v \$*" >>"\$BIN_LOG"
EOF
    chmod +x "$stage/$name/bin/termote"
    echo "MIT" >"$stage/$name/LICENSE"
    tar czf "$dir/$name.tar.gz" -C "$stage" "$name"
    rm -rf "${stage:?}/$name"
    case "${2:-good}" in
        good) (cd "$dir" && sha256 "$name.tar.gz" >"$name.tar.gz.sha256") ;;
        bad) echo "$(printf '0%.0s' $(seq 64))  $name.tar.gz" >"$dir/$name.tar.gz.sha256" ;;
        none) rm -f "$dir/$name.tar.gz.sha256" ;;
    esac
}

# run_install [VAR=value...]: runs the installer in a fresh HOME; the output
# lands in $OUT and the exit status in $CODE.
run_install() {
    OUT=$(env -i HOME="$HOME_DIR" PATH="$FAKE_PATH:/usr/bin:/bin" CURL_LOG="$TMP/curl.log" BIN_LOG="$TMP/bin.log" RELEASES="$RELEASES" \
        FAKE_TAGS="${FAKE_TAGS:-}" FAKE_TAGS_CODE="${FAKE_TAGS_CODE:-}" "$@" sh "$INSTALL_SCRIPT" 2>&1)
    CODE=$?
}

new_home() {
    HOME_DIR="$TMP/home-$1"
    rm -rf "$HOME_DIR"
    mkdir -p "$HOME_DIR"
    DATA="$HOME_DIR/.local/share/termote"
    : >"$TMP/curl.log"
    : >"$TMP/bin.log"
}

test_syntax() {
    echo "=== Syntax ==="
    if sh -n "$INSTALL_SCRIPT"; then pass "install.sh is valid sh"; else fail "syntax" "valid" "error"; fi
    # Code only: the comments explain both.
    local code
    code=$(grep -v '^[[:space:]]*#' "$INSTALL_SCRIPT")
    if echo "$code" | grep -q 'sudo '; then fail "no sudo" "none" "sudo"; else pass "no sudo"; fi
    if echo "$code" | grep -q 'releases/latest'; then fail "tag list" "no releases/latest" "releases/latest"; else pass "does not use releases/latest"; fi
}

test_fresh_install() {
    echo ""
    echo "=== Fresh install picks the newest stable 1.x tag ==="
    new_home fresh
    make_release 1.0.1
    make_release 1.0.10
    FAKE_TAGS="v0.1.0 v1.0.1 v1.0.10 v1.0.2 v1.1.0-rc.1 latest" run_install
    check "exit status" "0" "$CODE"
    check "current points at 1.0.10" "versions/1.0.10" "$(readlink "$DATA/current")"
    [[ -x "$DATA/versions/1.0.10/bin/termote" && -f "$DATA/versions/1.0.10/LICENSE" ]] &&
        pass "archive laid down as versions/<v> (bin/termote, LICENSE)" || fail "layout" "bin/termote + LICENSE" "$(ls -R "$DATA")"
    check "links the command through the new binary" "1.0.10 link" "$(cat "$TMP/bin.log")"
    echo "$OUT" | grep -q "termote start" && pass "prints the next step" || fail "next step" "termote start" "$OUT"
    echo "$OUT" | grep -q "is not on your PATH" && pass "warns when ~/.local/bin is not on PATH" || fail "PATH hint" "warning" "$OUT"
    [[ -z "$(ls -A "$DATA" | grep -v -e '^versions$' -e '^current$')" ]] &&
        pass "no leftovers in the install dir" || fail "leftovers" "versions current" "$(ls -A "$DATA")"
}

test_existing_install() {
    echo ""
    echo "=== An existing install is left alone ==="
    # Reuses the fresh home.
    : >"$TMP/curl.log"
    FAKE_TAGS="v1.0.10" run_install
    check "exit status" "0" "$CODE"
    echo "$OUT" | grep -q "termote update" && pass "points at termote update" || fail "message" "termote update" "$OUT"
    check "nothing downloaded" "" "$(cat "$TMP/curl.log")"
}

test_pin_and_rescue() {
    echo ""
    echo "=== TERMOTE_VERSION pins a version and rescues an install ==="
    new_home pin
    make_release 1.0.0-rc.1
    run_install TERMOTE_VERSION=1.0.0-rc.1
    check "pinned pre-release installs" "versions/1.0.0-rc.1" "$(readlink "$DATA/current")"
    if grep -q "api.github.com" "$TMP/curl.log"; then fail "pin skips the lookup" "no API call" "API called"; else pass "pin skips the tag lookup"; fi

    # Rescue: lay 1.0.1 beside the install and point current at it...
    run_install TERMOTE_VERSION=v1.0.1
    check "rescue installs beside" "versions/1.0.1" "$(readlink "$DATA/current")"
    [[ -d "$DATA/versions/1.0.0-rc.1" ]] && pass "rescue keeps the other version" || fail "rescue" "old version kept" "removed"
    # ...and back, without a download when the version is on disk.
    : >"$TMP/curl.log"
    run_install TERMOTE_VERSION=1.0.0-rc.1
    check "rollback by pin" "versions/1.0.0-rc.1" "$(readlink "$DATA/current")"
    check "on-disk version is not downloaded" "" "$(cat "$TMP/curl.log")"
}

test_refusals() {
    echo ""
    echo "=== Refusals leave nothing behind ==="
    new_home bad
    run_install TERMOTE_VERSION=1.0
    [[ $CODE -ne 0 ]] && echo "$OUT" | grep -q "is not a version" && pass "malformed TERMOTE_VERSION" || fail "malformed" "refused" "$OUT"
    run_install TERMOTE_VERSION='1.0.0;rm -rf ~'
    [[ $CODE -ne 0 ]] && pass "TERMOTE_VERSION with shell characters refused" || fail "injection" "refused" "$OUT"

    make_release 2.0.0 bad
    run_install TERMOTE_VERSION=2.0.0
    [[ $CODE -ne 0 ]] && echo "$OUT" | grep -q "CHECKSUM MISMATCH" && pass "bad checksum refused" || fail "bad checksum" "refused" "$OUT"
    make_release 2.0.1 none
    run_install TERMOTE_VERSION=2.0.1
    [[ $CODE -ne 0 ]] && echo "$OUT" | grep -q "unverified" && pass "missing checksum refused" || fail "missing checksum" "refused" "$OUT"
    run_install TERMOTE_VERSION=9.9.9
    [[ $CODE -ne 0 ]] && echo "$OUT" | grep -q "still publishing" && pass "missing release explained" || fail "missing release" "refused" "$OUT"
    [[ ! -e "$DATA" ]] && pass "nothing written to the install dir" || fail "install dir" "absent" "$(ls -A "$DATA")"
    check "no binary ran" "" "$(cat "$TMP/bin.log")"

    FAKE_TAGS_CODE=403 FAKE_TAGS="v1.0.0" run_install
    [[ $CODE -ne 0 ]] && echo "$OUT" | grep -q "GH_TOKEN" && pass "rate limit names GH_TOKEN and TERMOTE_VERSION" || fail "rate limit" "hint" "$OUT"
    FAKE_TAGS="v0.1.0 v1.0.0-rc.1" run_install
    [[ $CODE -ne 0 ]] && echo "$OUT" | grep -q "no 1.x release" && pass "no stable 1.x release" || fail "no release" "refused" "$OUT"

    mkdir -p "$DATA" && echo x >"$DATA/other"
    run_install TERMOTE_VERSION=1.0.1
    [[ $CODE -ne 0 ]] && echo "$OUT" | grep -q "not a Termote install" && pass "foreign dir refused" || fail "foreign dir" "refused" "$OUT"
}

test_unsupported_platform() {
    echo ""
    echo "=== Unsupported platform ==="
    new_home plat
    cat >"$FAKE_PATH/uname" <<'EOF'
#!/bin/sh
case "$1" in -s) echo FreeBSD ;; *) echo x86_64 ;; esac
EOF
    chmod +x "$FAKE_PATH/uname"
    run_install TERMOTE_VERSION=1.0.1
    rm -f "$FAKE_PATH/uname"
    [[ $CODE -ne 0 ]] && echo "$OUT" | grep -q "publishes no binary for FreeBSD" && pass "unsupported OS refused" || fail "unsupported OS" "refused" "$OUT"
}

# The real binary: `termote link` publishes ~/.local/bin/termote pointing at
# current, and the installed command runs.
test_real_binary() {
    echo ""
    echo "=== Real termote binary ==="
    if ! command -v go >/dev/null 2>&1; then
        echo "SKIP: go not installed"
        return
    fi
    new_home real
    local v=1.2.3 name="termote-1.2.3-$OS-$ARCH" stage="$TMP/stage-real"
    mkdir -p "$stage/$name/bin" "$RELEASES/v$v"
    (cd "$PROJECT_DIR/server" && CGO_ENABLED=0 go build -o "$stage/$name/bin/termote" .) || { fail "build" "ok" "failed"; return; }
    echo MIT >"$stage/$name/LICENSE"
    tar czf "$RELEASES/v$v/$name.tar.gz" -C "$stage" "$name"
    (cd "$RELEASES/v$v" && sha256 "$name.tar.gz" >"$name.tar.gz.sha256")
    run_install TERMOTE_VERSION=$v
    check "exit status" "0" "$CODE"
    check "~/.local/bin/termote links current" "$DATA/current/bin/termote" "$(readlink "$HOME_DIR/.local/bin/termote")"
    local out
    out=$(HOME="$HOME_DIR" "$HOME_DIR/.local/bin/termote" version 2>&1)
    [[ "$out" =~ ^Termote\ v[0-9] ]] && pass "installed command runs: $out" || fail "installed command" "Termote vX" "$out"
}

test_syntax
test_real_binary
test_fresh_install
test_existing_install
test_pin_and_rescue
test_refusals
test_unsupported_platform

echo ""
echo "=== Results ==="
echo -e "Passed: ${GREEN}$PASSED${NC}"
echo -e "Failed: ${RED}$FAILED${NC}"
[[ $FAILED -eq 0 ]]
