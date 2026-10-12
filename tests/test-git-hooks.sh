#!/bin/bash
# Tests for scripts/install-git-hooks.mjs (the root `prepare` script), run
# against a fake pnpm that logs its calls instead of installing hooks.
# Usage: make test-git-hooks

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$TEST_DIR")"
SCRIPT="$PROJECT_DIR/scripts/install-git-hooks.mjs"
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
FAKE_PATH="$TMP/bin"
REPO="$TMP/repo"
PLAIN="$TMP/plain" # not a git worktree
mkdir -p "$FAKE_PATH" "$REPO" "$PLAIN"
git -C "$REPO" init -q
export PNPM_LOG="$TMP/pnpm.log"

# Fake pnpm: logs its arguments, exits with $FAKE_PNPM_EXIT (default 0)
cat >"$FAKE_PATH/pnpm" <<'EOF'
#!/bin/sh
echo "$*" >>"$PNPM_LOG"
exit "${FAKE_PNPM_EXIT:-0}"
EOF
chmod +x "$FAKE_PATH/pnpm"

# The node binary itself: a version manager's shim (volta) can put its own
# directories ahead of PATH, where the real pnpm would win over the fake one
NODE="$(node -p process.execPath)"
# run <dir> [VAR=value ...]: runs the script in <dir> with only the given
# variables (CI runners set CI=true, which must not leak into a case)
run() {
    local dir="$1"
    shift
    rm -f "$PNPM_LOG"
    (cd "$dir" && env -u CI -u LEFTHOOK PATH="$FAKE_PATH:$PATH" "$@" "$NODE" "$SCRIPT" 2>"$TMP/stderr")
    STATUS=$?
    CALLS="$(cat "$PNPM_LOG" 2>/dev/null)"
}

run "$REPO"
check "installs in a git worktree" "exec lefthook install" "$CALLS"
check "exit status after an install" "0" "$STATUS"

run "$REPO" CI=true
check "CI=true skips" "" "$CALLS"
check "exit status when CI skips" "0" "$STATUS"

run "$REPO" CI=1 LEFTHOOK=1
check "CI with LEFTHOOK=1 installs" "exec lefthook install" "$CALLS"

run "$REPO" CI=false
check "CI=false installs" "exec lefthook install" "$CALLS"

run "$REPO" LEFTHOOK=0
check "LEFTHOOK=0 skips" "" "$CALLS"

run "$REPO" LEFTHOOK=false
check "LEFTHOOK=false skips" "" "$CALLS"

run "$PLAIN"
check "outside a git worktree skips" "" "$CALLS"
check "exit status outside a git worktree" "0" "$STATUS"

run "$REPO" FAKE_PNPM_EXIT=1
check "a failed install still exits 0" "0" "$STATUS"
if grep -q '\[WARN\] lefthook install failed' "$TMP/stderr"; then
    pass "a failed install warns"
else
    fail "a failed install warns" "[WARN] on stderr" "$(cat "$TMP/stderr")"
fi

echo ""
echo -e "Passed: ${GREEN}$PASSED${NC}"
echo -e "Failed: ${RED}$FAILED${NC}"
[[ $FAILED -eq 0 ]]
