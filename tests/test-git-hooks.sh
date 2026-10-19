#!/bin/bash
# Tests for scripts/install-git-hooks.mjs (the root `prepare` script) and the
# hooks it writes, run against a fake lefthook that logs its calls.
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

# has <name> <file> <pattern>: passes when the file holds the pattern
has() {
    if grep -q -- "$3" "$2"; then pass "$1"; else fail "$1" "$3 in $2" "$(cat "$2")"; fi
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
REPO="$TMP/repo"
PLAIN="$TMP/plain" # not a git worktree
mkdir -p "$REPO" "$PLAIN"
g() { git -C "$REPO" -c user.name=t -c user.email=t@t -c commit.gpgsign=false "$@"; }
g init -q -b main
printf 'pre-commit:\n' >"$REPO/lefthook.yml"
mkdir -p "$REPO/scripts"
printf '#!/bin/sh\n' >"$REPO/scripts/check-gofmt.sh"
printf '#!/bin/sh\n' >"$REPO/scripts/staged-files.sh"
printf '{}\n' >"$REPO/dprint.json"
printf 'node_modules/\n' >"$REPO/.gitignore"
g add -A && g commit --no-verify -qm base
HOOKS="$REPO/.git/hooks"
BIN="$REPO/node_modules/.bin"
mkdir -p "$BIN"
export LEFTHOOK_LOG="$TMP/lefthook.log"

# Fake lefthook: logs the config it was given and its arguments
cat >"$BIN/lefthook" <<'EOF'
#!/bin/sh
echo "$LEFTHOOK_CONFIG $*" >>"$LEFTHOOK_LOG"
EOF
chmod +x "$BIN/lefthook"

# The node binary itself: a version manager's shim (volta) can put its own
# directories ahead of PATH
NODE="$(node -p process.execPath)"
# run <dir> [VAR=value ...]: runs the script in <dir> with only the given
# variables (CI runners set CI=true, which must not leak into a case)
run() {
    local dir="$1"
    shift
    rm -f "$HOOKS/pre-commit" "$HOOKS/pre-push"
    (cd "$dir" && env -u CI -u LEFTHOOK "$@" "$NODE" "$SCRIPT" 2>"$TMP/stderr")
    STATUS=$?
}
installed() { [[ -x "$HOOKS/pre-commit" && -x "$HOOKS/pre-push" ]] && echo yes || echo no; }
# hook <name> [VAR=value ...]: runs an installed hook in the repo
hook() {
    local name="$1"
    shift
    rm -f "$LEFTHOOK_LOG"
    (cd "$REPO" && env -u LEFTHOOK "$@" "$HOOKS/$name" </dev/null 2>"$TMP/hook-stderr")
    HOOK_STATUS=$?
    CALLS="$(cat "$LEFTHOOK_LOG" 2>/dev/null)"
}

run "$REPO"
check "installs in a git worktree" "yes" "$(installed)"
check "exit status after an install" "0" "$STATUS"

run "$REPO" CI=true
check "CI=true skips" "no" "$(installed)"
check "exit status when CI skips" "0" "$STATUS"

run "$REPO" CI=1 LEFTHOOK=1
check "CI with LEFTHOOK=1 installs" "yes" "$(installed)"

run "$REPO" CI=false
check "CI=false installs" "yes" "$(installed)"

run "$REPO" LEFTHOOK=0
check "LEFTHOOK=0 skips" "no" "$(installed)"

run "$REPO" LEFTHOOK=false
check "LEFTHOOK=false skips" "no" "$(installed)"

run "$PLAIN"
check "outside a git worktree skips" "no" "$(installed)"
check "exit status outside a git worktree" "0" "$STATUS"

# A hook of the user's own is kept; one lefthook installed is replaced
run "$REPO"
printf '#!/bin/sh\necho mine\n' >"$HOOKS/pre-push"
(cd "$REPO" && env -u CI -u LEFTHOOK "$NODE" "$SCRIPT" 2>"$TMP/stderr")
check "a hook of the user's own is kept" "echo mine" "$(sed -n 2p "$HOOKS/pre-push")"
has "a kept hook warns" "$TMP/stderr" '\[WARN\].*pre-push is not a lefthook hook'
printf '#!/bin/sh\ncall_lefthook run "pre-push"\n' >"$HOOKS/pre-push"
(cd "$REPO" && env -u CI -u LEFTHOOK "$NODE" "$SCRIPT" 2>"$TMP/stderr")
has "a lefthook hook is replaced" "$HOOKS/pre-push" 'install-git-hooks.mjs'

# core.hooksPath (often one dir for every repository) gets nothing
g config core.hooksPath "$TMP/shared-hooks"
(cd "$REPO" && env -u CI -u LEFTHOOK "$NODE" "$SCRIPT" 2>"$TMP/stderr")
check "core.hooksPath gets no hooks" "no" "$([[ -e "$TMP/shared-hooks/pre-commit" ]] && echo yes || echo no)"
has "core.hooksPath warns" "$TMP/stderr" '\[WARN\] core.hooksPath is set'
g config --unset core.hooksPath

# A hooks dir that cannot be made: the install warns and still exits 0
mv "$HOOKS" "$TMP/hooks.kept" && printf 'x' >"$HOOKS"
(cd "$REPO" && env -u CI -u LEFTHOOK "$NODE" "$SCRIPT" 2>"$TMP/stderr")
check "a failed install still exits 0" "0" "$?"
has "a failed install warns" "$TMP/stderr" '\[WARN\] git hooks not installed'
rm "$HOOKS" && mv "$TMP/hooks.kept" "$HOOKS"

# While the hook files match main, a hook runs lefthook with the checked config
hook pre-commit
check "pre-commit runs lefthook on main" "$REPO/lefthook.yml run --no-auto-install pre-commit" "$CALLS"
hook pre-push
check "pre-push runs lefthook on main" "$REPO/lefthook.yml run --no-auto-install pre-push" "$CALLS"
hook pre-push LEFTHOOK=0
check "LEFTHOOK=0 runs nothing" "" "$CALLS"

# A branch that changes a hook file runs none of them
n=0
for f in lefthook.yml scripts/check-gofmt.sh scripts/staged-files.sh dprint.json docs/dprint.json .lefthook.toml lefthook-local.yml \
    .config/lefthook.yaml .npmrc pwa/.npmrc docs/.npmrc pnpm-workspace.yaml pwa/pnpm-workspace.yaml \
    .pnpmfile.cjs package.json pwa/package.json node_modules/x/evil pwa/node_modules/.bin/biome; do
    n=$((n + 1))
    g checkout -q -b "contrib-$n" main
    mkdir -p "$REPO/$(dirname "$f")"
    printf 'changed\n' >>"$REPO/$f"
    # -f: a branch can track a file under the ignored node_modules
    g add -f -- "$f" && g commit --no-verify -qm "change $f"
    hook pre-commit
    check "a branch changing $f runs no lefthook" "" "$CALLS"
    has "the skip names $f" "$TMP/hook-stderr" "^  $f\$"
    check "the skip lets the commit go on" "0" "$HOOK_STATUS"
    g checkout -q main
done
# A node_modules that is itself a tracked symlink, to a dir the branch tracks
g checkout -q -b contrib-link main
mkdir -p "$REPO/web/bin" && printf 'x\n' >"$REPO/web/bin/lefthook"
ln -s bin "$REPO/web/node_modules"
g add -f -- web/bin/lefthook web/node_modules && g commit --no-verify -qm "link node_modules"
hook pre-commit
check "a branch tracking a node_modules symlink runs no lefthook" "" "$CALLS"
has "the skip names the symlink" "$TMP/hook-stderr" "^  web/node_modules\$"
g checkout -q main
# An uncommitted change counts too
printf 'changed\n' >>"$REPO/lefthook.yml"
hook pre-push
check "an uncommitted lefthook.yml runs no lefthook" "" "$CALLS"
g checkout -q -- lefthook.yml

# origin/HEAD is trusted over main
g update-ref refs/remotes/origin/main main
g symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main
printf 'changed\n' >>"$REPO/dprint.json"
g commit --no-verify -qam "local only"
hook pre-commit
check "a change on main not on origin/HEAD runs no lefthook" "" "$CALLS"
has "the skip names origin/HEAD" "$TMP/hook-stderr" "differ from origin/HEAD"
g reset -q --hard origin/main

# No branch to trust, or no lefthook
g symbolic-ref -d refs/remotes/origin/HEAD
g update-ref -d refs/remotes/origin/main
g checkout -q -b other && g branch -qD main
hook pre-commit
check "no main runs no lefthook" "" "$CALLS"
has "no main says why" "$TMP/hook-stderr" "no origin/HEAD or main"
g branch -q main
rm "$BIN/lefthook"
hook pre-commit
has "no lefthook says so" "$TMP/hook-stderr" "lefthook is not installed"

# scripts/staged-files.sh hands the staged names to the command as arguments, never to a shell
HELPER="$PROJECT_DIR/scripts/staged-files.sh"
STAGED="$TMP/staged"
mkdir -p "$STAGED/sub"
s() { git -C "$STAGED" -c user.name=t -c user.email=t@t -c commit.gpgsign=false "$@"; }
s init -q -b main
printf 'x\n' >"$STAGED/gone.md" && s add gone.md && s commit --no-verify -qm base
s rm -q gone.md
for f in "x'\$(touch PWNED)'.md" "--config=evil.md" "sub/a b.md" "sub/c.mdx" "notes.txt"; do
    printf 'x\n' >"$STAGED/$f"
done
s add -- . && printf 'x\n' >"$STAGED/unstaged.md"
printf '#!/bin/sh\nfor a; do echo "$a"; done >"$ARGS_OUT"\n' >"$TMP/args"
chmod +x "$TMP/args"
export ARGS_OUT="$TMP/args-out"
staged() {
    rm -f "$ARGS_OUT"
    (cd "$1" && shift && sh "$HELPER" "$@")
    STAGED_STATUS=$?
}
staged "$STAGED" --glob '**/*.md' --glob '**/*.mdx' "$TMP/args"
check "staged-files passes the matching staged names" "./--config=evil.md
./sub/a b.md
./sub/c.mdx
./x'\$(touch PWNED)'.md" "$(cat "$ARGS_OUT")"
check "staged-files runs no name as code" "no" "$([[ -e "$STAGED/PWNED" ]] && echo yes || echo no)"
staged "$STAGED/sub" --glob '*.md' "$TMP/args"
check "staged-files names are relative to the current directory" "./a b.md" "$(cat "$ARGS_OUT")"
# git exports GIT_DIR to a hook in a linked worktree; the names stay relative to the current directory
GIT_DIR="$(s rev-parse --absolute-git-dir)" staged "$STAGED/sub" --glob '*.md' "$TMP/args"
check "staged-files names are relative with GIT_DIR set" "./a b.md" "$(cat "$ARGS_OUT" 2>/dev/null)"
staged "$STAGED" --glob '**/*.go' "$TMP/args"
check "staged-files runs nothing without a match" "no 0" \
    "$([[ -e "$ARGS_OUT" ]] && echo yes || echo no) $STAGED_STATUS"
staged "$STAGED" "$TMP/args" 2>/dev/null
check "staged-files without a pathspec is a usage error" "2" "$STAGED_STATUS"
# A name git has to quote is refused rather than passed on as a path that matches nothing
QUOTED="$TMP/quoted"
mkdir -p "$QUOTED"
git -C "$QUOTED" init -q -b main
printf 'x\n' >"$QUOTED/a\tb.md"
git -C "$QUOTED" add -- .
staged "$QUOTED" --glob '**/*.md' "$TMP/args" 2>"$TMP/quoted-err"
check "staged-files refuses a name git quotes" "1 no" \
    "$STAGED_STATUS $([[ -e "$ARGS_OUT" ]] && echo yes || echo no)"
has "staged-files says which name" "$TMP/quoted-err" 'cannot check "a\\tb.md"'
# Many names go in batches under the command-line limit, every name once
MANY="$TMP/many"
mkdir -p "$MANY"
git -C "$MANY" init -q -b main
long=$(printf '%0100d' 0)
for i in $(seq 1 150); do printf 'x\n' >"$MANY/$i-$long.md"; done
git -C "$MANY" add -- .
printf '#!/bin/sh\necho call >>"$ARGS_OUT"\nfor a; do echo "$a"; done >>"$ARGS_OUT"\n' >"$TMP/args-append"
chmod +x "$TMP/args-append"
staged "$MANY" --glob '*.md' "$TMP/args-append"
check "staged-files splits a long list" "3 150 0" \
    "$(grep -c '^call$' "$ARGS_OUT") $(grep -c '^\./' "$ARGS_OUT") $STAGED_STATUS"
check "lefthook.yml hands no file template to a command" "" \
    "$(grep -E '\{(staged_files|all_files|files|push_files)\}' "$PROJECT_DIR/lefthook.yml" | grep -v '^ *#')"

echo ""
echo -e "Passed: ${GREEN}$PASSED${NC}"
echo -e "Failed: ${RED}$FAILED${NC}"
[[ $FAILED -eq 0 ]]
