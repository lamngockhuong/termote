#!/usr/bin/env bash
# Stands in for a Codex TUI run with --no-daemon in the chat view E2E (Linux
# only). termote takes a process for Codex when its executable is named
# codex, so run it under a copy of bash with that name:
#
#   cp "$(command -v bash)" "$tmp/codex"; "$tmp/codex" fake-codex.sh
#
# It writes what termote reads from a real Codex: a rollout
# <CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl shaped like
# server/testdata/codex, of a thread started by the user, and keeps it open
# for writing (fd 3) as the TUI does. Each line typed becomes a turn: the
# user message, then an echo reply, between task_started and task_complete.
#
# Environment: CODEX_HOME (required), FAKE_CODEX_SESSION (session id, default
# a fixed UUID).
set -u
export LC_ALL=C.UTF-8

home=${CODEX_HOME:?CODEX_HOME must be set}
sid=${FAKE_CODEX_SESSION:-01a0fbc2-4df0-7f32-864d-eb33100e552d}
started=$(date -u +%Y-%m-%dT%H-%M-%S)
dir="$home/sessions/$(date -u +%Y/%m/%d)"
rollout="$dir/rollout-$started-$sid.jsonl"
mkdir -p "$dir"
exec 3>>"$rollout"

json_str() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\n'/\\n}
  s=${s//$'\r'/\\r}
  s=${s//$'\t'/\\t}
  s=${s//[[:cntrl:]]/} # what is left (an arrow key's escape) is not valid in JSON
  printf '"%s"' "$s"
}

now() { date -u +%Y-%m-%dT%H:%M:%S.000Z; }

# Ids are counted here, not in a $(...) subshell, which would lose the count.
seq_n=0
next_id() { # prefix → $id
  seq_n=$((seq_n + 1))
  printf -v id '%s-%s-%04d' "$1" "${sid:0:23}" "$seq_n"
}

event() { # payload JSON
  printf '{"timestamp":"%s","type":"event_msg","payload":%s}\n' "$(now)" "$1" >&3
}

message() { # UserMessage | AgentMessage, content type, text
  next_id msg
  event "{\"type\":\"item_completed\",\"turn_id\":\"$turn\",\"item\":{\"type\":\"$1\",\"id\":\"$id\",\"content\":[{\"type\":\"$2\",\"text\":$(json_str "$3")}]}}"
}

turn=""
reply() { # user text, answer
  next_id turn
  turn=$id
  event "{\"type\":\"task_started\",\"turn_id\":\"$turn\"}"
  message UserMessage text "$1"
  message AgentMessage Text "$2"
  event "{\"type\":\"task_complete\",\"turn_id\":\"$turn\"}"
}

printf '{"timestamp":"%s","type":"session_meta","payload":{"id":"%s","timestamp":"%s","cwd":%s,"cli_version":"0.159.3","originator":"codex-tui","thread_source":"user","history_mode":"paginated"}}\n' \
  "$(now)" "$sid" "$(now)" "$(json_str "$PWD")" >&3
# A conversation to show before anything is typed
reply 'Count the files please' $'There are **2** files:\n\n- `a.txt`\n- `b.txt`'

trap 'exit 0' TERM HUP INT

# The terminal echoes and edits the line; Enter sends it.
while :; do
  printf '\n› '
  IFS= read -r line || exit 0
  [ -n "${line//[[:space:]]/}" ] || continue
  reply "$line" "You said: $line"
  printf '• You said: %s\n' "$line"
done
