# System Architecture

## High-Level Overview

**Unified Architecture (termote serve mode):**

```bash
┌─────────────────────────────────────────────────────────────────┐
│                         Client (Browser)                        │
│  ┌───────────────┐  ┌───────────────┐  ┌───────────────────┐    │
│  │ Session       │  │ xterm.js      │  │ Keyboard Toolbar  │    │
│  │ Sidebar       │  │ Terminal      │  │ + Gestures        │    │
│  └───────┬───────┘  └───────┬───────┘  └─────────┬─────────┘    │
│          │                  │                    │              │
│          │    WebSocket     │      direct calls  │              │
│          └────────┬─────────┴──────────┬─────────┘              │
└───────────────────┼────────────────────┼────────────────────────┘
                    │                    │
                    ▼                    ▼
┌─────────────────────────────────────────────────────────────────┐
│              termote (Built-in Server) :7680                    │
│  - Basic Auth + Host allowlist + Origin/CSRF guard              │
│  - Terminal WebSocket (/api/mux/stream, xterm.js stream)        │
│  - Static file serving (PWA)                                    │
│  - Mux API endpoints (/api/mux/*)                                │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│              Mux backend (tmux/psmux, or Herdr)                 │
│  termote opens the terminal itself: a PTY on Unix, ConPTY on     │
│  Windows, attached to `tmux attach` (or, with Herdr, an          │
│  `observe`/`pane.send_text` session over Herdr's socket)         │
└────────────────────────┬────────────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                         tmux Session                            │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                       │
│  │ Window 0 │  │ Window 1 │  │ Window 2 │  ...                  │
│  │ claude   │  │ copilot  │  │ shell    │                       │
│  └──────────┘  └──────────┘  └──────────┘                       │
└─────────────────────────────────────────────────────────────────┘
```

There is no separate terminal server or WebSocket proxy: termote owns the PTY/ConPTY and
streams its bytes straight to xterm.js. ttyd was removed in 1.0.0.

## Components

### PWA Frontend

React SPA with:

- **Terminal View**: xterm.js terminal fed directly by the `/api/mux/stream` WebSocket, in-place theme switching (no reload)
- **Hammer.js**: Touch gesture recognition (mobile only)
- **Session Sidebar**: Switch between groups (tmux sessions, or Herdr workspaces), add/edit/remove (collapsible on desktop)
- **Session Tabs**: Browser-like tabs in the header row for tab switching (hidden/shown via setting), add/remove via UI
- **Session Chip** (mobile): Header chip that opens the sessions list as a bottom sheet; there is no bottom navigation
- **Pane Strip**: Second-level switcher shown only when a tab has more than one pane (Herdr split panes)
- **Agent Status Badge**: Per-pane coding-agent status (idle/working/blocked/done) shown next to the pane, only ever set by the Herdr backend
- **Keyboard Toolbar**: Virtual keys, Ctrl combos, scroll controls (respects default expanded setting)
- **More Menu**: Font size (mobile), theme (light/dark/system), Settings, Help & gestures, About, Copy link, Clear cache & reload
- **Interface Styles**: Neutral, Terminal, Native; semantic tokens in `pwa/src/index.css`, selected by `data-ui-style` on `<html>` (see [design-guidelines.md](design-guidelines.md))
- **Settings**: grouped sheet/dialog; IME behavior, interface style, toolbar expanded, context menu control, session tabs visibility, poll interval, gesture hints, update check (inline toast), history clear
- **Session Poll Interval**: Configurable sync frequency (3s-5m, default 5s) to control snapshot polling rate
- **Connection Indicator**: Real-time auto-detection of server status (connecting/connected/disconnected/error), clickable to retry
- **Command History**: Search/recall previously sent commands (mobile-friendly delete buttons), persisted in localStorage
- **Quick Actions**: A key in the mobile keyboard toolbar opens a sheet of preset commands (clear, cancel, clear line, exit)
- **Deep Links**: `#/s/<group>/<tab>[/<pane>][?view=]` selects a session (never sends input); the address bar follows the current session via `replaceState`
- **Context Menu Control**: Block/unblock right-click on the terminal
- **Font Controls**: Adjustable font size (6-24px)
- **Fullscreen Toggle**: Desktop-only fullscreen mode via Fullscreen API
- **Update Check**: Auto-detect new releases via GitHub API, inline result in settings dialog
- **Responsive Layout**: Collapsible desktop sidebar, mobile slide-over panel

### Termote Server

Go HTTP server providing:

- **Static file serving**: PWA assets from /pwa/dist
- **Terminal WebSocket**: `/api/mux/stream` opens a PTY/ConPTY attached to the selected pane and streams it as binary WebSocket frames; a text control frame carries resize (client→server) and exit/error/size (server→client)
- **Authentication**: Basic auth with a session cookie, rate-limited, plus a Host allowlist and an Origin/CSRF write guard in front of everything
- **Mux API endpoints**: `/api/mux/*` — snapshot (groups→tabs→panes), tab create/rename/close/select, send-keys, health
- **Agent chat endpoints**: `/api/mux/panes/{id}/agent/*` — the transcript of the Claude Code session in a pane, sending it a message, reading and answering its dialogs (see [Agent chat](#agent-chat-apimuxpanesidagent))

Configuration: when `termote serve` finds a saved config (`~/.config/termote/config`), it reads
that and ignores every `TERMOTE_*` variable, then strips them from its own environment so
nothing it opens inherits one. Only without a saved config (the container image, a manual
`go run`/`termote-dev serve` from a checkout) does the environment configure it:

| Variable                      | Default      | Description                                                                     |
| ----------------------------- | ------------ | ------------------------------------------------------------------------------- |
| `TERMOTE_PORT`                | `7680`       | Server listen port                                                              |
| `TERMOTE_BIND`                | `0.0.0.0`    | Server bind address                                                             |
| `TERMOTE_PWA_DIR`             | `./pwa/dist` | Path to PWA static files                                                        |
| `TERMOTE_USER`                | `admin`      | HTTP basic auth username                                                        |
| `TERMOTE_PASS`                | (empty)      | HTTP basic auth password                                                        |
| `TERMOTE_NO_AUTH`             | `false`      | Disable basic auth                                                              |
| `TERMOTE_MUX`                 | `tmux`       | Backend: `tmux` or `herdr`; in the image, also picks what starts                |
| `TERMOTE_ALLOWED_HOSTS`       | (empty)      | Extra `Host` header values allowed, comma-separated; loopback is always allowed |
| `TERMOTE_HERDR_ALLOW_NO_AUTH` | `false`      | Required together with `TERMOTE_MUX=herdr` and `TERMOTE_NO_AUTH=true`           |

For a native install, `termote start` computes the equivalent of `TERMOTE_ALLOWED_HOSTS` from
`--lan`/`--tailscale`/`--allow-host` and saves it in the config; see `serveConfigFromSaved` in
`server/serve_config.go`.

### Mux Backend

`server/mux.go` defines a `Mux` interface (snapshot, select/new/rename/close tab, send-keys,
attach a terminal, health) with two implementations:

- **`mux_tmux.go`** (tmux on Unix, psmux on Windows): a tmux/psmux session is a group, a window
  is a tab, panes are tmux panes. Every client shares the same attached window, as in 0.x.
- **`mux_herdr.go`** (native mode only, `TERMOTE_MUX=herdr`): drives a Herdr server over its
  socket. A Herdr workspace is a group, a Herdr tab is a tab, a Herdr pane is a pane. Selecting
  a tab in the PWA only changes which pane the client streams (`Caps.ClientSideSelect`); it
  never changes what is shown on the Herdr desktop. By default the stream follows the pane's
  real size (`terminal session observe`) and sends keys with `pane.send_text` through a single
  serialising writer. A pane is one PTY with one size, so the PWA cannot have its own size next
  to the desktop's; when the client asks to drive it (`Caps.DriveSize`, see the stream protocol
  below) the stream switches to `terminal session control --takeover` at the client's size,
  resizes it in place by writing `terminal.resize` to its stdin, and switches back to `observe`
  when the client gives the size back, another client takes over, or `control` ends for any
  other reason while the pane is still there. Ending `control` (stdin closed, or the process
  killed) returns the PTY to the desktop's size; keys still go through `pane.send_text`. Mode
  switches are at least 500ms apart. Per-pane agent
  status comes from Herdr's `pane.agent_status_changed` event and is surfaced as the PWA's
  agent-status badge, refreshed at most once per `pollInterval`. The OS-specific parts are split
  by build tag: `herdr_socket_*.go` finds and dials the socket (a Unix socket, or on Windows the
  named pipe `\\.\pipe\<socket path>`, kept only when its server runs as the same user), and
  `herdr_observer_*.go` stops `observe` and `control` (a process group on Unix, a
  `KILL_ON_JOB_CLOSE` Job Object on Windows, so it dies with the server as a ConPTY terminal
  does). On macOS a `control` left behind by a server killed with `kill -9` keeps the pane at
  the client's size until the next `termote serve` reaps it.

## Communication Protocols

### Terminal WebSocket (`/api/mux/stream`)

```bash
Client → Server:
  - binary frame                      (input bytes)
  - {"type":"resize","cols":N,"rows":N} (text frame)
  - {"type":"drive","on":true|false}   (caps.driveSize: take over / give back the pane size)

Server → Client:
  - binary frame                      (output bytes)
  - {"type":"size","cols":N,"rows":N,"driving":B,"reason":R}   (Herdr)
  - {"type":"exit","code":N}
  - {"type":"error","message":"..."}
```

The size frame comes before any output at that size. With Herdr it always carries `driving`:
`false` means the size is the desktop's and client resizes are ignored; `true` means the client
drives it, so its resizes reach the pane. `reason` (`taken-over` or `failed`) is only set when
driving stopped without the client asking. `?drive=1` on the URL opens the stream already
driving, so a reconnect does not start at the desktop size first. tmux ignores `drive`.

The connection requires a same-origin/allowed Origin, a single-use token minted by
`GET /api/mux/stream-token` (30s TTL, consumed on upgrade), and `?pane=<id>` naming an
existing pane from the last snapshot.

### Mux API (REST, JSON)

```bash
GET    /api/mux/snapshot          → {apiVersion, backend, caps, groups:[{id,name,tabs:[{id,name,active,panes:[{id,active,title,agent}]}]}]}
POST   /api/mux/tabs               body: {groupId, name}       → {ok, id}
PATCH  /api/mux/tabs/{id}          body: {name}                → {ok}
DELETE /api/mux/tabs/{id}                                       → {ok}
POST   /api/mux/tabs/{id}/select                                 → {ok}
DELETE /api/mux/panes/{id}                                      → {ok}   (herdr only, else 501)
POST   /api/mux/panes/{id}/keys    body: {keys}                 → {ok}
POST   /api/mux/panes/{id}/scroll  body: {lines}                → {ok}   (caps.scroll only, else 501)
GET    /api/mux/health             → {status, apiVersion, backend}
GET    /api/mux/panes/{id}/agent/transcript?cursor=&before=     → {agent, sessionId, status, entries, cursor, before, reset}
POST   /api/mux/panes/{id}/agent/message  body: {text, cursor}  → 204
GET    /api/mux/panes/{id}/agent/prompt                          → {prompt: null | {promptId, kind, title, body, options}}
POST   /api/mux/panes/{id}/agent/answer   body: {promptId, choice} → 204
```

`caps.scroll` (Herdr): the stream only carries screen renders, so no history reaches the
xterm.js scrollback. The PWA turns the mouse wheel and the scroll buttons into
`/scroll` calls instead: `lines` rows back into the pane's history (negative: toward the live
screen, at most 10000 either way), clamped by Herdr. This moves the pane's shared view, so the
Herdr desktop scrolls with it; typing in the PWA returns it to the live screen first.
An agent that leaves no history in Herdr (Claude Code in fullscreen mode draws on the alternate
screen) gets SGR wheel reports instead, one per row and at most 50 per call; returning to the
live screen sends Claude Code's Ctrl+End. A pane without an agent is never sent wheel reports.

`apiVersion` is bumped on every breaking change to this API; the PWA compares it with its own
build and reloads on mismatch. The old `/api/tmux/*` paths and the `/terminal/` iframe route
are gone; `/terminal/` now answers `410 Gone` so a stale cached PWA bundle gets a readable
error instead of a broken page.

### Agent chat (`/api/mux/panes/{id}/agent/*`)

The PWA's Chat view is a second way to look at a pane running Claude Code, offered when the
snapshot reports `caps.agentChat` and the pane's `agent.name` is `claude`. It is the same
session as the terminal, not a session of its own: nothing runs headless.

**Finding the session.** Herdr reports the session id itself (`agent_session` on the pane;
`herdr integration install claude` must have been run). Herdr does not expose the pane's
process, so there is no start-time check, and the transcript is looked up in the config dir of
a Claude Code started by the server's user (the server's own `CLAUDE_CONFIG_DIR`, else
`~/.claude`). On tmux and psmux the server walks the
process tree under the pane's shell (at most 6 levels, 256 processes) and takes the first
process with a session file `<claudeDir>/sessions/<pid>.json` in its **own** Claude config dir
(`CLAUDE_CONFIG_DIR`, else `~/.claude`, read from `/proc/<pid>/environ` on Linux) whose
`procStart` matches the process's real start time, and on Linux whose `pidDomain` matches this
pid namespace. Claude Code never removes those files, so a file alone proves nothing: a dead
session's pid can be reused by another process. psmux reads only `%USERPROFILE%\.claude`
(Windows does not expose another process's environment). tmux pane ids in these routes are the
window's active pane: a split window chats with the pane that has focus.

**Transcript.** `<claudeDir>/projects/*/<sessionId>.jsonl`, with `sessionId` a UUID and the
resolved path inside that config dir. Reads are incremental from a signed `cursor` (a position
in one file), or backwards with `before`; lines over 2 MB are skipped and image blocks are
dropped from the entries. When the cursor names another session or a file that was replaced,
the server reads the end of the current file again and answers `reset: true`: the entries
replace what the client holds (a `/clear` or a resume changed the session). Reads are shared
between clients through a 500 ms cache per pane.

**Writes: only on positive evidence.** The two POST routes pass the Host allowlist, auth and
`writeGuard` like every other write. Each then takes a lock on the pane, re-reads the session
bypassing every cache, and checks it is still the process and session the client saw; anything
else is refused and sends nothing:

| Code                      | Status | Meaning                                                                                |
| ------------------------- | ------ | -------------------------------------------------------------------------------------- |
| `session_changed`         | 409    | The pane runs another session now (the client's `cursor` names the old one)            |
| `target_changed`          | 409    | Claude Code is no longer in this pane, or its process or session changed               |
| `input_not_ready`         | 409    | Not an empty input box: a dialog, a draft, the agent working, copy mode                |
| `paste_not_confirmed`     | 409    | The pasted text did not show in the input box; Enter was not sent                      |
| `delivered_not_submitted` | 502    | The text is in the input box but was not submitted; check the terminal                 |
| `prompt_changed`          | 409    | The dialog on screen is not the one the client answered; the reply carries the new one |
| `prompt_expired`          | 409    | The `promptId` was already used, is unknown, or is older than 60 s                     |
| `answer_not_confirmed`    | 502    | The key was sent but the dialog is still open                                          |
| `invalid_choice`          | 400    | `choice` is not one of the dialog's options                                            |
| `text_too_long`           | 413    | The text is over 16 KB; the reply carries `limit`                                      |
| `invalid_request`         | 400    | The body is not the JSON the route expects                                             |

`message` pastes the text (bracketed paste, through a named tmux buffer or Herdr's writer) only
when the screen shows an empty input box, waits until the text shows in it, checks the session
again, then sends Enter. The text is at most 16 KB (UTF-8 bytes; the body 64 KB), with control
characters other than newline and tab removed, so it cannot end the paste early.

`prompt` reads the screen and recognises the dialog anchored at its bottom: `permission`, a
single-choice `select` (at most 9 options), or `unsupported` for anything else (multiSelect,
multi-question wizards), which the PWA shows read-only with a way to the terminal. A
single-choice question keeps its buttons; only its "Type something" and "Chat about this"
entries are left out, since free text needs the terminal.
Every client polling one dialog gets the same single-use `promptId`. `answer` consumes it,
checks the session, the agent's status (on tmux the session file must say a dialog is open)
and the dialog's signature on screen, then sends the option's digit, or Escape for
`"cancel"`. A screen the detector does not recognise is never written to.

The Chat view renders the agent's markdown without raw HTML and never loads images: an image
becomes a text link, so a transcript cannot make the browser fetch another origin. The routes
call `requireAgentRead`/`requireWriteRole`, where a view-only role (#236) will be enforced;
the PWA's `readOnly` mode already hides the composer and the answer buttons.

## Deployment Modes

### Container Mode (All-in-one)

```bash
termote container up
```

Single container with termote + tmux or Herdr (no ttyd).
Uses `Dockerfile` (`debian:stable-slim`, pinned by digest, `tini -s` as PID 1) and `entrypoint.sh`.
Runs `ghcr.io/lamngockhuong/termote:<version>` with podman (preferred) or docker; from a git
checkout (or `--build`) it builds `termote:local` from the Dockerfile instead of pulling.

**Container Runtime:** Auto-detects podman or docker (podman preferred).

`container up --mux herdr` sets `TERMOTE_MUX=herdr`: `entrypoint.sh` then starts `herdr server`
(a child of tini, without any `TERMOTE_*` variable) with `XDG_CONFIG_HOME=/tmp` and
`HERDR_SOCKET_PATH=/tmp/herdr/herdr.sock`, creates the workspace `main`, and exports only
`HERDR_SOCKET_PATH` so `termote serve` uses the same socket (its config directory stays out of
the world-writable `/tmp`). A server that does not answer within 10s
stops the container. The Herdr binary is pinned by version and sha256 per arch in the
`Dockerfile`. This Herdr sees only the container's terminals.

### Native

```bash
termote start
termote start --mux herdr   # Herdr backend instead of tmux
```

All services run natively (no container): termote on port 7680 (7690 on Windows) serving the
PWA, the terminal stream and the API. `start` detects the backend the first time (herdr if its
socket answers, else tmux), registers the server with the OS supervisor (systemd user unit,
launchd agent, or a Windows Scheduled Task) and starts it.

Auto-detects OS via `runtime.GOOS`. Works on macOS, Linux and Windows (with psmux instead of tmux,
or Herdr on every OS).

### With Tailscale

```bash
termote start --tailscale myhost.ts.net
termote container up --tailscale myhost.ts.net
```

- Auto SSL via `tailscale serve --bg` (no manual cert management, never run with sudo)
- Access via Tailscale network (default port 443); the Tailscale name is also added to the
  Host allowlist automatically
- `serve` re-applies the mapping at every start (boot, restart, update); `stop`,
  `start --no-tailscale` and `uninstall` remove only Termote's own mapping
  (`tailscale serve --https=<port> off`, never `serve reset`)

### Uninstall

```bash
termote uninstall
```

Removes the service registration, Termote's Tailscale mapping, the `termote` command and the
install root; the saved config and logs stay (the command prints both paths to delete by hand).

### Self-Update

```bash
termote update                  # Update to the latest stable 1.x release
termote update --version 1.0.1  # Pin to a specific version
termote update --force           # Force reinstall current version
```

**Update flow** (`server/cli_update.go`):

1. Fetch the newest stable 1.x release tag from GitHub (or use `--version` to pin)
2. Download the archive and its `.sha256` (mandatory), verify it
3. Unpack into `versions/<v>`, switch the `current` pointer atomically
4. Restart the service, wait until health reports the new version and keeps answering
5. Otherwise switch `current` back to the previous version and restart it (both kept)

**Safeguards:**

- Refuses to run from a git checkout, or for a binary not installed by the installer
- Warns on downgrade (but allows it with an explicit `--version`)
- Skips reinstall if already on target version (unless `--force`)
- Preserves the saved config and service registration; keeps only the current and previous
  version on disk

## Security Model

1. **Network**: VPN/Tailscale or local network only
2. **Auth**: Basic auth over HTTPS (use `--no-auth` for local dev only); an empty saved
   password no longer disables auth — `start` generates a new one and prints it once
   (`termote show-password` to see it again)
3. **Session cookies**: Stored after initial basic auth to prevent double prompts on mobile
4. **Host allowlist**: every request's `Host` header must match loopback, the address the
   request arrived on when `--lan` is set, the Tailscale name (`--tailscale`), or a name added
   with `--allow-host`; there is no wildcard, so DNS rebinding from an attacker-controlled page
   cannot reach the server
5. **Write/CSRF guard**: state-changing `/api/mux/*` requests must be same-site
   (`Sec-Fetch-Site`/`Origin` on the allowlist) and `Content-Type: application/json`
6. **Terminal access** (`/api/mux/stream`): same Origin check, plus a single-use 30s-TTL token
   minted by `/api/mux/stream-token` and consumed on WebSocket upgrade
7. **Herdr guard**: `--mux herdr --no-auth` is refused unless `--allow-herdr-no-auth` is also
   given, since Herdr exposes every workspace on the host, not just this session's pane
8. **Session**: tmux isolates terminal processes; Herdr sessions are isolated by Herdr itself
9. **Rate limiting**: 5 failed basic-auth attempts/min per IP → 429; rejected-Host log lines
   are rate-limited to one per 10s
10. **Agent chat**: on tmux/psmux the server reads only the transcript in the Claude config
    dir of the process found in the pane, proven by its start time (Herdr names the session
    itself, read from the server user's config dir); every write re-checks the target and the
    screen and sends nothing on doubt; markdown images in the Chat view never load

## Scalability Notes

- Single-user design (no multi-tenancy)
- Sessions limited by tmux/Herdr capacity (~dozens)
- Terminal WebSocket connections are persistent; the server caps concurrent streams and evicts
  the oldest one past the limit
