#!/bin/bash
# Checks the Chat view against what Codex writes to a rollout. Codex is open
# source, so the lists come from its own code at the installed version's tag
# (rust-v<version> of github.com/openai/codex):
#
#   scripts/codex-chat-items.sh [version]
#
# 1. The TurnItem variants (codex-rs/protocol/src/items.rs) that
#    codexItemTypes in server/agent_codex.go does not read.
# 2. The events the rollout policy persists (codex-rs/rollout/src/policy.rs)
#    that server/agent_codex_test.go neither reads nor knowingly skips.
# 3. TestCodexRolloutItems over this machine's rollouts ($CODEX_HOME/sessions,
#    else ~/.codex/sessions), failing on an item or event still not read.
#
# Run after a Codex update. Needs curl; the version defaults to `codex --version`.
set -eo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

VERSION="$1"
if [ -z "$VERSION" ] && command -v codex >/dev/null 2>&1; then
  VERSION="$(codex --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if [ -n "$VERSION" ]; then
  echo "Codex source: rust-v$VERSION"
  BASE="https://raw.githubusercontent.com/openai/codex/rust-v$VERSION/codex-rs"
  curl -fsSL "$BASE/protocol/src/items.rs" -o "$TMP/items.rs"
  curl -fsSL "$BASE/protocol/src/protocol.rs" -o "$TMP/protocol.rs"
  curl -fsSL "$BASE/rollout/src/policy.rs" -o "$TMP/policy.rs"

  # TurnItem variants against codexItemTypes.
  sed -n '/^pub enum TurnItem {/,/^}/p' "$TMP/items.rs" |
    grep -oE '^ +[A-Z][A-Za-z]+\(' | tr -d ' (' | sort -u >"$TMP/items"
  sed -n '/^var codexItemTypes = /,/^}/p' "$ROOT/server/agent_codex.go" |
    grep -oE '"[A-Za-z]+"' | tr -d '"' | sort -u >"$TMP/ours-items"
  missing="$(comm -23 "$TMP/items" "$TMP/ours-items")"
  if [ -n "$missing" ]; then
    echo "TurnItem variants not read:"
    sed 's/^/  /' <<<"$missing"
  else
    echo "Every TurnItem variant is read."
  fi

  # Wire name of each EventMsg variant: its serde rename, else snake_case.
  sed -n '/^pub enum EventMsg {/,/^}/p' "$TMP/protocol.rs" | awk '
    match($0, /rename = "[a-z_]+"/) { rename = substr($0, RSTART + 10, RLENGTH - 11); next }
    match($0, /^ +[A-Z][A-Za-z]+[(,]/) {
      v = substr($0, RSTART, RLENGTH - 1); gsub(/ /, "", v)
      print v, (rename != "" ? rename : "-"); rename = ""
    }' >"$TMP/events"
  # Persisted events: every EventMsg variant the policy names before the
  # transient (None) ones.
  sed -n '/^fn persisted_event_msg/,/Transient, non-durable/p' "$TMP/policy.rs" |
    grep -oE 'EventMsg::[A-Za-z]+' | cut -d: -f3 | sort -u |
    while read -r v; do
      wire="$(awk -v v="$v" '$1 == v { print $2 }' "$TMP/events")"
      if [ -z "$wire" ] || [ "$wire" = "-" ]; then
        wire="$(sed -E 's/([a-z0-9])([A-Z])/\1_\2/g' <<<"$v" | tr '[:upper:]' '[:lower:]')"
      fi
      echo "$wire"
    done | sort -u >"$TMP/persisted"
  {
    sed -n '/skipped := map\[string\]bool{/,/^\t}/p' "$ROOT/server/agent_codex_test.go"
    sed -n '/^var codexLegacyItems = /,/^}/p' "$ROOT/server/agent_codex.go"
  } | grep -oE '"[a-z_]+":' | tr -d '":' | sort -u >"$TMP/ours-events"
  missing="$(comm -23 "$TMP/persisted" "$TMP/ours-events")"
  if [ -n "$missing" ]; then
    echo "Persisted events neither read nor skipped:"
    sed 's/^/  /' <<<"$missing"
  else
    echo "Every persisted event is read or knowingly skipped."
  fi
else
  echo "No Codex version (codex not found, none given); skipping the source comparison."
fi

SESSIONS="${CODEX_HOME:-$HOME/.codex}/sessions"
if [ ! -d "$SESSIONS" ]; then
  echo "No rollouts in $SESSIONS; skipping the scan."
  exit 0
fi
echo "Scanning $SESSIONS"
cd "$ROOT/server"
TERMOTE_CODEX_SESSIONS="$SESSIONS" go test -count=1 -run '^TestCodexRolloutItems$' -v . |
  grep -E 'event rows read| in [0-9]+ rows|^(ok|FAIL|---)'
