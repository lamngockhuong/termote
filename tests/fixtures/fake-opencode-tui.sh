#!/usr/bin/env bash
# Stands in for an OpenCode 2.x TUI in the E2E specs of an OpenCode pane
# (Linux only). termote takes a process for OpenCode when its executable is
# named opencode and reads the session it shows from its argv (--session
# <id>), so run it under a copy of bash with that name:
#
#   cp "$(command -v bash)" "$tmp/opencode"
#   "$tmp/opencode" fake-opencode-tui.sh --session ses_e2e
#
# Everything else comes from the service (pwa/e2e/fake-opencode.ts): this
# only draws a line and echoes what is typed, as a TUI would hold the pane.
set -u
printf 'OpenCode (stand-in) %s\n' "$*"
while IFS= read -r line; do
  printf 'typed: %s\n' "$line"
done
