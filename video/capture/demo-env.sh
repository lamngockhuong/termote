#!/usr/bin/env bash
# Starts a throwaway Termote with demo content, for the intro video's captures
# (pwa/e2e/capture-video.spec.ts). Linux only, like the Claude Code stand-in.
#
#   video/capture/demo-env.sh start <work-dir> [herdr|tmux]   build the demo, start the server
#   video/capture/demo-env.sh stop <work-dir>                  stop it and its Herdr or tmux
#
# Everything lives under <work-dir>, which shows on screen (use /tmp/dev): a
# git repo `acme-api` with uncommitted changes, a Claude Code config dir
# holding a finished conversation, and a copy of tests/fixtures/fake-claude.sh
# whose recorded screens name that repo. Under Herdr the stand-in reports its
# state and session id to Herdr (`pane report-agent`), which is what gives the
# pane its Chat view there.
# The server runs from server/termote (`make build`) with its own HOME, XDG
# dirs, Herdr or tmux socket and port (TERMOTE_PORT, default 7686 for Herdr,
# 7685 for tmux), never the user's. The password is written to
# <work-dir>/pass for the spec (TERMOTE_PASS).
set -euo pipefail

usage="usage: demo-env.sh start <work-dir> [herdr|tmux] | stop <work-dir>"
cmd=${1:?$usage}
work=$(mkdir -p "${2:?$usage}" && cd "$2" && pwd)
root=$(cd "$(dirname "$0")/../.." && pwd)
mux=${3:-$(cat "$work/mux" 2>/dev/null || echo herdr)}
case $mux in
  herdr) port=${TERMOTE_PORT:-7686} ;;
  tmux) port=${TERMOTE_PORT:-7685} ;;
  *) echo "$usage" >&2; exit 2 ;;
esac
# A socket path must fit in 108 bytes, which a work dir may not leave room for
sock="/tmp/termote-demo-$(id -u)-$port.sock"
h() { HERDR_SOCKET_PATH="$sock" herdr "$@"; }

if [ "$cmd" = stop ]; then
  [ -f "$work/serve.pid" ] && kill "$(cat "$work/serve.pid")" 2>/dev/null || true
  if [ "$mux" = herdr ]; then
    h server stop >/dev/null 2>&1 || true
  else
    tmux -S "$sock" kill-server 2>/dev/null || true
  fi
  rm -f "$work/serve.pid" "$work/mux"
  exit 0
fi
[ "$cmd" = start ] || { echo "unknown command: $cmd" >&2; exit 2; }
[ -x "$root/server/termote" ] || { echo "run make build first" >&2; exit 1; }
if [ -f "$work/serve.pid" ] && kill -0 "$(cat "$work/serve.pid")" 2>/dev/null; then
  echo "already running (pid $(cat "$work/serve.pid"))" >&2
  exit 1
fi

# The work dir is the shell's HOME, so the prompt reads ~/acme-api; the
# Files and Changes views show the repo's absolute path, so keep it short
# (/tmp/dev gives /tmp/dev/acme-api).
home="$work"
repo="$home/acme-api"
rm -rf "$repo" "$home/web" "$home/.claude" "$work/kit"
mkdir -p "$work/bin"

# A prompt that names no real user or host
cat >"$home/.bashrc" <<'EOF'
PS1='\[\e[32m\]dev@laptop\[\e[0m\]:\[\e[34m\]\w\[\e[0m\]$ '
EOF
# tmux starts login shells, which read this instead
echo '. ~/.bashrc' >"$home/.bash_profile"

# --- The repo: a small Go API, committed, then the agent's edits on top ---
mkdir -p "$repo/auth" "$repo/.claude/commands"
cd "$repo"
cat >go.mod <<'EOF'
module acme-api

go 1.26
EOF
cat >main.go <<'EOF'
package main

import (
	"log"
	"net/http"

	"acme-api/auth"
)

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /login", auth.Login)
	log.Println("listening on :8080")
	log.Fatal(http.ListenAndServe(":8080", mux))
}
EOF
cat >auth/login.go <<'EOF'
package auth

import (
	"encoding/json"
	"net/http"
)

type credentials struct {
	User     string `json:"user"`
	Password string `json:"password"`
}

// Login checks a user's password and starts a session.
func Login(w http.ResponseWriter, r *http.Request) {
	var c credentials
	if err := json.NewDecoder(r.Body).Decode(&c); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if !checkPassword(c.User, c.Password) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	startSession(w, c.User)
}

func checkPassword(user, password string) bool { return user == "demo" && password == "demo" }

func startSession(w http.ResponseWriter, user string) {
	http.SetCookie(w, &http.Cookie{Name: "session", Value: user, HttpOnly: true})
}
EOF
cat >auth/login_test.go <<'EOF'
package auth

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestLoginRejectsWrongPassword(t *testing.T) {
	r := httptest.NewRequest("POST", "/login", strings.NewReader(`{"user":"demo","password":"x"}`))
	w := httptest.NewRecorder()
	Login(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("got %d", w.Code)
	}
}
EOF
cat >README.md <<'EOF'
# acme-api

A small HTTP API: sign-in, sessions and rate limiting.

## How a sign-in flows

```mermaid
flowchart TD
    C[Client] -->|POST /login| L{Rate limit}
    L -->|over 5/min| R[429 Too Many Requests]
    L -->|ok| P[Check password]
    P -->|wrong| U[401]
    P -->|right| S[Start session]
```

## Run

```sh
go run .
go test ./...
```
EOF
cat >.claude/commands/review.md <<'EOF'
---
description: Review the uncommitted changes
---
Review the diff.
EOF
cat >.claude/commands/ship.md <<'EOF'
---
description: Run the tests, commit and open a pull request
---
Ship it.
EOF
git init -q -b main
git -c user.name=Dev -c user.email=dev@example.com add -A
git -c user.name=Dev -c user.email=dev@example.com commit -qm "feat: sign-in endpoint"

# The agent's edits, left uncommitted for the Changes view
cat >auth/ratelimit.go <<'EOF'
package auth

import (
	"sync"
	"time"
)

// limiter allows max attempts per window for each client address.
type limiter struct {
	mu     sync.Mutex
	max    int
	window time.Duration
	hits   map[string][]time.Time
}

func newLimiter(max int, window time.Duration) *limiter {
	return &limiter{max: max, window: window, hits: map[string][]time.Time{}}
}

// allow records an attempt from addr and reports whether it is within the limit.
func (l *limiter) allow(addr string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	kept := l.hits[addr][:0]
	for _, t := range l.hits[addr] {
		if now.Sub(t) < l.window {
			kept = append(kept, t)
		}
	}
	if len(kept) >= l.max {
		l.hits[addr] = kept
		return false
	}
	l.hits[addr] = append(kept, now)
	return true
}
EOF
perl -0pi -e 's|"net/http"\n\)|"net"\n\t"net/http"\n\t"time"\n)\n\n// Five attempts a minute per client address.\nvar attempts = newLimiter(5, time.Minute)|; s|func Login\(w http.ResponseWriter, r \*http.Request\) \{\n|func Login(w http.ResponseWriter, r *http.Request) {\n\taddr, _, _ := net.SplitHostPort(r.RemoteAddr)\n\tif !attempts.allow(addr) {\n\t\thttp.Error(w, "too many attempts", http.StatusTooManyRequests)\n\t\treturn\n\t}\n|' auth/login.go
cat >>auth/login_test.go <<'EOF'

func TestLoginLimitsAttempts(t *testing.T) {
	attempts = newLimiter(5, time.Minute)
	for i := 0; i < 6; i++ {
		r := httptest.NewRequest("POST", "/login", strings.NewReader(`{"user":"demo","password":"x"}`))
		w := httptest.NewRecorder()
		Login(w, r)
		if i == 5 && w.Code != http.StatusTooManyRequests {
			t.Fatalf("6th attempt: got %d", w.Code)
		}
	}
}
EOF
perl -0pi -e 's|"testing"\n|"testing"\n\t"time"\n|' auth/login_test.go
gofmt -w auth 2>/dev/null || true

# --- Claude Code: a finished conversation about those edits ---
# The server user's config dir: where Termote looks for a session Herdr names
claude="$home/.claude"
sid=6f1c2a4e-8b3d-4c5e-9f70-1a2b3c4d5e6f
project="$claude/projects/$(printf '%s' "$repo" | tr -c 'A-Za-z0-9' '-')"
mkdir -p "$project" "$claude/sessions"
python3 - "$project/$sid.jsonl" "$repo" <<'EOF'
import json, sys
path, repo = sys.argv[1], sys.argv[2]
login = open(f"{repo}/auth/login.go").read()
lines, n = [], 0
def entry(role, content):
    global n
    n += 1
    lines.append(json.dumps({"type": role, "uuid": f"demo-seed-{n:04d}",
        "timestamp": "2026-10-11T09:00:%02dZ" % n,
        "message": {"role": role, "content": content}}))
entry("user", "Add rate limiting to the login endpoint: 5 tries a minute per IP")
entry("assistant", [{"type": "text", "text": "I'll read the login handler first."},
    {"type": "tool_use", "id": "t1", "name": "Read", "input": {"file_path": f"{repo}/auth/login.go"}}])
entry("user", [{"type": "tool_result", "tool_use_id": "t1", "content": "33 lines"}])
entry("assistant", [{"type": "text", "text": "Adding a small per-address limiter and checking it before the password."},
    {"type": "tool_use", "id": "t2", "name": "Write", "input": {"file_path": f"{repo}/auth/ratelimit.go",
        "content": open(f"{repo}/auth/ratelimit.go").read()}}])
entry("user", [{"type": "tool_result", "tool_use_id": "t2", "content": "File created"}])
entry("assistant", [{"type": "tool_use", "id": "t3", "name": "Edit", "input": {"file_path": f"{repo}/auth/login.go",
    "old_string": "func Login(w http.ResponseWriter, r *http.Request) {\n\tvar c credentials",
    "new_string": "func Login(w http.ResponseWriter, r *http.Request) {\n\taddr, _, _ := net.SplitHostPort(r.RemoteAddr)\n\tif !attempts.allow(addr) {\n\t\thttp.Error(w, \"too many attempts\", http.StatusTooManyRequests)\n\t\treturn\n\t}\n\tvar c credentials"}}])
entry("user", [{"type": "tool_result", "tool_use_id": "t3", "content": "File updated"}])
entry("assistant", [{"type": "text", "text": "Login is now **rate limited**:\n\n- 5 attempts a minute per client address (`auth/ratelimit.go`)\n- the 6th gets `429 Too Many Requests`\n- a test covers it in `auth/login_test.go`\n\nWant me to run the tests?"}])
open(path, "w").write("\n".join(lines) + "\n")
EOF

# --- The stand-in, its screens rewritten to name the demo repo ---
kit="$work/kit"
mkdir -p "$kit/tests/fixtures" "$kit/server/testdata/claude"
cp "$root/tests/fixtures/fake-claude.sh" "$kit/tests/fixtures/"
cp -R "$root/server/testdata/claude/screens" "$kit/server/testdata/claude/"
perl -Mutf8 -CSD -pi -e '
  s{/…/00000000-0000-4000-8000-000000000000/scratchpad/lab}{~/acme-api}g;
  s{/tmp/lab}{~/acme-api}g;
  s{^.*Your login expires in 2 days.*$}{}g;
  s{Run this exact shell command with the Bash tool: touch scratch-one\.txt}{Run the auth tests}g;
  s{Creating a file named scratch-one\.txt}{Running the auth tests}g;
  s{Create a file named scratch-one\.txt}{Run the tests of the auth package}g;
  s{touch scratch-one\.txt}{go test ./auth/...}g;
  s{Đã tạo file .*scratch-one\.txt.*\.}{All auth tests pass.}g;
' "$kit/server/testdata/claude/screens/"*.txt
# Option 2 of the permission dialog, two rows in the recording
perl -0pi -e 's{Yes, and always allow access to.*?from this project}{Yes, and don\x27t ask again for \e[1mgo test\e[0m in this project}s' \
  "$kit/server/testdata/claude/screens/2.1.286-permission-bash.txt"
perl -pi -e '
  s{\*permission\*\)}{*tests*)};
  s{touch scratch-one\.txt}{go test ./auth/...}g;
  s{Create a file named scratch-one\.txt}{Run the tests of the auth package}g;
  s{Created scratch-one\.txt\.}{ok  acme-api/auth  0.41s: both tests pass.}g;
' "$kit/tests/fixtures/fake-claude.sh"
# Under Herdr, each status also goes to Herdr: the state from a source of its
# own (Herdr takes the lifecycle of a known agent only from such a source or
# from detecting the real process), the session id as Claude Code's Herdr hook
# reports it (herdr:claude). FAKE_HERDR_STATE pins the state reported, for a
# pane that stays busy.
perl -0pi -e 's{(  mv "\$f.tmp" "\$f"\n)\}}{$1  if [ -n "\$\{HERDR_PANE_ID:-\}" ]; then
    local st=idle
    case \$1 in busy) st=working ;; waiting) st=blocked ;; esac
    st=\$\{FAKE_HERDR_STATE:-\$st\}
    herdr pane report-agent --source termote-demo --seq "\$(date +%s%N)" --agent claude \\
      --state "\$st" "\$HERDR_PANE_ID" >/dev/null 2>&1 || true
    herdr pane report-agent-session --source herdr:claude --seq "\$(date +%s%N)" --agent claude \\
      --agent-session-id "\$sid" "\$HERDR_PANE_ID" >/dev/null 2>&1 || true
  fi
\}}' "$kit/tests/fixtures/fake-claude.sh"

# A dev server log for a second tab
cat >"$work/bin/api-log.sh" <<'EOF'
#!/usr/bin/env bash
# The terminal title names the pane in Termote's pane strip
printf '\e]0;api\a\e[2m$ go run .\e[0m\n2026/10/11 09:00:01 listening on :8080\n'
paths=("POST /login 200" "GET /me 200" "POST /login 401" "POST /login 429" "GET /health 200")
i=0
while :; do
  p=${paths[$((i % ${#paths[@]}))]}
  printf '2026/10/11 09:%02d:%02d %s %dms\n' $((i / 60 % 60)) $((i % 60)) "$p" $((3 + i % 17))
  i=$((i + 1))
  sleep 1
done
EOF
chmod +x "$work/bin/api-log.sh"

# --- The server ---
pass=$(openssl rand -hex 12)
printf '%s\n' "$pass" >"$work/pass"
chmod 600 "$work/pass"
# A clean start: go test would answer (cached), Herdr would restore the last
# run's workspaces next to the new ones
rm -rf "$work/cache" "$work/state" "$work/xdg" "$work/data" "$work/run"
mkdir -p "$work/xdg" "$work/cache" "$work/state" "$work/data"
mkdir -m 700 "$work/run"
echo "$mux" >"$work/mux"
# Run from inside your own Herdr or tmux, their variables would point the
# demo's server and panes at them
unset HERDR_ENV HERDR_SOCKET_PATH HERDR_PANE_ID HERDR_TAB_ID HERDR_WORKSPACE_ID TMUX TMUX_PANE CLAUDE_CONFIG_DIR
demo_env=(HOME="$home" SHELL=/bin/bash
  XDG_CONFIG_HOME="$work/xdg" XDG_CACHE_HOME="$work/cache" XDG_STATE_HOME="$work/state"
  XDG_DATA_HOME="$work/data" XDG_RUNTIME_DIR="$work/run")
if [ "$mux" = herdr ]; then
  env "${demo_env[@]}" HERDR_SOCKET_PATH="$sock" nohup herdr server >"$work/herdr.log" 2>&1 &
  for _ in $(seq 1 30); do h api snapshot >/dev/null 2>&1 && break; sleep 0.5; done
  h api snapshot >/dev/null
  mux_env=(TERMOTE_MUX=herdr HERDR_SOCKET_PATH="$sock")
else
  mux_env=(TMUX_SOCKET="$sock" TMUX_SESSION=acme-api)
fi
env "${demo_env[@]}" "${mux_env[@]}" \
  TERMOTE_BIND=127.0.0.1 TERMOTE_PORT="$port" TERMOTE_PASS="$pass" \
  nohup "$root/server/termote" serve >"$work/serve.log" 2>&1 &
echo $! >"$work/serve.pid"
for _ in $(seq 1 30); do
  # On tmux the first snapshot also creates the default session
  curl -fsS -u "admin:$pass" "http://127.0.0.1:$port/api/mux/snapshot" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS -u "admin:$pass" "http://127.0.0.1:$port/api/mux/snapshot" >/dev/null || {
  cat "$work/serve.log" >&2
  exit 1
}

# A child of the pane's shell, as Claude Code is: Herdr takes no report for a
# pane whose shell was replaced
fake_claude="clear; env CLAUDE_CONFIG_DIR=$claude bash $kit/tests/fixtures/fake-claude.sh"
mkdir -p "$home/web"

if [ "$mux" = herdr ]; then
  # Types a command into a Herdr pane's shell
  run() { h pane send-text "$1" "$2" >/dev/null && h pane send-keys "$1" Enter >/dev/null; }
  # Workspace acme-api: tab claude (Claude Code, the dev server beside it), tab shell
  ws=$(h workspace create --cwd "$repo" --label acme-api --focus | jq -r .result.workspace.workspace_id)
  claude_pane=$(h pane list | jq -r --arg w "$ws" '.result.panes[] | select(.workspace_id == $w) | .pane_id')
  h tab rename "$ws:t1" claude >/dev/null
  api_pane=$(h pane split "$claude_pane" --direction right --ratio 0.62 --cwd "$repo" --no-focus | jq -r '.. | .pane_id? // empty' | head -1)
  run "$api_pane" "clear; exec $work/bin/api-log.sh"
  run "$claude_pane" "$fake_claude"
  shell_pane=$(h tab create --workspace "$ws" --cwd "$repo" --label shell --no-focus | jq -r '.. | .pane_id? // empty' | head -1)
  run "$shell_pane" "clear && git status --short && git --no-pager diff --stat && go test -v ./auth/..."
  # Workspace web: another Claude Code, busy; infra: a shell
  web=$(h workspace create --cwd "$home/web" --label web --no-focus | jq -r .result.workspace.workspace_id)
  web_pane=$(h pane list | jq -r --arg w "$web" '.result.panes[] | select(.workspace_id == $w) | .pane_id')
  h tab rename "$web:t1" claude >/dev/null
  run "$web_pane" "${fake_claude/env /env FAKE_HERDR_STATE=working }"
  infra=$(h workspace create --cwd "$home" --label infra --no-focus | jq -r .result.workspace.workspace_id)
  infra_pane=$(h pane list | jq -r --arg w "$infra" '.result.panes[] | select(.workspace_id == $w) | .pane_id')
  h tab rename "$infra:t1" deploy >/dev/null
  run "$infra_pane" "clear && printf 'staging: 3/3 healthy\nproduction: 6/6 healthy\n'"
  # The welcome workspace Herdr opens on start, if any, goes
  for w in $(h workspace list | jq -r '.result.workspaces[] | select(.label != "acme-api" and .label != "web" and .label != "infra") | .workspace_id'); do
    h workspace close "$w" >/dev/null 2>&1 || true
  done
  echo "panes: claude $claude_pane, api $api_pane, shell $shell_pane, web $web_pane" >"$work/panes"
else
  t() { tmux -S "$sock" "$@"; }
  # No status line: it shows the host name
  t set -g status off
  # acme-api: a shell, the dev server, Claude Code
  t rename-window -t '=acme-api:=0' shell
  t send-keys -t '=acme-api:=0' "cd ~/acme-api && clear && git status --short && git --no-pager diff --stat && go test -v ./auth/..." Enter
  t new-window -d -t 'acme-api:' -n api -c "$repo" "$work/bin/api-log.sh"
  t new-window -t 'acme-api:' -n claude -c "$repo" bash -c "$fake_claude"
  # Two more groups for the sessions list
  t new-session -d -s web -n dev -c "$home" bash
  t send-keys -t '=web:=0' "clear && printf '  VITE v7.1.0  ready in 412 ms\n\n  ➜  Local:   http://localhost:5173/\n'" Enter
  t new-session -d -s infra -n deploy -c "$home" bash
  t send-keys -t '=infra:=0' "clear && printf 'staging: 3/3 healthy\nproduction: 6/6 healthy\n'" Enter
fi

echo "Termote demo ($mux) on http://127.0.0.1:$port (user admin, password in $work/pass)"
