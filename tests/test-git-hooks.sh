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
# A bare `lefthook run` by hand would replace these hooks with lefthook's own
has "lefthook.yml turns off lefthook's auto-install" "$PROJECT_DIR/lefthook.yml" '^no_auto_install: true$'

# A branch that changes a hook file runs none of them, in any case (none of these names is one
# main has in another case, so the cases hold on a case-insensitive file system too)
n=0
for f in lefthook.yml scripts/check-gofmt.sh scripts/staged-files.sh dprint.json docs/dprint.json .lefthook.toml lefthook-local.yml \
    .config/lefthook.yaml .npmrc pwa/.npmrc docs/.npmrc pnpm-workspace.yaml pwa/pnpm-workspace.yaml \
    .pnpmfile.cjs package.json pwa/package.json node_modules/x/evil pwa/node_modules/.bin/biome \
    .NPMRC Package.json PWA/Package.json LEFTHOOK-local.yml .Lefthook.toml .Config/Lefthook.yaml Docs/DPrint.json \
    Pnpm-Workspace.yaml .PnpmFile.cjs pwa/Node_Modules/x/evil web/NODE_MODULES/.bin/biome; do
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
# A name that is not plain ASCII: a case-insensitive file system can fold a Kelvin sign onto a k
g checkout -q -b contrib-unicode main
printf 'x\n' >"$REPO/lefthoo$(printf '\342\204\252')-local.yml"
g add -A && g commit --no-verify -qm "non-ASCII name"
hook pre-commit
check "a branch adding a non-ASCII name runs no lefthook" "" "$CALLS"
has "the skip names it as git quotes it" "$TMP/hook-stderr" '^  "lefthoo\\342\\204\\252-local.yml"$'
g checkout -q main
# A hook file under a non-ASCII name is in both lists: named once, quoted, even with quoting off
g checkout -q -b contrib-unicode-npmrc main
mkdir -p "$REPO/d$(printf '\303\251')" && printf 'x\n' >"$REPO/d$(printf '\303\251')/.npmrc"
g add -A && g commit --no-verify -qm "non-ASCII dir"
g config core.quotePath false
hook pre-commit
check "a hook file under a non-ASCII name is named once, quoted" "1 1" \
    "$(grep -c -- '/.npmrc' "$TMP/hook-stderr") $(grep -c '^  "d\\303\\251/.npmrc"$' "$TMP/hook-stderr")"
g config --unset core.quotePath
g checkout -q main
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
# On Windows a name holding a character cmd.exe reads is refused: pnpm exec and npx can run the
# command through a .cmd shim. Elsewhere it is passed on like any other.
WINBIN="$TMP/winbin"
mkdir -p "$WINBIN"
printf '#!/bin/sh\necho MINGW64_NT-10.0-26100\n' >"$WINBIN/uname"
chmod +x "$WINBIN/uname"
CMDMETA="$TMP/cmdmeta"
for c in '&' '%' '^' '!' '|' '<' '>' '(' ')'; do
    rm -rf "$CMDMETA" && mkdir -p "$CMDMETA"
    git -C "$CMDMETA" init -q -b main
    printf 'x\n' >"$CMDMETA/a${c}b.md"
    git -C "$CMDMETA" add -- .
    PATH="$WINBIN:$PATH" staged "$CMDMETA" --glob '**/*.md' "$TMP/args" 2>"$TMP/cmdmeta-err"
    check "staged-files on Windows refuses a name holding $c" "1 no" \
        "$STAGED_STATUS $([[ -e "$ARGS_OUT" ]] && echo yes || echo no)"
    staged "$CMDMETA" --glob '**/*.md' "$TMP/args"
    check "staged-files elsewhere passes a name holding $c" "0 ./a${c}b.md" "$STAGED_STATUS $(cat "$ARGS_OUT")"
done
has "staged-files on Windows says which name" "$TMP/cmdmeta-err" 'cannot check a)b.md on Windows'
# (the names under sub/: the name at the top holding $( ) is refused there)
PATH="$WINBIN:$PATH" staged "$STAGED/sub" --glob '*.md' --glob '*.mdx' "$TMP/args"
check "staged-files on Windows passes plain names" "0 2" "$STAGED_STATUS $(grep -c '^\./' "$ARGS_OUT")"
# Windows is also told by OS=Windows_NT and by busybox-w32's uname; a uname that fails or prints
# nothing counts as Windows rather than letting the name through.
rm -rf "$CMDMETA" && mkdir -p "$CMDMETA"
git -C "$CMDMETA" init -q -b main
printf 'x\n' >"$CMDMETA/a(b.md"
git -C "$CMDMETA" add -- .
OS=Windows_NT staged "$CMDMETA" --glob '**/*.md' "$TMP/args"
check "staged-files with OS=Windows_NT refuses a name holding (" "1 no" \
    "$STAGED_STATUS $([[ -e "$ARGS_OUT" ]] && echo yes || echo no)"
for u in 'echo Windows_NT' 'exit 1' 'true'; do
    UNAMEBIN="$TMP/unamebin"
    rm -rf "$UNAMEBIN" && mkdir -p "$UNAMEBIN"
    printf '#!/bin/sh\n%s\n' "$u" >"$UNAMEBIN/uname"
    chmod +x "$UNAMEBIN/uname"
    PATH="$UNAMEBIN:$PATH" staged "$CMDMETA" --glob '**/*.md' "$TMP/args"
    check "staged-files with a uname that runs '$u' refuses a name holding (" "1 no" \
        "$STAGED_STATUS $([[ -e "$ARGS_OUT" ]] && echo yes || echo no)"
done
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
# A command that runs go builds without cgo, so it compiles no C code a branch brings.
# cgo_missing <file>: the commands of a lefthook config that run go without CGO_ENABLED "0"
# (POSIX awk: mawk and BSD awk have no \<)
cgo_missing() {
    awk '
        function done() { if (name != "" && go && !nocgo) print name }
        /^    [A-Za-z0-9_-]+:$/ { done(); name = $1; go = 0; nocgo = 0; next }
        /^  [^ ]/ || /^[^ ]/ { done(); name = "" }
        name != "" && !/^ *#/ && /(^|[^A-Za-z0-9_])go[ \t]/ { go = 1 }
        name != "" && /^        CGO_ENABLED: "0"$/ { nocgo = 1 }
        END { done() }
    ' "$1"
}
check "lefthook.yml runs go only with CGO_ENABLED=0" "" "$(cgo_missing "$PROJECT_DIR/lefthook.yml")"
grep -v 'CGO_ENABLED' "$PROJECT_DIR/lefthook.yml" >"$TMP/lefthook-cgo.yml"
printf '    vet2:\n      run: |\n        go vet ./...\n' >>"$TMP/lefthook-cgo.yml"
check "the cgo check finds a go command without it" "vet-linux: vet-windows: vet-darwin: vet2:" \
    "$(cgo_missing "$TMP/lefthook-cgo.yml" | tr '\n' ' ' | sed 's/ $//')"

echo ""
echo -e "Passed: ${GREEN}$PASSED${NC}"
echo -e "Failed: ${RED}$FAILED${NC}"
[[ $FAILED -eq 0 ]]
