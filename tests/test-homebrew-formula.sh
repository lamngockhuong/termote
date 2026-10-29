#!/bin/bash
# Tests for scripts/homebrew-formula.sh: the formula it prints for a release's
# checksums.txt, and the inputs it refuses.
# Usage: make test-homebrew-formula

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$TEST_DIR")"
SCRIPT="$PROJECT_DIR/scripts/homebrew-formula.sh"
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

# contains passes when the formula holds the exact line.
contains() {
    if grep -qxF -- "$2" <<<"$FORMULA"; then pass "$1"; else fail "$1" "line '$2'" "missing"; fi
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

V=1.2.3
BASE="https://github.com/lamngockhuong/termote/releases/download/v$V"
H_DA=$(printf 'a%.0s' {1..64})
H_DI=$(printf 'b%.0s' {1..64})
H_LA=$(printf 'c%.0s' {1..64})
H_LI=$(printf 'd%.0s' {1..64})
cat >"$TMP/checksums.txt" <<EOF
$H_DI  termote-$V-darwin-amd64.tar.gz
$H_DA  termote-$V-darwin-arm64.tar.gz
$H_LI  termote-$V-linux-amd64.tar.gz
$H_LA  termote-$V-linux-arm64.tar.gz
$(printf 'e%.0s' {1..64})  termote-$V-windows-amd64.zip
$(printf 'f%.0s' {1..64})  image-digest.txt
EOF

FORMULA=$(sh "$SCRIPT" "$V" "$TMP/checksums.txt")
check "generates a formula" 0 $?
contains "class" "class Termote < Formula"
contains "darwin arm64 url" "      url \"$BASE/termote-$V-darwin-arm64.tar.gz\""
contains "darwin arm64 hash" "      sha256 \"$H_DA\""
contains "darwin amd64 url" "      url \"$BASE/termote-$V-darwin-amd64.tar.gz\""
contains "darwin amd64 hash" "      sha256 \"$H_DI\""
contains "linux arm64 url" "      url \"$BASE/termote-$V-linux-arm64.tar.gz\""
contains "linux arm64 hash" "      sha256 \"$H_LA\""
contains "linux amd64 url" "      url \"$BASE/termote-$V-linux-amd64.tar.gz\""
contains "linux amd64 hash" "      sha256 \"$H_LI\""
contains "installs the binary" '    bin.install "bin/termote"'
# brew audit --strict rejects a version the URL already gives.
check "no explicit version" 0 "$(grep -c '^  version ' <<<"$FORMULA")"
# Each archive's hash sits right under its own url.
check "hash follows its url" "      sha256 \"$H_LA\"" \
    "$(grep -A1 -F "termote-$V-linux-arm64.tar.gz" <<<"$FORMULA" | tail -1)"

if command -v ruby >/dev/null; then
    out=$(ruby -c <<<"$FORMULA" 2>&1)
    check "ruby -c accepts the formula" "Syntax OK" "$out"
else
    echo "SKIP: ruby -c (no ruby on PATH)"
fi

# refuses runs the script and passes when it exits non-zero with a message
# naming what is wrong.
refuses() {
    local name=$1 want=$2
    shift 2
    local err
    err=$(sh "$SCRIPT" "$@" 2>&1 >/dev/null)
    local code=$?
    if [[ $code -ne 0 && "$err" == *"$want"* ]]; then
        pass "$name"
    else
        fail "$name" "non-zero exit naming '$want'" "exit $code: $err"
    fi
}

grep -v linux-arm64 "$TMP/checksums.txt" >"$TMP/missing.txt"
refuses "missing archive line" "termote-$V-linux-arm64.tar.gz" "$V" "$TMP/missing.txt"
sed "s/^$H_DI/xyz/" "$TMP/checksums.txt" >"$TMP/bad.txt"
refuses "bad hash" "termote-$V-darwin-amd64.tar.gz" "$V" "$TMP/bad.txt"
refuses "pre-release version" "no pre-release" "$V-rc.1" "$TMP/checksums.txt"
refuses "two-line version" "no pre-release" "$V
x" "$TMP/checksums.txt"
refuses "two-part version" "no pre-release" "1.2" "$TMP/checksums.txt"
refuses "missing checksums file" "cannot read" "$V" "$TMP/nope.txt"
refuses "no arguments" "usage"

echo ""
echo "Passed: $PASSED, Failed: $FAILED"
[[ $FAILED -eq 0 ]]
