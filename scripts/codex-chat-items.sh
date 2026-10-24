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
#    that server/agent_codex.go neither reads (codexEventNames,
#    codexLegacyItems) nor knowingly skips (codexSkippedEvents).
# 3. TestCodexRolloutItems over this machine's rollouts ($CODEX_HOME/sessions,
#    else ~/.codex/sessions), failing on an item or event still not read.
#
# Run after a Codex update. Needs curl; the version defaults to `codex --version`.
set -eo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
status=0

# match prints what a pattern finds and, unlike grep, does not fail on none:
# an empty list is reported by `need` rather than ending the script.
match() { grep -oE "$@" || true; }

# need fails the run when a list read from the Codex source or from the Go
# code came out empty: the layout changed and the comparison would lie.
need() {
  if [ ! -s "$TMP/$1" ]; then
    echo "error: read no $2; the source layout changed, compare by hand" >&2
    status=1
    return 1
  fi
}

VERSION="$1"
if [ -z "$VERSION" ] && command -v codex >/dev/null 2>&1; then
  VERSION="$(codex --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if [ -n "$VERSION" ]; then
  echo "Codex source: rust-v$VERSION"
  BASE="https://raw.githubusercontent.com/openai/codex/rust-v$VERSION/codex-rs"
  # One curl reuses the connection for the three files.
  curl -fsSL "$BASE/protocol/src/items.rs" -o "$TMP/items.rs" \
    "$BASE/protocol/src/protocol.rs" -o "$TMP/protocol.rs" \
    "$BASE/rollout/src/policy.rs" -o "$TMP/policy.rs"

  # TurnItem variants against codexItemTypes.
  # A variant is a tuple (Foo(…)), a struct (Foo { … }) or a unit (Foo,).
  sed -n '/^pub enum TurnItem {/,/^}/p' "$TMP/items.rs" |
    match '^ +[A-Z][A-Za-z]+ *[({,]' | tr -d ' ({,' | sort -u >"$TMP/items"
  sed -n '/^var codexItemTypes = /,/^}/p' "$ROOT/server/agent_codex.go" |
    match '"[A-Za-z]+"' | tr -d '"' | sort -u >"$TMP/ours-items"
  if need items "TurnItem variant from items.rs" && need ours-items "codexItemTypes from agent_codex.go"; then
    missing="$(comm -23 "$TMP/items" "$TMP/ours-items")"
    if [ -n "$missing" ]; then
      echo "TurnItem variants not read:"
      sed 's/^/  /' <<<"$missing"
    else
      echo "Every TurnItem variant is read."
    fi
  fi

  # Wire name of each EventMsg variant: its serde rename, else snake_case.
  sed -n '/^pub enum EventMsg {/,/^}/p' "$TMP/protocol.rs" | awk '
    match($0, /rename = "[a-z_]+"/) { rename = substr($0, RSTART + 10, RLENGTH - 11); next }
    match($0, /^ +[A-Z][A-Za-z]+[(,]/) {
      v = substr($0, RSTART, RLENGTH - 1); gsub(/ /, "", v)
      if (rename == "") for (i = 1; i <= length(v); i++) {
        c = substr(v, i, 1)
        rename = rename (i > 1 && c ~ /[A-Z]/ ? "_" : "") tolower(c)
      }
      print v, rename; rename = ""
    }' >"$TMP/events"
  # Persisted events: every EventMsg variant the policy names before the
  # transient (None) ones, by wire name.
  sed -n '/fn persisted_event_msg/,/Transient, non-durable/p' "$TMP/policy.rs" |
    match 'EventMsg::[A-Za-z]+' | cut -d: -f3 |
    awk 'NR == FNR { wire[$1] = $2; next } $1 in wire { print wire[$1] }' "$TMP/events" - |
    sort -u >"$TMP/persisted"
  {
    sed -n '/^var codexEventNames = /,/^}, slices/p' "$ROOT/server/agent_codex.go"
    sed -n '/^var codexSkippedEvents = /p' "$ROOT/server/agent_codex.go"
    sed -n '/^var codexLegacyItems = /,/^}/p' "$ROOT/server/agent_codex.go"
  } | match '"[a-z_]+"' | tr -d '"' | sort -u >"$TMP/ours-events"
  if need events "EventMsg variant from protocol.rs" && need persisted "persisted event from policy.rs" &&
    need ours-events "event lists from agent_codex.go"; then
    missing="$(comm -23 "$TMP/persisted" "$TMP/ours-events")"
    if [ -n "$missing" ]; then
      echo "Persisted events neither read nor skipped:"
      sed 's/^/  /' <<<"$missing"
    else
      echo "Every persisted event is read or knowingly skipped."
    fi
  fi
else
  echo "No Codex version (codex not found, none given); skipping the source comparison."
fi

SESSIONS="${CODEX_HOME:-$HOME/.codex}/sessions"
if [ ! -d "$SESSIONS" ]; then
  echo "No rollouts in $SESSIONS; skipping the scan."
  exit "$status"
fi
echo "Scanning $SESSIONS"
cd "$ROOT/server"
TERMOTE_CODEX_SESSIONS="$SESSIONS" go test -count=1 -run '^TestCodexRolloutItems$' -v . |
  grep -E 'event rows read| in [0-9]+ rows|^(ok|FAIL|---)'
exit "$status"
