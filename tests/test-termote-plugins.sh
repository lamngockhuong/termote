#!/bin/bash
# Tests for scripts/termote-plugins.sh: the marketplace it writes for a
# release, a second run over it, and the inputs it refuses.
# Usage: make test-termote-plugins

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$TEST_DIR")"
SCRIPT="$PROJECT_DIR/scripts/termote-plugins.sh"
SKILL="$PROJECT_DIR/server/skills/orchestrator/SKILL.md"
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

# json reads a value with python, the only JSON parser every runner has.
json() {
    python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); exec("print("+sys.argv[2]+")")' "$1" "$2" 2>&1
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
OUT="$TMP/repo"
mkdir -p "$OUT"
echo "kept" >"$OUT/LICENSE"

sh "$SCRIPT" 1.2.3 "$SKILL" "$OUT" 2>"$TMP/err"
check "writes the marketplace" "0" "$?"
for f in .claude-plugin/marketplace.json .agents/plugins/marketplace.json \
    plugins/termote/.claude-plugin/plugin.json plugins/termote/.codex-plugin/plugin.json; do
    if python3 -m json.tool "$OUT/$f" >/dev/null 2>&1; then pass "$f is JSON"; else fail "$f is JSON" "valid JSON" "$(cat "$OUT/$f")"; fi
done
check "Claude plugin version" "1.2.3" "$(json "$OUT/plugins/termote/.claude-plugin/plugin.json" 'd["version"]')"
check "Codex plugin version" "1.2.3" "$(json "$OUT/plugins/termote/.codex-plugin/plugin.json" 'd["version"]')"
check "Codex plugin skills" "./skills/" "$(json "$OUT/plugins/termote/.codex-plugin/plugin.json" 'd["skills"]')"
check "Claude marketplace source" "./plugins/termote" "$(json "$OUT/.claude-plugin/marketplace.json" 'd["plugins"][0]["source"]')"
check "Codex marketplace path" "./plugins/termote" "$(json "$OUT/.agents/plugins/marketplace.json" 'd["plugins"][0]["source"]["path"]')"
if cmp -s "$SKILL" "$OUT/plugins/termote/skills/termote-orchestrator/SKILL.md"; then pass "skill copied as it is"; else fail "skill copied as it is" "same file" "different"; fi
check "files it does not write stay" "kept" "$(cat "$OUT/LICENSE")"

sh "$SCRIPT" 1.2.4 "$SKILL" "$OUT" 2>"$TMP/err"
check "a second run" "0" "$?"
check "the version moves" "1.2.4" "$(json "$OUT/plugins/termote/.claude-plugin/plugin.json" 'd["version"]')"

# refuses passes when the script exits non-zero and says why.
refuses() {
    local name=$1 want=$2
    shift 2
    if out=$(sh "$SCRIPT" "$@" 2>&1); then
        fail "$name" "refused" "accepted"
    elif grep -qF -- "$want" <<<"$out"; then
        pass "$name"
    else
        fail "$name" "$want" "$out"
    fi
}

printf -- '---\nname: something-else\n---\n' >"$TMP/other.md"
refuses "pre-release version" "no pre-release" "1.2.3-rc.1" "$SKILL" "$OUT"
refuses "two-line version" "no pre-release" "1.2.3
x" "$SKILL" "$OUT"
refuses "two-part version" "no pre-release" "1.2" "$SKILL" "$OUT"
refuses "missing skill" "cannot read" 1.2.3 "$TMP/nope.md" "$OUT"
refuses "another skill" "does not name the termote-orchestrator skill" 1.2.3 "$TMP/other.md" "$OUT"
refuses "missing directory" "no directory" 1.2.3 "$SKILL" "$TMP/nope"
refuses "no arguments" "usage"

echo ""
echo "Passed: $PASSED, Failed: $FAILED"
[[ $FAILED -eq 0 ]]
