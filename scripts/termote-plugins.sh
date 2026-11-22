#!/bin/sh
# Writes the lamngockhuong/termote-plugins marketplace for a stable release
# into a directory (a clone of that repository): the Claude Code and Codex
# marketplace files, the termote plugin's manifests at that version, and the
# orchestrator skill copied from server/skills/orchestrator/SKILL.md, which is
# the only copy anyone edits. Every file it writes is generated; a file of the
# repository it does not write (a LICENSE, the git history) is left alone.
# Usage: scripts/termote-plugins.sh <X.Y.Z> <SKILL.md> <dir>
set -eu

die() {
    echo "termote-plugins: $*" >&2
    exit 1
}

[ $# -eq 3 ] || die "usage: termote-plugins.sh <X.Y.Z> <SKILL.md> <dir>"
VERSION=$1
SKILL=$2
DIR=$3

# A case, not grep: grep matches line by line and would pass "1.2.3<newline>x".
case $VERSION in
'' | *[!0-9.]* | .* | *. | *..*) die "version must be X.Y.Z (no pre-release): $VERSION" ;;
esac
[ "$(printf '%s' "$VERSION" | tr -cd . | wc -c)" -eq 2 ] || die "version must be X.Y.Z (no pre-release): $VERSION"
[ -f "$SKILL" ] && [ -r "$SKILL" ] || die "cannot read $SKILL"
head -n 2 "$SKILL" | grep -qx 'name: termote-orchestrator' || die "$SKILL does not name the termote-orchestrator skill"
[ -d "$DIR" ] || die "no directory $DIR"

DESCRIPTION="Coordinate the coding agents in your termote panes from one Claude Code or Codex session: their status, a task for one of them, its answer, its dialogs, and a new agent. Needs termote (https://termote.ohnice.app) running natively."
REPO="https://github.com/lamngockhuong/termote-plugins"
HOME_URL="https://termote.ohnice.app"
KEYWORDS='["termote", "orchestrator", "agents", "tmux", "herdr", "zellij"]'

mkdir -p "$DIR/.claude-plugin" "$DIR/.agents/plugins" \
    "$DIR/plugins/termote/.claude-plugin" "$DIR/plugins/termote/.codex-plugin" \
    "$DIR/plugins/termote/skills/termote-orchestrator"

cat >"$DIR/.claude-plugin/marketplace.json" <<EOF
{
  "name": "termote",
  "description": "Termote plugins for coding agents",
  "owner": {
    "name": "Lam Ngoc Khuong"
  },
  "plugins": [
    {
      "name": "termote",
      "description": "$DESCRIPTION",
      "source": "./plugins/termote",
      "version": "$VERSION"
    }
  ]
}
EOF

cat >"$DIR/.agents/plugins/marketplace.json" <<EOF
{
  "name": "termote",
  "interface": {
    "displayName": "Termote"
  },
  "plugins": [
    {
      "name": "termote",
      "source": {
        "source": "local",
        "path": "./plugins/termote"
      },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL"
      },
      "category": "Productivity"
    }
  ]
}
EOF

cat >"$DIR/plugins/termote/.claude-plugin/plugin.json" <<EOF
{
  "name": "termote",
  "description": "$DESCRIPTION",
  "version": "$VERSION",
  "author": {
    "name": "Lam Ngoc Khuong"
  },
  "homepage": "$HOME_URL",
  "repository": "$REPO",
  "license": "MIT",
  "keywords": $KEYWORDS
}
EOF

cat >"$DIR/plugins/termote/.codex-plugin/plugin.json" <<EOF
{
  "name": "termote",
  "version": "$VERSION",
  "description": "$DESCRIPTION",
  "author": {
    "name": "Lam Ngoc Khuong"
  },
  "homepage": "$HOME_URL",
  "repository": "$REPO",
  "license": "MIT",
  "keywords": $KEYWORDS,
  "skills": "./skills/",
  "interface": {
    "displayName": "Termote",
    "shortDescription": "Coordinate the coding agents in your termote panes",
    "developerName": "Lam Ngoc Khuong",
    "category": "Productivity",
    "capabilities": ["Read"],
    "defaultPrompt": [
      "What are my termote agents doing?",
      "Ask the agent in the api pane to run the tests, then tell me what it found."
    ]
  }
}
EOF

cp "$SKILL" "$DIR/plugins/termote/skills/termote-orchestrator/SKILL.md"

cat >"$DIR/README.md" <<EOF
# Termote plugins

The termote plugin for Claude Code and Codex: a skill that coordinates the coding agents running
in your [termote]($HOME_URL) panes from one session. It needs termote installed and running
natively (\`termote start\`), at a release that has \`termote agents\`; the skill says when to update.

Generated from [lamngockhuong/termote](https://github.com/lamngockhuong/termote) at each release;
do not edit it here.

## Install

Claude Code:

\`\`\`
/plugin marketplace add lamngockhuong/termote-plugins
/plugin install termote@termote
\`\`\`

Codex:

\`\`\`bash
codex plugin marketplace add lamngockhuong/termote-plugins
codex plugin add termote@termote
\`\`\`

The same skill also comes with termote itself: \`termote skills install\`. Use one of the two,
not both, or the agent sees the skill twice.
EOF
