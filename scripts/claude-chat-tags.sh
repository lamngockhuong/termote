#!/bin/bash
# Checks the Chat view against what Claude Code writes as the user. Claude
# Code wraps plumbing (a ! command, a slash command's output, a task notice)
# in tags; server/agent_claude.go turns each into a note or drops it, and a
# tag it does not know shows raw as the user's speech. Run after a Claude
# Code update:
#
#   scripts/claude-chat-tags.sh [webview/index.js]
#
# 1. Lists the tags the VS Code extension's chat recognises that
#    classifyClaudeUserText does not name. The bundle is minified, so the
#    list is a lead to read, not a verdict; the extension is found under
#    ~/.vscode-server or ~/.vscode unless its index.js is given.
# 2. Runs TestClaudeTranscriptEnvelopes over this machine's transcripts
#    ($CLAUDE_CONFIG_DIR/projects, else ~/.claude/projects) and fails when a
#    tag in them still shows raw.
set -eo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/server/agent_claude.go"
status=0

# match prints what a pattern finds and, unlike grep, does not fail on none:
# an empty list is reported below rather than ending the script.
match() { grep -oE "$@" || true; }

# Tags the bundle names that never reach a terminal session's chat as an
# envelope of their own:
#   inner parts read through their outer tag; tags VS Code adds itself
#   (an editor selection, open file, diagnostics, browser); HTML and other
#   strings the extraction picks up.
IGNORE="command-args command-contents skill-format task-id task-type tool-use-id
  bash-exit-code persisted-output forked-skill-launch fork-boilerplate tool_use_error
  ide_selection ide_opened_file ide_diagnostics browser_instruction
  anonymous br div img input no_session p pre remove script span svg synthetic u"

WEBVIEW="$1"
if [ -z "$WEBVIEW" ]; then
  WEBVIEW="$(ls -dt "$HOME"/.vscode-server/extensions/anthropic.claude-code-*/webview/index.js \
    "$HOME"/.vscode/extensions/anthropic.claude-code-*/webview/index.js 2>/dev/null | head -1 || true)"
fi

if [ -f "$WEBVIEW" ]; then
  echo "Extension: $WEBVIEW"
  ext="$({
    match '"<[a-z][a-z0-9_-]*' "$WEBVIEW" | cut -c3-
    match 'var [^;]*"(command-name|task-notification|teammate-message|remote-review)"[^;]*;' "$WEBVIEW" |
      match '"[a-z][a-z0-9_]*(-[a-z0-9_]+)+"' | tr -d '"'
    match '"(artifact|cowritten)-[a-z-]+"' "$WEBVIEW" | tr -d '"'
  } | sort -u)"
  # Every quoted tag name from classifyClaudeUserText to the envelope regexp.
  ours="$(sed -n '/^func classifyClaudeUserText/,/^var claudeEnvelopeRe/p' "$SRC" |
    match '"[a-z][a-z0-9_]*(-[a-z0-9_]+)*"' | tr -d '"' | sort -u)"
  if ! grep -qx 'command-name' <<<"$ext"; then
    echo "error: no command-name tag found in the extension: its bundle changed, compare by hand" >&2
    status=1
  fi
  if [ -z "$ours" ]; then
    echo "error: no tag read from classifyClaudeUserText in $SRC" >&2
    status=1
  fi
  if [ "$status" = 0 ]; then
    # The extension's tags, less the ignored ones, less ours.
    missing="$(comm -23 <(comm -23 <(echo "$ext") <(tr -s ' \n' '\n' <<<"$IGNORE" | sort -u)) <(echo "$ours"))"
    if [ -n "$missing" ]; then
      echo "Known to the extension, not handled by Termote:"
      sed 's/.*/  <&>/' <<<"$missing"
    else
      echo "Every tag the extension knows is handled."
    fi
  fi
else
  echo "No Claude Code VS Code extension found; skipping the comparison."
fi

PROJECTS="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects"
if [ ! -d "$PROJECTS" ]; then
  echo "No transcripts in $PROJECTS; skipping the scan."
  exit "$status"
fi
echo "Scanning $PROJECTS"
cd "$ROOT/server"
TERMOTE_CLAUDE_PROJECTS="$PROJECTS" go test -count=1 -run '^TestClaudeTranscriptEnvelopes$' -v . |
  grep -E 'user rows read|shows raw|^(ok|FAIL|---)'
exit "$status"
