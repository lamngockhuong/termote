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
# for writing (fd 3) as the TUI does. The screens it draws are the
# recordings the server's reader is tested with (server/testdata/codex/
# screens), so the two cannot drift apart.
#
#   idle        the composer, empty (its faint placeholder) or holding what
#               was typed or pasted into it; a path to an image file pasted
#               alone becomes "[Image #N] " (N restarts when the composer is
#               cleared, as in Codex), sent as a local_image part
#   Ctrl+C      clears the composer
#   Enter       records the draft as a user turn, then answers it:
#               "permission" in it opens the command approval dialog, the
#               turn running until it is answered; anything else gets an
#               echo reply
#   1/2/3, Esc  answer or cancel the open dialog
#
# Environment: CODEX_HOME (required), FAKE_CODEX_SESSION (session id, default
# a fixed UUID).
set -u
export LC_ALL=C.UTF-8

home=${CODEX_HOME:?CODEX_HOME must be set}
here=$(cd "$(dirname "$0")" && pwd)
screens="$here/../../server/testdata/codex/screens"
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
start_turn() { # user text, image paths
  local text=$1 parts="" p
  shift
  next_id turn
  turn=$id
  event "{\"type\":\"task_started\",\"turn_id\":\"$turn\"}"
  if [ $# -eq 0 ]; then
    message UserMessage text "$text"
    return
  fi
  for p in "$@"; do parts+="{\"type\":\"local_image\",\"path\":$(json_str "$p")},"; done
  next_id msg
  event "{\"type\":\"item_completed\",\"turn_id\":\"$turn\",\"item\":{\"type\":\"UserMessage\",\"id\":\"$id\",\"content\":[$parts{\"type\":\"text\",\"text\":$(json_str "$text")}]}}"
}
end_turn() { # answer
  message AgentMessage Text "$1"
  event "{\"type\":\"task_complete\",\"turn_id\":\"$turn\"}"
}

printf '{"timestamp":"%s","type":"session_meta","payload":{"id":"%s","timestamp":"%s","cwd":%s,"cli_version":"0.159.3","originator":"codex-tui","thread_source":"user","history_mode":"paginated"}}\n' \
  "$(now)" "$sid" "$(now)" "$(json_str "$PWD")" >&3
# A conversation to show before anything is typed
start_turn 'Count the files please'
end_turn $'There are **2** files:\n\n- `a.txt`\n- `b.txt`'

rows=24
size() {
  local s
  s=$(stty size 2>/dev/null) && rows=${s%% *}
  [ "$rows" -gt 8 ] 2>/dev/null || rows=24
}

idle_screen="$screens/0.159.3-input-empty.txt"
state=idle # idle | approval
draft=""
images=() # paths behind the draft's "[Image #N]" tokens
pasted="" # a bracketed paste, until its end

draw() {
  printf '\e[H\e[2J\e[3J'
  if [ $state = approval ]; then
    # The recording without its trailing blank rows: the footer is the last row.
    awk 'NF { for (; n; n--) print ""; print; next } { n++ }' "$screens/0.159.3-approval-exec.txt" | tail -n "$rows"
    return
  fi
  # Everything above the composer, the composer with the draft, the rows
  # under it, as recorded.
  local at lines=1 l first=1
  at=$(grep -n 'Ask Codex to do anything' "$idle_screen" | cut -d: -f1)
  [ -z "$draft" ] || lines=$(printf '%s\n' "$draft" | wc -l)
  head -n $((at - 1)) "$idle_screen" | tail -n $((rows - lines - 4))
  if [ -z "$draft" ]; then
    printf '\e[1m›\e[0m \e[2mAsk Codex to do anything\e[0m'
  else
    printf '\e[1m›\e[0m '
    while IFS= read -r l || [ -n "$l" ]; do
      [ $first = 1 ] || printf '\n  '
      printf '%s' "$l"
      first=0
    done <<<"$draft"
  fi
  printf '\n'
  tail -n +$((at + 1)) "$idle_screen"
}

submit() {
  local text=$draft n=${#images[@]}
  draft=""
  [ -n "${text//[[:space:]]/}" ] || { draw; return; }
  start_turn "$text" "${images[@]}"
  images=()
  case $text in
    *permission*) state=approval ;;
    *) if [ "$n" -gt 0 ]; then end_turn "You said: $text (images: $n)"; else end_turn "You said: $text"; fi ;;
  esac
  draw
}

# The end of a paste into the composer: a path to an image file, alone,
# becomes the agent's token (server/testdata/codex/screens/0.160.0-image-*).
paste_done() {
  local p=${pasted#\"}
  p=${p%\"}
  if [[ $p =~ ^/.*\.(png|jpg|gif|webp)$ ]] && [ -f "$p" ]; then
    images+=("$p")
    draft+="[Image #${#images[@]}] "
  else
    draft+=$pasted
  fi
  pasted=""
}

answer() { # key
  case $1 in
    1) end_turn 'Approved: ran touch c.txt.' ;;
    2) end_turn 'Approved for this session.' ;;
    3 | esc) event "{\"type\":\"turn_aborted\",\"turn_id\":\"$turn\",\"reason\":\"interrupted\"}" ;;
    *) return ;;
  esac
  state=idle
  draw
}

restore() {
  printf '\e[?2004l'
  stty sane 2>/dev/null
}
trap restore EXIT
trap 'exit 0' TERM HUP
# Ctrl+C clears the input box, as in the agent: the pane's tty keeps isig
# (read -s restores it), so it arrives as SIGINT and ends the read below.
interrupted=0
trap 'interrupted=1' INT

# Keys one at a time, Enter as CR, output processing kept (LF → CRLF).
stty -icanon -echo -icrnl -isig -ixon min 1
printf '\e[?2004h' # bracketed paste, so a paste is told from typing
size
draw

pasting=0
while :; do
  if ! IFS= read -r -s -n1 -d '' -t 0.5 ch; then
    if [ $interrupted = 1 ]; then
      interrupted=0
      [ $state != idle ] || { draft="" && images=() && draw; }
      continue
    fi
    # No key: redraw when the pane was resized.
    old=$rows
    size
    [ "$old" = "$rows" ] || draw
    continue
  fi
  if [ "$ch" = $'\e' ]; then
    seq=""
    while IFS= read -r -s -n1 -d '' -t 0.05 c; do
      seq+=$c
      case $c in [~A-Za-z]) break ;; esac
    done
    case $seq in
      '[200~') pasting=1 ;;
      '[201~') pasting=0 && { [ $state != idle ] || paste_done; } && draw ;;
      '') [ $state = idle ] || answer esc ;;
    esac
    continue
  fi
  if [ $pasting = 1 ]; then
    case $state:$ch in
      idle:$'\r' | idle:$'\n') pasted+=$'\n' ;;
      idle:*) pasted+=$ch ;;
    esac
    continue
  fi
  case $state:$ch in
    idle:$'\r' | idle:$'\n') submit ;;
    idle:$'\x7f') draft=${draft%?} && draw ;;
    idle:$'\x03') draft="" && images=() && draw ;; # the same key as a byte, if it ever arrives as one
    idle:*) draft+=$ch && draw ;;
    *) answer "$ch" ;;
  esac
done
