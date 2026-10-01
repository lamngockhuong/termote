#!/usr/bin/env bash
# Stands in for Claude Code in the chat view E2E (Linux only: it records its
# start time from /proc, as Claude Code does).
#
# It writes what termote reads from a real Claude Code: a session file
# <CLAUDE_CONFIG_DIR>/sessions/<pid>.json (sessionId, status, procStart,
# pidDomain) and a transcript <CLAUDE_CONFIG_DIR>/projects/<cwd>/<id>.jsonl.
# The screens it draws are the recordings the server's detector is tested
# with (server/testdata/claude/screens), so the two cannot drift apart.
#
#   idle        the input box, empty or holding what was pasted into it
#   Enter       records the draft as a user turn, then answers it:
#               "permission" in it opens the Bash permission dialog,
#               "toppings" the multiSelect question (answerable only here),
#               "order" a wizard of two single-choice questions and Submit,
#               "extras" a wizard with a multiSelect tab (Milk toggles; the
#               arrows move between tabs along the recorded path),
#               anything else gets an echo reply
#   1/2/3, Esc  answer or cancel an open dialog (on a wizard, a digit answers
#               the tab open and moves to the next one)
#   ←/→         move between the tabs of a wizard
#
# Environment: CLAUDE_CONFIG_DIR (required), FAKE_CLAUDE_SESSION (session id,
# default a fixed UUID).
set -u
export LC_ALL=C.UTF-8

dir=${CLAUDE_CONFIG_DIR:?CLAUDE_CONFIG_DIR must be set}
here=$(cd "$(dirname "$0")" && pwd)
screens="$here/../../server/testdata/claude/screens"
sid=${FAKE_CLAUDE_SESSION:-6f1c2a4e-8b3d-4c5e-9f70-1a2b3c4d5e6f}
pid=$$

# Field 22 of /proc/<pid>/stat, counted after the command name.
stat=$(cat /proc/$pid/stat)
set -- ${stat##*) }
proc_start=${20}
domain=""
if [ -r /etc/machine-id ]; then
  domain="linux:$(tr -d '\n' </etc/machine-id):$(readlink /proc/$pid/ns/pid)"
fi

project="$dir/projects/$(printf '%s' "$PWD" | tr -c 'A-Za-z0-9' '-')"
journal="$project/$sid.jsonl"
mkdir -p "$dir/sessions" "$project"

json_str() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\n'/\\n}
  s=${s//$'\r'/\\r}
  s=${s//$'\t'/\\t}
  printf '"%s"' "$s"
}

set_status() {
  local f="$dir/sessions/$pid.json"
  printf '{"pid":%d,"sessionId":"%s","cwd":%s,"procStart":"%s","pidDomain":"%s","kind":"interactive","status":"%s"}\n' \
    "$pid" "$sid" "$(json_str "$PWD")" "$proc_start" "$domain" "$1" >"$f.tmp"
  mv "$f.tmp" "$f"
}

seq_n=0
entry() { # type, content JSON
  seq_n=$((seq_n + 1))
  printf '{"type":"%s","uuid":"%s-%04d","timestamp":"%s","message":{"role":"%s","content":%s}}\n' \
    "$1" "${sid:0:31}" "$seq_n" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" >>"$journal"
}
say() { entry assistant "[{\"type\":\"text\",\"text\":$(json_str "$1")}]"; }

# A conversation to show before anything is sent.
if [ ! -s "$journal" ]; then
  entry user "$(json_str 'Fix the build please')"
  entry assistant '[{"type":"text","text":"Running the tests."},{"type":"tool_use","id":"toolu_seed","name":"Bash","input":{"command":"npm test","description":"run tests"}}]'
  entry user '[{"type":"tool_result","tool_use_id":"toolu_seed","content":"1 passed"}]'
  say $'The build is **fixed**:\n\n- `npm test` passes'
fi

# Drawing. Rules in the recordings are 100 columns; they are cut or extended
# to the pane's width so a narrower pane does not wrap them.
cols=80
rows=24
rule() { # character, colour prefix
  local line="" i
  for ((i = 0; i < cols; i++)); do line+=$1; done
  printf '%s%s' "$2" "$line"
}
fit() { # stdin: recorded lines → lines with every rule fitted to the width
  local l
  while IFS= read -r l || [ -n "$l" ]; do
    case $l in
      *────────*) printf '%s\n' "${l%%─*}$(rule ─ '')${l##*─}" ;;
      *╌╌╌╌╌╌╌╌*) printf '%s\n' "${l%%╌*}$(rule ╌ '')${l##*╌}" ;;
      *) printf '%s\n' "$l" ;;
    esac
  done
}

# A dialog recording without its trailing blank rows, which would push the
# dialog's top edge off a short pane.
dialog() {
  fit <"$screens/$1" | awk 'NF { for (; n; n--) print ""; print; next } { n++ }'
}

idle_screen="$screens/2.1.286-idle-after-turn.txt"
state=idle # idle | permission | toppings | size | drink | submit | mixed | multi | multi_milk | after_multi | partial
draft=""

draw() {
  printf '\e[H\e[2J\e[3J'
  case $state in
    idle)
      # Everything above the box, the box with the draft, the status rows.
      local top
      top=$(grep -n '^.*────────' "$idle_screen" | head -1 | cut -d: -f1)
      head -n $((top - 1)) "$idle_screen" | tail -n $((rows - 9)) | fit
      rule ─ $'\e[38;5;244m'
      printf '\n\e[39m❯ '
      local first=1 l
      while IFS= read -r l || [ -n "$l" ]; do
        [ $first = 1 ] || printf '\n  '
        printf '%s' "$l"
        first=0
      done <<<"$draft"
      printf '\n'
      rule ─ $'\e[38;5;244m'
      printf '\n'
      tail -n 4 "$idle_screen"
      ;;
    permission) dialog 2.1.286-permission-bash.txt ;;
    toppings) dialog 2.1.286-ask-multi.txt ;;
    size) dialog 2.1.286-ask-wizard.txt ;;
    drink) dialog 2.1.286-ask-wizard-tab2.txt ;;
    submit) dialog 2.1.286-ask-wizard-submit.txt ;;
    mixed) dialog 2.1.286-ask-wizard-mixed.txt ;;
    multi) dialog 2.1.286-ask-wizard-multi-open.txt ;;
    multi_milk) dialog 2.1.286-ask-wizard-multi-toggled.txt ;;
    after_multi) dialog 2.1.286-ask-wizard-after-multi.txt ;;
    partial) dialog 2.1.286-ask-wizard-submit-partial.txt ;;
  esac
}

size() {
  local s
  s=$(stty size 2>/dev/null) || return
  rows=${s% *}
  cols=${s#* }
}

submit() {
  local text=$draft
  draft=""
  [ -n "${text//[[:space:]]/}" ] || { draw; return; }
  entry user "$(json_str "$text")"
  set_status busy
  draw
  sleep 0.3
  case $text in
    *permission*)
      entry assistant '[{"type":"tool_use","id":"toolu_touch","name":"Bash","input":{"command":"touch scratch-one.txt","description":"Create a file named scratch-one.txt"}}]'
      state=permission
      set_status waiting
      ;;
    *toppings*)
      state=toppings
      set_status waiting
      ;;
    *order*)
      state=size
      set_status waiting
      ;;
    *extras*)
      state=mixed
      set_status waiting
      ;;
    *)
      say "You said: $text"
      set_status idle
      ;;
  esac
  draw
}

answer() { # key
  case $state:$1 in
    permission:1 | permission:2)
      entry user '[{"type":"tool_result","tool_use_id":"toolu_touch","content":""}]'
      say 'Created scratch-one.txt.'
      ;;
    permission:3 | permission:esc)
      entry user '[{"type":"tool_result","tool_use_id":"toolu_touch","content":"The user doesn'"'"'t want to proceed with this tool use.","is_error":true}]'
      ;;
    size:1 | size:2) state=drink && draw && return ;;
    drink:1 | drink:2) state=submit && draw && return ;;
    submit:1) say 'Ordered: a small coffee.' ;;
    mixed:right | multi_milk:left) state=multi && draw && return ;;
    multi:left) state=mixed && draw && return ;;
    multi:2) state=multi_milk && draw && return ;;
    multi_milk:right) state=after_multi && draw && return ;;
    after_multi:right) state=partial && draw && return ;;
    partial:1) say 'Ordered extras: milk.' ;;
    toppings:esc | size:esc | drink:esc | submit:esc | submit:2) ;;
    mixed:esc | multi:esc | multi_milk:esc | after_multi:esc | partial:esc | partial:2) ;;
    *) return ;;
  esac
  state=idle
  set_status idle
  draw
}

restore() {
  printf '\e[?2004l'
  stty sane 2>/dev/null
  set_status idle
}
trap restore EXIT
trap 'exit 0' TERM HUP INT

# Keys one at a time, Enter as CR, output processing kept (LF → CRLF).
stty -icanon -echo -icrnl -isig -ixon min 1
printf '\e[?2004h' # bracketed paste, so a paste is told from typing
set_status idle
size
draw

pasting=0
while :; do
  if ! IFS= read -r -s -n1 -d '' -t 0.5 ch; then
    # No key: redraw when the pane was resized.
    old="$rows $cols"
    size
    [ "$old" = "$rows $cols" ] || draw
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
      '[201~') pasting=0 && draw ;;
      '') [ $state = idle ] || answer esc ;;
      '[C' | OC) [ $state = idle ] || answer right ;;
      '[D' | OD) [ $state = idle ] || answer left ;;
    esac
    continue
  fi
  if [ $pasting = 1 ]; then
    case $ch in $'\r' | $'\n') draft+=$'\n' ;; *) draft+=$ch ;; esac
    continue
  fi
  case $state:$ch in
    idle:$'\r' | idle:$'\n') submit ;;
    idle:$'\x7f') draft=${draft%?} && draw ;;
    idle:*) draft+=$ch && draw ;;
    *) answer "$ch" ;;
  esac
done
