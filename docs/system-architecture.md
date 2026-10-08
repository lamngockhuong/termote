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
│              tmux server: one or more sessions                  │
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
- **Files and Changes**: views of the pane's directory (`caps.files`), where a text file can also be edited and saved: a tree with a highlighted file viewer, and `git status` with per-file diffs. Files keeps each open file in a tab (`pwa/src/utils/file-tabs.ts`: a preview tab, pinned tabs, at most 10, the least recently used clean one closed past that), in memory only; only the tab shown has a viewer, the others keep their scroll offset, link trail and Show. Changes keeps its diffs as tabs of its own with the same rules (`use-git-changes.ts`: one tab per side of a file, keyed `staged:orig:path`, holding its editor, Show and scroll; a side git status stops listing closes its tab unless it is being edited). A tab bar on desktop (`file-tab-bar.tsx`), a sheet of open files on mobile (`open-files-sheet.tsx`). A side panel next to the terminal on desktop (header toggles), views of the header's view menu on mobile. Shiki runs in a module worker (`pwa/src/utils/highlight-worker.ts`); the worker, its themes and grammars are built under `assets/shiki/`, left out of the precache and cached on first use
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
- **Authentication**: Basic auth or a sign-in form (`/login`, for browsers: an iOS home-screen app never shows the Basic prompt), then a session cookie, rate-limited, plus a Host allowlist and an Origin/CSRF write guard in front of everything; `POST /api/mux/logout` ends the session on the server (the More menu's Log out, shown when the snapshot reports `caps.auth`)
- **Mux API endpoints**: `/api/mux/*` — snapshot (groups→tabs→panes), tab create/rename/close/select, send-keys, health
- **Web Push**: `/api/mux/push/*` — the server's key and this device's subscription; a watcher sends a push when an agent needs the user (see [Agent notifications](#agent-notifications-apimuxpush))
- **Agent chat endpoints**: `/api/mux/panes/{id}/agent/*` — the transcript of the Claude Code or Codex session in a pane, sending it a message, reading and answering its dialogs (see [Agent chat](#agent-chat-apimuxpanesidagent))

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

- **`mux_tmux.go`** (tmux on Unix, psmux on Windows): every session on the tmux server is a
  group (sessions made outside Termote too), a window is a tab, and a tab shows its window's
  active pane. The default session (`TMUX_SESSION`, `main`) is listed first, keeps its name as
  group id and bare window indexes as tab ids (`0`), and is made again by the next snapshot when
  it is missing; any other session is addressed by tmux's session id (group `$3`, tab `$3:1`),
  which a rename keeps and a tmux server restart changes. Every command targets exactly (`$N:=i`,
  `=main:=i`: no prefix match on the session name or on a window name), and `display-message` replies are checked against the session and window asked
  for. psmux has no `=` before a window index (it answers `can't find window: =0` with exit 0,
  and `select-window`/`send-keys` do nothing) and never matches a window name, so on Windows the
  index is bare (`$N:i`, `=main:i`) and a tab is selected only after `display-message` answered
  for that window. A stream runs `attach -E -t <session>` after selecting the window, so every client of a
  session shares its current window, as in 0.x; the PWA keeps which session it shows per device
  and opens a new stream when it switches session.
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

**Foreground process** (`server/mux_process.go`): each pane of the snapshot carries
`process: {name, cwd?}` when the backend can tell, and a tmux tab also carries `processes` for
every pane of its window (the snapshot holds only the active one), in pane order. The name is
the first word of what the OS reports (cut at whitespace, `=` or `:`, then after the last `/`),
at most 32 bytes, with control and format characters (zero-width, bidi) removed; argv and the
environment never leave the server. tmux fills it from one `list-panes -a` call
(`#{pane_current_command}`, `#{pane_current_path}`, each after its byte length from `#{n:}`,
with `-u` on tmux so the lengths match without a UTF-8 locale), read as a stream keyed by session
id and window index, never split into lines; a parse that stops drops the window it stopped in,
a window missing from a reply keeps its last names for 10 s (psmux sometimes prints nothing),
and a failure never fails the snapshot. Herdr fills it from
`pane.process_info` (the foreground group leader's `name`; `argv`/`cmdline` are not decoded)
through a cache apart from the snapshot cache: a name is fresh for 5 s, one refresh runs at a
time, 4 calls at once within 1.5 s (not cut short when the request that started it leaves), a
name whose reads have failed for 15 s is dropped, and an `invalid_request` (a Herdr without the
method; a closed pane answers `pane_not_found`) stops the calls, and serving names, for 5
minutes. The cwd comes from the pane's `foreground_cwd` in `session.snapshot`.
The snapshot route refuses cross-site reads (`crossSiteRejection`), as the other pane reads do.
The PWA shows the names in the sessions list and the pane strip, and the close confirmations
add "Running: …"; the cwd is not shown.

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
driving, so a reconnect does not start at the desktop size first. tmux ignores `drive`. The
PWA asks to drive only while its terminal shows: under another view (Chat) it gives the size
back, since Claude Code cuts a dialog taller than the pane (the tab row and the question scroll
off), and the Chat view could no longer read it. Under another view the terminal also keeps its
size (no fit, no resize sent): the view's input area below it grows with a dialog card, which
would otherwise shrink the pane until the dialog no longer fits, and the card would come and go.

The connection requires a same-origin/allowed Origin, a single-use token minted by
`GET /api/mux/stream-token` (30s TTL, consumed on upgrade), and `?pane=<id>` naming an
existing pane from the last snapshot.

### Mux API (REST, JSON)

```bash
GET    /api/mux/snapshot          → {apiVersion, backend, caps, groups:[{id,name,worktree?:{linked,branch?},tabs:[{id,name,active,processes?,panes:[{id,active,title,agent,process?}]}]}]}
POST   /api/mux/tabs               body: {groupId, name}       → {ok, id}
PATCH  /api/mux/tabs/{id}          body: {name}                → {ok}
DELETE /api/mux/tabs/{id}                                       → {ok}
POST   /api/mux/tabs/{id}/select                                 → {ok}
DELETE /api/mux/panes/{id}                                      → {ok}   (herdr only, else 501)
POST   /api/mux/groups             body: {name, cwd}            → {ok, id} | {error, code}   (caps.groups)
PATCH  /api/mux/groups/{id}        body: {name}                 → {ok} | {error, code}
DELETE /api/mux/groups/{id}                                     → {ok} | {error, code}
GET    /api/mux/worktrees?groupId=                              → {repoName, worktrees:[{path,branch?,linked,openable,groupId?}], branches} | {error, code}   (caps.worktrees)
POST   /api/mux/worktrees          body: {groupId, branch, base, label}  → {ok, id} | {error, code}
POST   /api/mux/worktrees/open     body: {groupId, branch}      → {ok, id, alreadyOpen} | {error, code}
DELETE /api/mux/worktrees/{id}     body: {force, path, branch}  → {ok} | {error, code}
POST   /api/mux/panes/{id}/keys    body: {keys}                 → {ok}
POST   /api/mux/panes/{id}/scroll  body: {lines}                → {ok}   (caps.scroll only, else 501)
GET    /api/mux/health             → {status, apiVersion, backend, version, pid, install}
POST   /api/mux/logout             body: {}                      → 204   (sign-in on only, else 404)
GET    /api/mux/push/key                                        → {publicKey} | 503 push_unavailable   (caps.push)
POST   /api/mux/push/subscribe     body: {endpoint, keys:{p256dh, auth}}  → {ok} | {error, code}
DELETE /api/mux/push/subscribe     body: {endpoint}             → {ok}   (unknown endpoint too)
GET    /api/mux/panes/{id}/agent/transcript?cursor=&before=     → {agent, sessionId, status, entries, cursor, before, reset}
POST   /api/mux/panes/{id}/agent/message  body: {text, cursor, images?}  → 204
GET    /api/mux/panes/{id}/agent/prompt                          → {prompt: null | {promptId, kind, title, body, options, steps, freeText}}
POST   /api/mux/panes/{id}/agent/answer   body: {promptId, choice} → 204
GET    /api/mux/panes/{id}/agent/commands                        → {commands: [{name, description, source, kind}]}
POST   /api/mux/panes/{id}/agent/start    body: {kind}          → {ok, state: "starting"} | {error, code}   (caps.agentStart; codex: caps.agentStartCodex)
GET    /api/mux/panes/{id}/agent/start                           → {kind, state} | 404 no_start
GET    /api/mux/panes/{id}/files/tree?path=&root=               → {root, isRepo, path, entries, truncated}
GET    /api/mux/panes/{id}/files/content?path=&root=&reveal=    → {root, path, size, text, hash, editable, notEditable?} | {…, previewable: false, reason} | {…, sensitive: true}
GET    /api/mux/panes/{id}/files/content?path=&root=&hash=1     → {root, path, size, hash} (never the contents, sensitive or not)
PUT    /api/mux/panes/{id}/files/content?root=  body: {path, baseHash, text, reveal} → {root, path, size, hash} | {error, code, reason?}
POST   /api/mux/panes/{id}/files/create?root=   body: {path, reveal}           → 201 {root, path} | {error, code[, path]}
POST   /api/mux/panes/{id}/files/delete?root=   body: {path, kind, baseHash, reveal, permanent} → {root, path[, trashId, size, permanent]} | {error, code}
POST   /api/mux/panes/{id}/files/restore?root=  body: {trashId, reveal}         → {root, path} | {error, code}
GET    /api/mux/panes/{id}/files/find?q=&root=&ignored=1&exclude=&fresh=1 → {root, isRepo, results, truncated, incomplete} | {error, code}
GET    /api/mux/panes/{id}/files/changes?root=                  → {root, isRepo, branch, entries, truncated}
GET    /api/mux/panes/{id}/files/diff?path=&orig=&staged=&root=&reveal= → {root, path, binary, conflict, truncated, sensitive, reason, hunks}
GET    /api/mux/panes/{id}/files/raw?path=&root=&reveal=[&side=old|new&staged=&orig=] → image bytes | {error, code}
POST   /api/mux/uploads            body: raw image (image/png|jpeg|gif|webp) → {id, path, insert}
```

`/uploads` (`caps.uploads`) saves an image on the host so an agent can read it by path: the
host clipboard is empty when the image sits on a phone. The PWA types `insert` (the path,
double-quoted when it holds a space) plus a space into the pane it was picked for, from the
toolbar's Attach key, the Quick actions sheet, an image pasted into the terminal, the Paste
key, a long press or Ctrl+Shift+V (each only for an image without text; with text, the text is
pasted). If the user moved to another
pane while it uploaded, nothing is typed: a toast offers to insert it into the current one.
Errors answer a JSON `code`: `unsupported_image` (415: not one of the four types, or bytes of
another type), `too_large` (413, over 10 MB), `busy` (429, two uploads already running),
`storage_full` (507), `uploads_unavailable` (503, no usable upload dir). Files live in
`os.UserCacheDir()/termote/uploads`, 7 days or until 200 MB (see Security Model).

The Chat view's composer uploads the same way (its image button, or an image pasted into the
box) and sends the ids as `images` in `agent/message`, at most 5; `text` may then be empty.
The server resolves each id in the store (an unknown one → 400 `invalid_request` with the bad
ids in `images`; no store → 503 `uploads_unavailable`), pastes each path on its own and waits
until the draft shows that many `[Image #N]` tokens (Claude Code and Codex both draw this for a
path pasted alone, not for a path inside other text), then pastes the text after a space and
confirms the whole draft before and after Enter. The request's time budget grows with the
number of images. When a step after the first paste fails, the box is cleared with one `C-c`
only if the same idle agent shows nothing but this request's paste (the code is then the step's
own, e.g. `paste_not_confirmed`); anything else answers 409 `partial_paste` and leaves the box.

`/agent/start` (`caps.agentStart`: Herdr 0.8.2 or later, on Linux, macOS and Windows) starts
Claude Code (`kind: "claude"`) or Codex (`"codex"`, run as `codex --no-daemon`; only where Codex
has a Chat view, `caps.agentStartCodex`, so not on Windows, where it answers 501 `unsupported`)
in a pane that shows only its shell, through Herdr's `agent.start`. Only `kind` is read: the arguments come from a fixed
table and the alias Herdr tracks the agent by is the server's (`termote-<kind>-<8 hex>`, one
retry on `agent_name_taken`). The pane is resolved before the pane lock (the one `message` and
`answer` take); then a start of this server still running there answers 409 `starting`; a
pane whose foreground is not its shell alone, read again for up to 1.5 s, answers 409
`pane_busy` with nothing typed (on Windows Herdr never reports a program other than an agent or
the shell as foreground, so the shell must also have no child process, else a running `ping` or
`nvim` would read idle and the `C-c` would kill it; a shell with a long-lived child is never
idle; work running inside pwsh itself, a `.ps1` script included, still reads idle and is stopped
by the `C-c`, an accepted gap). Herdr keeps a start pending until its deadline even when the
command failed at once (not installed), refuses another start meanwhile, and lets an expired one
go only when it is read: the server reads `agent.get` on the pane id first, which releases an
expired one, and answers 409 `start_pending` with nothing typed while one is held. Otherwise the
server types `C-c` (clearing half-typed text, a
continuation prompt, a heredoc or a `read`), checks the shell again after 200 ms (409
`pane_busy`), then calls `agent.start` with a 30 s startup deadline. Herdr types the command
and answers at once, so the POST answers 200 `starting`; the PWA then polls the GET every 2 s,
which reads `agent.get` by the alias: `ready` (interactive), `blocked` (a first-run dialog),
`exited` (also when no agent was seen and the pane shows only its shell again 4 s after the
start), or `timeout` 35 s after the start, kept 60 s once final (a refused start leaves it). Other codes: 400
`invalid_kind`, 404 `not_found`, 501 `unsupported` (also Herdr's `unsupported_agent_kind` and an
older Herdr's `invalid_request` naming the method), 504 `start_unknown` (the `agent.start`
call timed out; the start is followed as if typed) and 500 `start_failed`. The Chat view is
offered on such a pane and holds the start buttons; Codex writes its rollout only with its first
message, so after a Codex start the Chat view asks for that message in the terminal.

`/worktrees` (`caps.worktrees`: Herdr 0.9.2 or later, not on Windows) drives Herdr's
`worktree.*` calls from a workspace's menu. The GET lists the worktrees of the workspace's
repository (`worktree.list`) and its local branches, newest commit first, read by the server's
own git (`for-each-ref`, at most 500). The POST checks out `branch` in a new worktree, made from
`base` (empty: the current HEAD) when the branch is new; Herdr ignores the base of a branch that
exists, so that pair answers 409 `branch_exists` instead. `open` opens an existing linked
worktree (by its branch), never a branch without one. The DELETE carries the path and branch the
user confirmed and removes nothing unless the workspace still shows that linked checkout (409
`changed`); without `force` a worktree with changes answers 409 `dirty`, which the PWA asks
about a second time. Removing deletes the checkout (ignored files too, and with `force` the
panes end first) and closes the workspace; the branch is kept. Changes run one at a time (503
`busy` after a 5 s wait) and outlive the client for up to 60 s; past that the answer is 504
`unknown` (Herdr may still finish). The snapshot's `worktree` marks a workspace of a Herdr
worktree group (`linked`: a linked worktree, else the repository's own checkout); its `branch`
is read from `worktree.list` in the background, at most every 10 s per repository and never on
the snapshot's own path, so it can be missing for a moment. See Security Model.

`caps.scroll` (Herdr): the stream only carries screen renders, so no history reaches the
xterm.js scrollback. The PWA turns the mouse wheel and the scroll buttons into
`/scroll` calls instead: `lines` rows back into the pane's history (negative: toward the live
screen, at most 10000 either way), clamped by Herdr. This moves the pane's shared view, so the
Herdr desktop scrolls with it; typing in the PWA returns it to the live screen first.
An agent that leaves no history in Herdr (Claude Code in fullscreen mode draws on the alternate
screen) gets SGR wheel reports instead, one per row and at most 50 per call; returning to the
live screen sends Claude Code's Ctrl+End. A pane without an agent is never sent wheel reports.

`apiVersion` is bumped on every breaking change to this API; the PWA compares it with its own
build and reloads on mismatch. A health `version` other than the PWA's own (or a new service
worker waiting, `registerType: 'prompt'`) only shows a Reload banner, so an unsaved edit is never
lost to a reload; the reload tells the waiting worker to skip waiting first. `install`
(`release`, `checkout`, `container`, `unknown`) names the update command Settings > Updates shows. The old `/api/tmux/*` paths and the `/terminal/` iframe route
are gone; `/terminal/` now answers `410 Gone` so a stale cached PWA bundle gets a readable
error instead of a broken page.

### Agent chat (`/api/mux/panes/{id}/agent/*`)

The PWA's Chat view is a second way to look at a pane running Claude Code or Codex, offered
when the snapshot reports `caps.agentChat` and the pane's `agent.name` is `claude` or `codex`
(`pwa/src/chat-agents.ts`). It is the same session as the terminal, not a session of its own:
nothing runs headless. Both agents take a message and a dialog answer under the rules in
"Writes" below, each with its own screen reader
(`agentScreenReaders`: `agent_claude_prompt.go`, `agent_codex_prompt.go`); `commands` is an
empty list for Codex, whose composer offers no built-in `/` commands either.

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
window's active pane: a split window chats with the pane that has focus. Reads and writes go to
tmux's own pane id (`%N`, unique on the server, which stays on its pane) on tmux, and to the
window (`$N:i`, from psmux's reply rather than the client's id, so one window has one pane lock)
on psmux, which numbers panes per session: every session has a `%1`, and `-t %1` reaches the
most recent one. On psmux the target follows the window's focus; the process, session and
screen checks before each write still apply.

Claude Code writes its transcript only with a session's first message. Until then
`transcript` answers an empty conversation (`reset`, no entries) whose cursor names the session
with no file, so the Chat view can send that message; the read after it finds the file under
another identity than the cursor's and starts over.

**Finding a Codex session.** Only a Codex TUI run with `--no-daemon` writes its own rollout. By default a shared
`codex app-server --managed-daemon` writes the rollout of every pane, outside every pane's
process tree but the one that started it, and Herdr's hook runs in that daemon and reports the
session to the wrong pane: such panes have no Chat view on either backend. On tmux the walk
above also takes a process as Codex when all of these hold: its executable is named `codex`
(`/proc/<pid>/exe` on Linux, the exec path in `kern.procargs2` on macOS), checked before any of
its files are listed, so a pane without Codex costs no fd scan; its argv does not contain
`app-server`; it holds open **for writing** (`fdinfo` flags on Linux, `lsof` on macOS) a regular
file `rollout-*-<uuid>.jsonl` that resolves inside `<CODEX_HOME>/sessions`, with `CODEX_HOME`
read from its environment (else `$HOME/.codex`); and exactly one such file has
`session_meta.thread_source` `user` (sub-agent threads are skipped). After `/new` the process
holds the old and the new rollout, so the pane has no Chat view until Codex is restarted. Herdr
reports the session id (`herdr integration install codex`); the server accepts it only when a
process among all of the host's passes the same checks holding that very rollout, and takes
`CODEX_HOME` from that process. It trusts the id as Herdr reports it: after `/new` the process
still holds the old rollout, so the pane shows whichever session Herdr names, and a pane whose
hook once ran in a daemon can name another pane's session. Windows (psmux, Herdr) never finds a Codex session. On tmux, a Codex found
in a pane without such a rollout is logged once per run (usually a Codex before its first
message or in daemon mode), so a Codex update that moves its files does not go unnoticed. Checked with Codex 0.159.3.

The rollout read is the file that process holds: its resolved path and file identity
(dev:inode) are recorded when it is found, and `transcript` refuses a file whose identity
changed. Entries come from `event_msg` `item_completed` rows (user and agent messages, reasoning
summaries, commands, file changes, MCP and extension calls, compactions), or `user_message` and
`agent_message` in a legacy rollout; the messages Codex adds for the model (`response_item`) are
never shown. The tmux status reads back from the end to the latest of `task_started` (working),
`task_complete` or `turn_aborted` (idle); it is never `blocked`, since the rollout does not record
an approval request (so a dialog is never answerable on tmux, see Writes). `thread_settings_applied` is skipped: Codex writes it for a model change in
the middle of a turn as well as for a resume, so a turn killed and then resumed reads as working
until the next turn ends. Herdr reports its own status.

**Transcript.** `<claudeDir>/projects/*/<sessionId>.jsonl`, with `sessionId` a UUID and the
resolved path inside that config dir. Reads are incremental from a signed `cursor` (a position
in one file), or backwards with `before`; lines over 2 MB are skipped and image blocks are
dropped from the entries. When the cursor names another session or a file that was replaced,
the server reads the end of the current file again and answers `reset: true`: the entries
replace what the client holds (a `/clear` or a resume changed the session). Reads are shared
between clients through a 500 ms cache per pane.

**Custom commands.** `commands` lists the slash commands and skills the Chat composer
suggests after `/`, next to Claude Code's built-ins (a static list in the PWA,
`pwa/src/utils/slash-commands.ts`). It reads `.claude/commands/**/*.md` and
`.claude/skills/*/SKILL.md` under the pane's root (the Files view's root; none on a backend
without pane directories, or a root in a denied dir), then `commands/` and `skills/` in the
session's Claude config dir, each opened as an `os.Root`, so a symlink leading out of it is not
followed. A file that is itself a symlink is never read (inside the root it could still name
`.env`), symlinked dirs under `commands/` are not walked, and a file the files routes would
refuse (a denied dir, a sensitive name) is skipped. A command in a subdirectory is named `dir:name`; a skill takes its front matter `name`,
else its directory, and one with `user-invocable: false` is left out. Only the first 8 KB of a
file is read, for the front matter `description` or else the first line, clipped to 200
characters: the body never leaves the server. A top-level entry of `skills/` that is a symlink to
a dir is followed when its target resolves inside the config dir, the pane's root or the server
user's `~/.agents/skills` (where skill managers install): the target is opened as an `os.Root`
of its own and only its `SKILL.md` is read, a regular file and not a symlink.

Plugins add a third source, `plugin`, after the user's. `<config dir>/plugins/installed_plugins.json`
gives each `<name>@<marketplace>` its installs; `enabledPlugins` in the config dir's
`settings.json`, then the project's `.claude/settings.json` and `.claude/settings.local.json`,
turns it on or off (a later scope wins). An install made for another project (`projectPath`) does
not count, and an `installPath` is opened (as an `os.Root`) only when it resolves inside
`<config dir>/plugins/`: no path taken from the JSON is followed elsewhere. A plugin's
`commands/**/*.md` and `skills/*/SKILL.md` are named `<plugin>:<name>`; a symlinked skill dir in
it may only lead elsewhere in the plugin. The JSON files sit at fixed paths and may be symlinks
(dotfile managers link `settings.json`); only `enabledPlugins`, `installPath` and `projectPath`
are read from them. At most 50 plugins and 500 entries in all; a JSON file over 1 MB or not
valid is ignored, which leaves the project's and the user's commands.

At most 500 entries per dir and 5000 dir entries looked at, `commands/` walked 4 levels deep; a
name met twice keeps the first (project, then user, then plugin). It is a GET, so it checks
`Sec-Fetch-Site`/`Origin` itself like the files routes, and answers 404 without an agent session.
Results are cached 5 s per root and config dir.

**Writes: only on positive evidence.** The two POST routes pass the Host allowlist, auth and
`writeGuard` like every other write. Each then takes a lock on the pane, re-reads the session
bypassing every cache, and checks it is still the process and session the client saw; anything
else is refused and sends nothing:

| Code                      | Status | Meaning                                                                                |
| ------------------------- | ------ | -------------------------------------------------------------------------------------- |
| `session_changed`         | 409    | The pane runs another session now (the client's `cursor` names the old one)            |
| `target_changed`          | 409    | The agent is no longer in this pane, or its process, session or rollout changed        |
| `input_not_ready`         | 409    | Not an empty input box: a dialog, a draft, the agent working, copy mode                |
| `paste_not_confirmed`     | 409    | The pasted text did not show in the input box; Enter was not sent                      |
| `delivered_not_submitted` | 502    | The text is in the input box but was not submitted; check the terminal                 |
| `prompt_changed`          | 409    | The dialog on screen is not the one the client answered; the reply carries the new one |
| `prompt_expired`          | 409    | The `promptId` was already used, is unknown, or is older than 60 s                     |
| `answer_not_confirmed`    | 502    | The key was sent but the dialog is still open                                          |
| `text_not_confirmed`      | 502    | A typed answer did not show in the free-text option, or was not submitted              |
| `invalid_choice`          | 400    | `choice` is not one of the dialog's options                                            |
| `invalid_text`            | 400    | A typed answer is empty or holds a control character (a newline or tab included)       |
| `text_too_long`           | 413    | The text is over 16 KB (a typed answer: 1 KB); the reply carries `limit`               |
| `invalid_request`         | 400    | The body is not the JSON the route expects                                             |

`message` pastes the text (bracketed paste, through a named tmux buffer or Herdr's writer) only
when the screen shows an empty input box, waits until the text shows in it, checks the session
again, then sends Enter. The text is at most 16 KB (UTF-8 bytes; the body 64 KB), with control
characters other than newline and tab removed, so it cannot end the paste early.

**Codex writes.** The same routes, with these differences. The pane lock is keyed by the pane's
backend address alone, so two agents in turn on one pane share it. `sameAgent` also compares
the rollout (resolved path and dev:inode), so a Codex that moved to another rollout is
`target_changed`. The screen reader (`server/agent_codex_prompt.go`, checked against recorded
screens of Codex 0.159.3 and 0.160.0 on tmux and Herdr, `server/testdata/codex/screens`) draws
no frame to lean on: the composer is a `›` row at column 0 not in reverse video, with at most
four footer rows under it. A message is sent only onto an empty composer (Codex's faint
placeholder counts as empty) with no working line (`• Working (… esc to interrupt)`) in the
rows above it, and with status idle or done. The paste must show in the composer before Enter:
for a paste over 1000 characters Codex shows `[Pasted Content N chars]` instead of the text,
and that token is matched against the text's length. A dialog-like text the model printed above
the composer is never a dialog: an approval dialog is recognised only with its footer ("Press
enter to confirm or esc to cancel") as the last row, a known title (run a command, make edits)
with no row at column 0 between it and the numbered options, and every option ending in the key
Codex shows for it. If a second approval title sits in that stretch, the rows above the title
reach the top of the screen without a row at column 0 (the dialog's top may have scrolled off),
or the options do not parse, the card is read only (`unsupported`). The body is sent whole, as
for Claude Code.

Who may answer is decided by `dialogStatus`: the agent's own status must say a dialog is open.
On Herdr it reports `blocked`, so an approval card has options and a single-use `promptId`;
`answer` sends the option's digit, or Escape for `"cancel"`. On tmux the rollout records no
approval request, so the status is never `blocked`: `AgentSession.DialogsReadOnly` makes
`prompt` answer `unsupported` with no options and no `promptId` (the PWA shows "Answer this
dialog in the terminal."), and `answer` has nothing to consume. Other Codex dialogs (model
picker, rate-limit prompt, …) are always read only, on either backend.

`prompt` reads the screen and recognises the dialog anchored at its bottom: `permission`, a
single-choice `select` (at most 9 options), a `multiselect` tab, or `unsupported` for anything
else, which the PWA shows read-only with a way to the terminal. A question keeps its buttons,
"Chat about this" included; its free-text option is not one of them. That option is the last
one above "Chat about this": its label is "Type something" (drawn faint under the pointer, so
text typed to read the same is not taken for it) until text is typed into it, then the text,
wrapped onto the rows below it. With the pointer (`❯`) on it a digit is typed into the text
instead of picking an option, so the question is `unsupported` until the pointer moves off it.
A tab is `multiselect` only when every option but "Chat about this" has a box. The body and
every option's detail are sent whole, never cut (the dialog search, `claudeMaxDialogRows`,
bounds them), so the card can show all a dialog asks. The dialog's top edge is a rule at column
0: a rule inside a command (a heredoc's separator) is indented, so it is never taken for the edge
and the card never starts partway through the command. Claude Code 2.1.288 draws a command's rows
behind a `│`, a file's behind its line number and a carriage return in a file as `�`, and refuses a
Bash command holding a control character, so neither a wide character nor a carriage return puts
a rule at column 0 (recorded on tmux and Herdr). In a narrow pane Claude Code can draw `3. No`
over the last row of a wrapped path above it without clearing that row's end (`3. Nooject`):
the last option of a `permission` dialog, under one that wraps, reading `No` followed by anything
but `,` is read as `No`, and the option above gets `…` for the row it lost. In the PWA the card
takes at most 70% of the screen, its content scrolls and the Cancel row stays at its foot. A body
taller than its box shows a fade and **Show all**; on a `permission` card only the refusing
options can be tapped until the body is opened or scrolled to its end, so a long command is not approved unread.

While the free-text option is empty the prompt carries it as `freeText` (`{index, label}`), and
`answer` takes `{"text": "..."}` for it: at most 1 KB (UTF-8 bytes), not blank, with no control
character at all (a newline or tab included). The text is refused whole, never cut or cleaned,
and the promptId stays usable. Then, one key at a time, each checked on a new read of the same
question (title, text, tabs, free-text option):

1. the pointer onto the option: its digit on a single-choice question; Down a row at a time on
   a multiSelect tab, where a digit only toggles it (so `freeText` is offered there only with
   the pointer on an option above it);
2. once the option shows its placeholder under the pointer and the session is the same, the
   text, pasted;
3. once the option shows the text (ticked, on a multiSelect tab) and the session is still the
   same: Enter on a single-choice question, which picks it (a wizard moves to the next tab);
   Up on a multiSelect tab, which leaves the text ticked and the tab answerable for "Next".

Escape is never sent: inside the option it leaves the whole dialog. A read that does not show
the step's effect stops before the next key: `prompt_changed` with the dialog now on screen,
`answer_not_confirmed` when the pointer did not move, Enter did not close the question or Up
did not leave the option, `text_not_confirmed` when the text did not show (the text itself: a
`[Pasted text #n]` token is not taken for it) or the session changed after it was pasted (the
text may be left in the option). A promptId reused for the same dialog holds its latest read,
since the signature leaves out the pointer that decides whether a multiSelect tab offers
`freeText`. Holding
text with the pointer away, the option is a toggle of a multiSelect tab like the others; on a
single-choice question it has no button, since its digit only moves the pointer into it.

Options with previews draw the preview of the option under the pointer on the right of the
option rows; a footer offering "n to add notes" announces them. Each option row is read up to
where the preview box starts (two spaces or more, then its edge: not a column, since a wide
character takes two columns), and the preview's own rows and the "Notes" row are skipped. A
preview the footer does not announce makes the question `unsupported`. "Chat about this" there
has no number (so no button) and there is no free-text option. A digit only moves the pointer on such a question, so `answer` sends the digit, waits for
the pointer to be on that option of the same question (title, tabs, options), and only then
sends Enter; a pointer already there gets Enter alone.

An `AskUserQuestion` with several questions (a tab row `←  ☒ Size  ☐ Drink  ✔ Submit  →`) is
answered one tab at a time. The row becomes `steps` (`label`, `answered`, `current`); the tab
open is the one Claude Code draws on a background colour, which is also part of the dialog's
signature, so two tabs that read the same are told apart. A digit on a single-choice tab picks
the option and moves to the next tab, a new screen with its own signature and `promptId`. On a
`multiselect` tab (options carry `checked`) a digit toggles one option and the tab stays open;
`"next"` sends Right, which leaves the tab with its options kept (a single multiSelect question
has `✔ Submit` as its second tab). `{"step": n}` opens another tab: Right or Left one key at a
time, and after each key the screen must show the same tabs (by label) with the next one open,
and a tab the arrows pass must not be `unsupported`; otherwise nothing more is sent and the
reply carries the dialog on screen (`prompt_changed`, or `step_not_confirmed` when the tab did
not change). Leaving a multiSelect tab with nothing ticked does not answer it. The row does not wrap: Left
on the first tab and Right on Submit do nothing. A tab row is read only whole, from `←` to
`→` with at least one question, Submit last and exactly one tab open; a row cut or wrapped by a
narrow pane, or one whose open tab is not known, is `unsupported`. Escape on the Submit tab
declines the questions, as `2. Cancel` does. The Submit tab ("Review your answers", `1. Submit answers` / `2. Cancel`) is
drawn without a footer: it is recognised only when the tab row sits right under the dialog's
top rule with Submit open, no other rule follows, and its options are the last rows.
Every client polling one dialog gets the same single-use `promptId`. `answer` consumes it,
checks the session, the agent's status (on tmux the session file must say a dialog is open)
and the dialog's signature on screen, then sends the option's digit, Escape for `"cancel"`, or
the arrows above. The keys a route may send are Enter, Escape, Left, Right and the digits 1–9.
A screen the detector does not recognise is never written to.

The Chat view renders the agent's markdown without raw HTML and never loads images: an image
becomes a text link, so a transcript cannot make the browser fetch another origin. The routes
call `requireAgentRead`/`requireWriteRole`, where a view-only role (#236) will be enforced;
the PWA's `readOnly` mode already hides the composer and the answer buttons.

### Files and changes (`/api/mux/panes/{id}/files/*`)

The PWA's Files and Changes views read a pane's directory, offered when the snapshot reports
`caps.files`: tmux on Linux and macOS (`#{pane_current_path}` of the window's active pane) and
Herdr (`foreground_cwd`, else `cwd`, of the pane; a Herdr that reports neither answers 501).
psmux does not report the directory, so `caps.files` is off on Windows tmux. Every route is
registered for every backend and answers 501 where it is off. Six are read-only GETs (`find`
included); `PUT files/content` saves a text file, `POST files/create` creates an empty one and
`POST files/delete` / `files/restore` remove a file and put it back (see Saving a file, Creating
a file, Finding a file, Deleting a file).

**Root.** The pane's directory, raised to `git rev-parse --show-toplevel` when it is in a
repository and a `.git` sits at that toplevel (a `core.worktree` naming another directory, even
`/`, leaves the pane's directory as the root); resolutions are cached for 2 s. A directory a foreground command only passes
through does not move the root: a new root is taken once reads at least 2 s apart
agree on it. Every response
carries `root`; a client sends back the root it saw, and gets `409 {error, root}` with the
current one when it moved, so it reloads instead of mixing two trees. `safe.directory` is
passed for the toplevel only when it belongs to the server's user (or is under `/workspace` in
the container).

**Paths.** A client path is relative to the root: absolute paths, `..`, NUL and (Windows)
drive or device names are refused with 400, and every open goes through `os.Root`, so a symlink
that leaves the root fails too (400 `path outside root`). Termote's config and state
directories (`serveConfig.FilesDenyDirs`, filled by `runServe`), `/proc`, `/sys`, `/dev`, the
repository's `.git` and its git directory wherever it is (`git rev-parse --absolute-git-dir`,
for a `--separate-git-dir` inside the root) are never served (403 `path not allowed`), checked
on the path and on what it resolves to; `.git` is also left out of listings, and a symlink into
one of them is listed without its target's type or size. Files are opened non-blocking and judged on
the open handle: anything not a regular file, over 1 MiB, or binary (a NUL in the first 8 KiB,
or not UTF-8) is answered `previewable: false` with a `reason`. A directory lists at most 5000
entries.

**Sensitive files.** Names that usually hold secrets (`server/files_sensitive.go`: `.env*`,
keys, `.netrc`, `credentials*`, `*.tfstate`, anything under `.ssh`, `.aws`, …) are listed with
`sensitive: true`, through symlinks and on either side of a rename. Their contents and diffs are
returned only with `reveal=1`, which the PWA sends after the user confirms, every time. This is
a warning, not a boundary; the deny list above is the boundary.

**git.** `changes` runs `git status --porcelain=v2 -z --branch` (at most 5000 entries, cached
2 s per root); `diff` serves only a path that status lists, on the side asked for
(`git diff [--cached] -M -- :(literal)<orig> :(literal)<path>`, at most 1 MiB, then
`truncated`). An untracked or conflicted file has no diff: it is read whole through `os.Root`
with the content route's checks. git is run as an argument array (no shell), with `GIT_*` and
`TERMOTE_*` removed from its environment and overrides a repository cannot undo:
`core.fsmonitor=false`, `core.hooksPath` set to the null device (no hook runs, even the
`post-index-change` an index refresh would trigger), `diff.autoRefreshIndex=false`, every
`filter.<driver>` it configures emptied, `--no-ext-diff`, `--no-textconv`,
`--ignore-submodules=all`, no lazy fetch and no transport at all (an empty
`GIT_ALLOW_PROTOCOL`, which a repository's `protocol.<name>.allow` cannot re-enable). Each
command has a 10 s timeout (503 `git timed out`) and takes one of two server-wide slots; nothing
a client sends becomes a git option.

**Images (`raw`).** The bytes of one image, for the PWA to show through a `blob:` URL (an SVG
through a `data:` URL, see below). Without
`side` it reads the file in the worktree, with the content route's checks in the same order
(missing → 404, then sensitive without `reveal=1` → 403 `sensitive`), streamed from the open
handle, never buffered whole. With `side=old|new` (and `staged`, `orig` picking the entry as
`diff` does) it serves one version of an entry git status lists: unstaged old is the index
(`:0:<path>`, or `:0:<orig>` for an unstaged rename or copy; none for untracked,
intent-to-add or a conflict), unstaged new the worktree (none when deleted), staged old
`HEAD:<orig or path>` (none when added), staged new `:0:<path>` (none when deleted). The index
is always named with stage `0`, since git reads `:1:a.png` as stage 1 of `a.png`. A version
from git is read with one `git cat-file --batch` (the name on stdin, a name holding `\r` or `\n`
is 400), with filter drivers disabled and without taking a status/diff slot or backing the
root off; a missing object is 404 `no_version`, a request whose time ran out 503. The type is
told from the first bytes by the helper uploads use (PNG, JPEG, GIF, WebP), plus SVG only when
the path ends in `.svg` and its first element is `<svg`. Limits: 10 MiB (413 `too_large`) and
40 megapixels, read from the header: the largest GIF frame (with its offset) or logical screen,
and a WebP's first chunk (VP8, VP8L, or the VP8X canvas) (413 `too_many_pixels`); anything else is
415 `not_image`, a Git LFS pointer 415 `lfs_pointer`. At most 4 run at once server-wide (429
`busy`), each with a 2-minute write deadline. A response carries `Content-Disposition: inline`,
`Cache-Control: no-store` and `Cross-Origin-Resource-Policy: same-origin` (another site's
`<img>` cannot probe for files); an SVG also gets a second CSP,
`sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:`, and
`Content-Disposition: attachment`, so opening its URL runs no script under termote's origin.

**Saving a file (`PUT content`).** Replaces the whole text of an existing file (no delete or
rename; a new file comes from `POST create`, below) in `server/files_write.go`. A signed-in user already has a shell in the
terminal, so the route grants nothing new; what it guards is not overwriting an agent's change
and not opening a write path into what the reads refuse.

- The `root` query is required (400 without it, 409 with the new root once the pane's moved);
  the body is `{path, baseHash, text, reveal}`. `baseHash` is the `hash` GET `content` returned
  (sha256 of the bytes read): bytes on disk that differ from it answer 409 `changed`, unless
  they already equal the text being saved, which answers 200 (a save repeated after a lost
  reply is not a conflict). There is no overwrite.
- The path checks of a read (`cleanRelPath`, deny dirs, `.git`, the git dir) plus a write-only
  deny list: the install's data dir (its `current` pointer picks the binary the service runs)
  and the upload store. A sensitive name needs `reveal: true` (403 `sensitive`).
- The parent directory is opened once through `os.Root` after checking no component of the
  path is a symlink, and every later step uses that handle. The file must be a regular file
  with one link, owned by the server user (Unix), writable by its owner, UTF-8 without NUL,
  and with uniform line breaks (all `\n` or all `\r\n`); otherwise 422 `not_editable` with a
  `reason` (`symlink`, `not-regular`, `hardlink`, `mixed-eol`, `nul`) or 403 `permission`
  (`not-writable`, `other-owner`, EACCES). GET `content` runs the same check and reports it as
  `editable`/`notEditable`, so the PWA offers Edit only where a save would be taken.
- The text arrives with `\n` line breaks (a textarea's); a `\r\n` file gets them back. Text
  with NUL or a lone `\r` is 422 `not_text`; the file and the final bytes are at most 1 MiB
  (413 `too_large`). The body has its own limit, 6 MiB + 64 KiB (JSON writes a control
  character in six bytes), not the 8 KB of other routes; 2 saves at a time server-wide (429
  `busy`), and once authenticated and given a slot the read deadline grows to 5 minutes.
- The new bytes go to `.termote-edit-<random>` in the same directory (`O_EXCL`, 0600, the
  file's mode set on the open handle, then `fsync`), the file is read again and must still
  hold what was checked, then the temporary file is renamed over it. A read-only mount (EROFS,
  Windows `ERROR_WRITE_PROTECT`) answers 403 `read_only` and a full disk or quota 507
  `storage_full`, as a create does; EACCES 403 `permission`. Any failure removes the
  temporary file, and a save removes ones older than 10 minutes left in its directory (only
  names of exactly that form: a user's `.termote-edit-notes` stays). Every
  `.termote-edit-*` name counts as sensitive. Saves of one file are serialised in the process,
  and a save drops the root's cached git status, so the Changes view's next read sees it.
- Limits: a file system has no compare-and-swap, so an agent writing the file between the
  last read and the rename still loses its change (the lock and the second read only narrow
  that window). The rename makes a new inode: ACLs, xattrs and SELinux labels of the old file
  are not kept (its owner is, since a file of another user is refused). File contents are never
  logged.

**Creating a file (`POST create`).** Creates an empty file, and the directories missing above
it, in `server/files_create.go`; the text then goes through `PUT content`. As for a save, the
route grants nothing a shell does not; what it guards is never replacing anything and never
making anything inside what the reads and saves refuse, through a symlink, a junction or a
short name included.

- The `root` query is required (400, 409 with the new root once it moved); the body
  `{path, reveal}` is read with the 8 KB JSON limit before anything else, and the read deadline
  is not extended. 201 `{root, path}` on success.
- The name is checked before anything touches the disk (400 `invalid_name`): no empty component
  (a leading, doubled or trailing separator), at most 32 components and 1024 bytes, 255 bytes a
  component, none ending in a dot or a space (Windows drops them, so `a.` would open `a`), no
  control character (`files/raw` refuses a name with a line break), no `<>:"|?*` on Windows, not a `.termote-edit-<16 hex>` name, then `cleanRelPath` (a Windows
  device name too).
- The deny dirs, `.git` and the git dir, and the write-only deny list answer 403 `not_allowed`;
  a sensitive name needs `reveal: true` (403 `sensitive`).
- One lock per root (creates in a root run one at a time), taken after the name checks and
  before one of the 2 write slots shared with saves (429 `busy` when none is free): a create
  waiting on another one in its root holds no slot, so it never makes a save get 429. The walk opens each directory from
  the one before: `Lstat`, `Mkdir` (0777 under the umask) when it is missing, `OpenRoot`, and
  the directory opened must be `SameFile` with the one checked. A symlink, a Windows junction
  (Go reports it irregular, neither a symlink nor a directory), or a directory swapped in
  between, answers 403 `symlink`; a parent that is a file 409 `not_directory`;
  EACCES 403 `permission`; EROFS (Windows `ERROR_WRITE_PROTECT`) 403 `read_only`; ENOSPC or
  EDQUOT (Windows `ERROR_DISK_FULL`, `ERROR_HANDLE_DISK_FULL`, `ERROR_DISK_QUOTA_EXCEEDED`) 507
  `storage_full`, the code uploads use. Each directory is checked against the deny lists again once it
  exists, before anything is made inside it: a path that does not exist yet can only be
  compared by name, which misses an 8.3 name (`TERMOT~1`) or a junction.
- The file is opened `O_CREATE|O_EXCL` (0666 under the umask) on its parent's handle: anything
  already there, a dangling symlink included, answers 409 `exists` with `path`, the name as a
  create would have reported it (`/`-separated), and is never replaced; the PWA's Open it opens
  that `path`. A reply that arrives after the user closed the box opens nothing: the PWA only
  reads the tree again.
  Directories made before a later step fails stay, as with `mkdir -p`. A create drops the
  root's cached git status.
- Accepted risk: a new file can be one another tool trusts or runs (`.claude/settings.local.json`,
  `.claude/commands/*.md`, `.vscode/tasks.json`, `.github/workflows/*`, a systemd or launchd
  unit when the root is the home directory). A signed-in user has a shell anyway; the
  view-only role (#236) must refuse creates as well as saves.

**Finding a file (`GET find`).** Names under the root that match a query, for the PWA's "Find a
file" box, in `server/files_find.go` and `server/files_find_match.go`. The `root` query is
required as elsewhere. It answers names only (`path`, `ignored`, `sensitive`), never contents.

- `q` is trimmed and must be 1 to 256 bytes. `exclude` (repeated) names folders to skip: at most
  50, each one directory name of at most 255 bytes, not `.` or `..`, with no `/`, `\`, NUL, `*`,
  `?` or `[` (400 `invalid_exclude`). `ignored=1` adds ignored files; `fresh=1` skips the cache.
- In a repository the list is `git ls-files -co --exclude-standard --deduplicate -z`, minus the
  files deleted from disk (`ls-files -d`), with the directories git lists (a nested repository, a
  submodule) dropped. Tracked files are always searched, even under an excluded name. With
  `ignored=1`, `git ls-files -o -i --exclude-standard --directory -z` is added and the ignored
  directories it names are walked through `os.Root`, never entering an excluded name at any depth.
  Outside a repository the root is walked, excluded names never entered, symlinked directories
  and junctions not entered, symlinks to files listed.
- Limits: 200 results (`truncated`), 200,000 paths read, depth 32, a walk of 5 s and 16 MiB of
  git output; past the last three the list is `incomplete`. A git timeout answers 503 but does
  not make the root back off, so Changes keeps working. A root's file list is cached for 30 s
  and dropped by a save, create, delete or restore; the PWA's Refresh sends `fresh=1`.
- `.git`, the git dir and the deny dirs (config and state, the upload store, the trash) never
  appear, checked through symlinks.

**Deleting a file (`POST delete`, `POST restore`).** `server/files_delete.go` and
`server/files_trash.go`. As for a save, a signed-in user has a shell; what these guard is losing
a change an agent just made and never touching what the reads refuse.

- Same guards as create and save: `writeGuard`, the handler's cross-site check, `requireWriteRole`,
  `root` required (400, 409 once it moved). The body is `{path, kind: "file"|"dir", baseHash,
  reveal, permanent}`. `baseHash` must be the file's sha256 (409 `changed` otherwise); the PWA
  takes it from the open text or from GET `content?hash=1`, which answers size and hash without
  reading the contents out, a sensitive file included. A file over 512 MiB gets no hash (413
  `too_large`): it is deleted from a terminal.
- A file is renamed into the trash, `os.UserCacheDir()/termote/trash` (`serveConfig.TrashDir`,
  set by `serve`): created 0700, refused when a symlink or (Unix) owned by another user, and then
  the route answers 503 `trash_unavailable`. The snapshot's `Caps.trash` tells the PWA. An empty
  directory is removed with `rmdir`, with a record so that restore makes it again; a non-empty one
  is 409 `not_empty`, and the root itself is never deleted.
- Refusals: a symlink or junction on the path or as the target 403 `symlink`; several hard links
  409 `hardlink`; another owner 403 `permission`; read-only 403 `read_only`; deny dirs 403
  `not_allowed`; a sensitive name without `reveal: true` 403 `sensitive`; no free write slot 429
  `busy`.
- Another file system (`EXDEV`: WSL `/mnt/c`, a volume, the container's `/workspace` bind mount)
  cannot be renamed into the trash: 409 `cross_device` and nothing is deleted. The PWA then asks
  a second time ("Delete permanently? This cannot be undone.") and only then sends
  `permanent: true`, which removes the file with no Undo. So in the container every delete under
  `/workspace` is permanent, after the second confirmation.
- `POST restore` takes `{trashId, reveal}` and puts the entry back at its path, making missing
  parent directories; it never replaces anything (409 `exists`).
- The trash keeps an entry 7 days, at most 1 GiB in all (the oldest go first), and never removes
  one younger than an hour (`trashMaxAge`, `trashMaxTotal`, `trashMinAge`). Nothing lists the
  trash: the PWA has no trash browser, only the Undo of the delete that made the entry.
  `uninstall` keeps it (see Uninstall).

**Guards.** Basic auth and the Host allowlist like every route; GETs pass `writeGuard`, so the
handlers check `Sec-Fetch-Site`/`Origin` themselves (403 cross-site), which keeps another page
from making a `--no-auth` server run git. `PUT content`, `POST create`, `POST delete` and `POST restore` go through
`writeGuard` like every write (same-site, `application/json`) and their handlers check again.
Other methods get 405.
`requireFilesRead` and `requireFilesWrite` are where a view-only role (#236) will be enforced;
`requireWriteRole` is still a stub, so today a view-only client is kept from editing only by
the PWA, which hides Edit, New file and Delete in `readOnly` mode.

**PWA.** Edit (Files, and the diff of a file the working tree still has as text in Changes)
turns the file into a plain `<textarea>` (`file-editor.tsx`), a Markdown file as its source.
The draft is kept per pane and path in `use-files.ts` (`useFileDraft`), in memory only, so a
remount, a switch of view or tab or a move of the root does not lose it (a draft read under an
old root can no longer be saved, only copied); Files and Changes share the draft of a path.
Several files can have drafts at once; closing a tab with one asks first, a move of the root
asks before closing the old root's tabs that have one, and leaving the page asks while any
file has one; a 409 `changed` keeps it with Reload and Copy my text, and a
timeout says the save may have gone through (saving again is safe). In Changes the editor
lives in the diff's tab; a save goes back to the unstaged diff, read again (in the tab that side
already has, else this one), and the tab closes once git status no longer lists it.

New file (the Files header, over the tree only) asks for a path from the root in a sheet
(`new-file-dialog.tsx`), prefilled with the directory the tree has focus in. A sensitive name
is created after a second ask. Once made, the store (`created`) reads the root and every
directory above the file again, opens them, and opens the file in a pinned tab straight into
editing (the tab's `intent`, with the reveal it was created with): the draft, `hash` and `editable` come from GET `content`. A 409 `exists`
offers Open it; a lost reply says the file may have been made, with Refresh, and never guesses
from the tree.

Find (`file-search.tsx`) is a box at the top of the Files view (above the keyboard on a phone).
It asks `find` after a 150 ms pause and shows the results in place of the tree (ignored ones
dimmed and tagged, a lock for a sensitive name); opening one opens the tree down to the file, and
Back returns to the results. "Include ignored" (setting `findIncludeIgnored`, only in a repository)
and the excluded folder names (setting `findExcludes`, defaults in `use-settings.ts`, edited in
Settings → Files) are sent as `ignored` and `exclude`. The Changes view has a client-side filter
on the path (a rename's source too) once the list has more than 15 entries; it asks the server
for nothing.

Delete is in a tree row's menu, on the Delete key of the focused row and in an open file's header
(`delete-file-dialog.tsx`; the dialog shows the full path and Cancel has the focus). It sends the
hash it has or reads one with `content?hash=1`, then shows a toast with Undo (`files/restore`) for
10 s. A 409 `cross_device` opens the second, permanent confirmation described above.

One store per pane for the tree (`use-files.ts`) and for the status
(`use-git-changes.ts`, polled every 5 s while a view shows it and the page is visible, backing
off to a minute on errors), shared by the mobile view and the desktop panel. Highlighting runs
in a worker with a 3 s timeout and only for files up to 256 KiB, 5000 lines and 2000 characters
a line; tokens are rendered as spans, never as HTML. A Markdown file (`.md`, `.markdown`, `.mdx`,
up to 256 KiB) is previewed by `markdown-preview.tsx` (lazy chunk): the Chat view's rules
(`utils/markdown-safety.ts`: raw HTML as text, only http(s) links leave the app, no image
loads), fenced code through the same worker, and relative links resolved client side by
`utils/markdown-links.ts` against the file's directory (a leading `/` is the root); a path that
would leave the root is never built, so never requested. Following a link reads the target's
parent directory to tell file from folder; the files store keeps a Back trail with scroll
offsets. Changes previews the working-tree version of a changed Markdown file the same way.
An image (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`) opens through `raw` instead: Files shows it
(`image-preview.tsx`), Changes shows its two versions side by side, stacked on a phone
(`image-compare.tsx`), reading nothing for a side without a version. An SVG shows as text or a
diff until the user picks "Image" (setting `svgPreview`). `use-image-blob.ts` turns each read
into a `blob:` URL (an SVG into a `data:` URL: opened in a tab of its own, a `blob:` SVG would be
a document of termote's origin without the server's `sandbox` policy, while a `data:` one has an
opaque origin), keeps the previous image while reading again, and revokes every `blob:` URL once
replaced or unmounted; Changes reads again on a refresh or a new status, not on every poll.

### Agent notifications (`/api/mux/push/*`)

The setting "Notify when an agent needs me" notifies when a pane's agent becomes `blocked`
(from a known other status) or goes from `working` to `done`/`idle`. A missing or `unknown`
status keeps the last known one, and a first sighting never notifies. The PWA
(`pwa/src/utils/agent-notify.ts`) and the server (`server/push_watch.go`) run the same rule,
held to `server/testdata/agent-transitions.json`.

```
Agent status (Herdr event / Claude session file)
  ├── PWA open: each snapshot poll → transitions → notify (no confirmed push on this device,
  │     not the visible, focused pane) through the service worker
  └── server watcher, every 5 s, only with ≥1 subscription → peekSnapshot (never creates)
        → transitions → queue (64, oldest dropped) → sender (4 at a time, 5 s each)
        → push service (allowlist, IP check after DNS, no proxy, no redirects)
  notify-sw.js: push → names from /api/mux/snapshot?peek=1 (3 s) → showNotification (always)
                notificationclick → focus a window + postMessage(hash), or openWindow
                pushsubscriptionchange → POST the new subscription
```

- **Watcher**: started by `runServer` only. tmux's `peekSnapshot` reads the sessions there
  without `ensureSession`, so a closed default session is not recreated, and the others still
  notify; `snapshot?peek=1` (the service worker naming a push) reads the same way; Herdr's `Snapshot` is cached
  and has no side effects. Reads and sends run apart, so a slow push service never delays a
  read. A 404/410 drops the subscription; 401/403 is logged and kept; 429 backs that push
  service off for its `Retry-After` (at most 1 h), a timeout for 1 minute.
- **Payload**: `{groupId, tabId, paneId, kind}`, aes128gcm (RFC 8291), VAPID (RFC 8292,
  `sub` = `https://termote.ohnice.app`, 12 h tokens), `TTL: 3600`, `Urgency: high` for both
  kinds, `Topic` = HMAC of pane and kind. Standard library only (`server/webpush.go`).
- **Storage** (`server/push_store.go`): `<stateDir>/push/` (0700): `vapid.json` (private key,
  `topicKey`, `bindKey`) and `subscriptions.json` (at most 20, the least recently subscribed
  evicted), both 0600, written through an `O_EXCL` temp file and a rename. Each subscription
  carries `gen` = HMAC(bindKey, user + password); a server started with another credential
  drops the others.
- **PWA** (`pwa/src/hooks/use-push-subscription.ts`): subscribes in the click that turns the
  setting on (a repair started meanwhile waits for it), and repeats the subscribe POST (an
  upsert) on load, when `caps.push` turns on, every 10 minutes while shown and when shown again
  after as long; a new server key makes it subscribe again. Nothing subscribes while the active
  service worker answers an older version than 2 (no push handler).
  The page notifies itself only while the server has not confirmed this device's
  subscription. Log out removes the subscription first.

## Deployment Modes

### Container Mode (All-in-one)

```bash
termote container up
```

Single container with termote + tmux or Herdr (no ttyd).
Uses `Dockerfile` (`debian:stable-slim`, pinned by digest, `tini -s` as PID 1) and `entrypoint.sh`.
Runs `ghcr.io/lamngockhuong/termote:<version>` (from 1.10.0 by the digest in the release's
signed `image-digest.txt`) with podman (preferred) or docker; from a git
checkout (or `--build`) it builds `termote:local` from the Dockerfile instead of pulling.

**Container Runtime:** Auto-detects podman or docker (podman preferred).

`container up --mux herdr` sets `TERMOTE_MUX=herdr`: `entrypoint.sh` then starts `herdr server`
(a child of tini, without any `TERMOTE_*` variable) with `XDG_CONFIG_HOME=/tmp` and
`HERDR_SOCKET_PATH=/tmp/herdr/herdr.sock`, creates the workspace `main`, and exports only
`HERDR_SOCKET_PATH` so `termote serve` uses the same socket (its config directory stays out of
the world-writable `/tmp`). A server that does not answer within 10s
stops the container. The Herdr binary is pinned by version and sha256 per arch in the
`Dockerfile`. This Herdr sees only the container's terminals.

The container runs as the host uid, which cannot create directories in the root-owned
`/home/termote`; the image creates `/home/termote/.cache` mode 1777 (sticky, like `/tmp`) so
`termote serve` can create its upload dir `~/.cache/termote/uploads` (0700, its own). The
agent runs in the same container, so the path it is given is valid there. `/home/termote/.config`
is 1777 too, so a password the entrypoint generates (no `TERMOTE_PASS`) goes to
`~/.config/termote/password` (0600) rather than to the container log.

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
- `serve` re-applies the mapping at every start (boot, restart, update) and removes it when it
  stops, so the name never leads to a port another user could take; `stop`,
  `start --no-tailscale` and `uninstall` remove only Termote's own mapping
  (`tailscale serve --https=<port> off`, never `serve reset`)

### Uninstall

```bash
termote uninstall [--purge]
```

Removes the service registration, Termote's Tailscale mapping, the `termote` command, the
install root and the upload store (a cache); the saved config and logs stay unless `--purge` is
given (the command prints both paths). The trash of the Files view's deletes
(`<cache dir>/termote/trash`) stays too, since those are the user's files and not a cache; the
command prints its path, and `--purge` removes it (`removeTrash` in `server/install_layout.go`). On Windows the running binary stays locked, so
`uninstall` starts a windowless PowerShell in a console of its own (`CREATE_NO_WINDOW`; with
`DETACHED_PROCESS` Windows PowerShell exits without running the script) that waits for its PID
to exit, then removes what was left (`removeLater` in `server/install_layout.go`). The
launcher `bin\termote.cmd` runs the exe after `(goto) 2>nul`, which leaves the batch first, so
`cmd.exe` never reads it again after `uninstall` deleted it and the exe's exit code is kept
(`& exit /b` reads on to the end of the file and returns 0 under `cmd /c`).

### Self-Update

```bash
termote update                  # Update to the latest stable 1.x release
termote update --version 1.0.1  # Pin to a specific version
termote update --force           # Force reinstall current version
```

**Update flow** (`server/cli_update.go`):

1. Fetch the newest published stable 1.x release from GitHub (the releases list, not the tags: a draft still waiting for approval already has its tag) (or use `--version` to pin)
2. Download the archive and its checksum (mandatory), verify it; from 1.10.0 the checksum comes
   from the release's `checksums.txt`, whose Ed25519 signature (`checksums.txt.sig`) must verify
   with the key pinned in the binary (`server/release_sign.go`)
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
3. **Session cookies**: Stored after initial basic auth to prevent double prompts on mobile;
   Log out (`POST /api/mux/logout`, a JSON write under the same guard) removes the session on
   the server and expires the cookie, so a copied cookie stops working too. Cookies are not
   bound to a port: any service on the same host name receives this one, so Termote needs a host
   name of its own (accepted, see the deployment guide)
4. **Host allowlist**: every request's `Host` header must match loopback, the address the
   request arrived on when `--lan` is set, the Tailscale name (`--tailscale`), or a name added
   with `--allow-host`; there is no wildcard, so DNS rebinding from an attacker-controlled page
   cannot reach the server
5. **Write/CSRF guard**: state-changing `/api/mux/*` requests must be same-site
   (`Sec-Fetch-Site`/`Origin` on the allowlist) and `Content-Type: application/json`, except
   `/api/mux/uploads`, which also takes a raw `image/png|jpeg|gif|webp` body: those types are
   not CORS-safelisted either, so another site's request still needs a preflight that is never
   answered; multipart, which a form posts without one, stays refused
6. **Terminal access** (`/api/mux/stream`): same Origin check, plus a single-use 30s-TTL token
   minted by `/api/mux/stream-token` and consumed on WebSocket upgrade. Every paste (Ctrl+V,
   the iOS Paste menu, the toolbar) loses its end-of-paste markers and control characters other
   than tab and line breaks before it is sent, so text a page put on the clipboard cannot end a
   bracketed paste early and reach the program as typed keys
7. **Herdr guard**: `--mux herdr --no-auth` is refused unless `--allow-herdr-no-auth` is also
   given, since Herdr exposes every workspace on the host, not just this session's pane. tmux
   likewise lists every session on its server, the user's own included (accepted): ids and
   targets are exact (`$N`, `=name`), so no request reaches a session by a prefix of its name
8. **Session**: tmux isolates terminal processes; Herdr sessions are isolated by Herdr itself
9. **Rate limiting**: 5 failed basic-auth attempts/min per IP, and 20/min per IPv6 /64 → 429
   (expired entries swept at most every 10s, so many source addresses cannot make each failure
   scan the whole table);
   failed logins, blocked clients and rejected Hosts are logged with the client address (never
   the credentials), each at most one line per 10s
10. **Agent chat**: on tmux/psmux the server reads only the transcript in the Claude config
    dir of the process found in the pane, proven by its start time (Herdr names the session
    itself, read from the server user's config dir); a Codex rollout only when a process named
    `codex`, not an `app-server`, holds it open for writing inside its `CODEX_HOME/sessions`,
    the identity checked again after opening; every write, Codex's included, re-checks the
    target and the screen and sends nothing on doubt, and a Codex approval dialog is answerable
    only where Herdr reports the agent blocked (read only on tmux); a message's images are
    upload ids resolved by the server, never paths, and a failed send clears the input box
    (one `C-c`) only when it holds nothing but its own paste; markdown images in the Chat
    view never load
11. **Files and changes**: reads, plus `PUT content` saving a text file, `POST create`
    making an empty one, never replacing anything, and `POST delete` moving a file into a 0700
    trash only when its hash is the one the client read (see above); paths confined to the pane's root by `os.Root`; Termote's
    config/state dirs, `/proc`, `/sys`, `/dev` and `.git` never served (a path differing only in
    case is checked by directory identity, for mounts that ignore case); sensitive files only
    with `reveal=1`; git run without a shell and with every repo-configured program disabled;
    `Sec-Fetch-Site`/`Origin` checked on these GETs too
12. **Image uploads**: at most 10 MB and 2 at a time; the 60s read deadline every request gets
    grows to 5 minutes only after auth and once the upload has a slot; the type is read from the bytes; a random server-chosen
    name, written to a `.part` (0600) then renamed, in a 0700 dir that must be a real dir owned
    by the server user; 10 MB reserved against a 200 MB quota before writing; files older than
    7 days go, then the oldest past the quota, never one younger than an hour, and nothing but
    the store's own names
13. **Content-Security-Policy**: every response for an allowed `Host` carries
    `default-src 'self'`; `script-src 'self'` plus the `sha256` of each inline script in the
    served `index.html` (the pre-paint theme script), computed at startup, so no other inline
    script runs; `style-src 'self' 'unsafe-inline'` (xterm.js and React set inline styles);
    `img-src 'self' data: blob:` (`blob:` is an image the page read itself from `files/raw`);
    `connect-src 'self'`, `ws://`/`wss://` of the request's `Host` (a
    name or IPv4 address) and `https://api.github.com` (update check);
    `worker-src`/`manifest-src 'self'`;
    `object-src 'none'`, `base-uri`/`form-action 'self'`, `frame-ancestors 'none'`. With it go
    `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and
    `X-Frame-Options: DENY`. Every E2E spec fails on a CSP violation (`pwa/e2e/fixtures.ts`)
14. **Web Push**: only the public key leaves the server; subscriptions are never returned.
    Endpoints must be HTTPS on 443 at a known push service (`fcm.googleapis.com`,
    `updates.push.services.mozilla.com`, `web.push.apple.com`, `*.push.apple.com`,
    `*.notify.windows.com`), checked at subscribe, at load and before each send; the address
    dialled must be public (no loopback, private, link-local, CGNAT, ULA, multicast or
    IPv4-mapped), with no proxy and no redirects. Payloads carry ids only; the names are read
    by the service worker from the snapshot and stripped of control, bidi and zero-width space characters
15. **Worktrees** (Herdr): writes go through the write guard and `requireWriteRole`; the GET
    refuses any cross-site or `Sec-Fetch-Site: none` read. Branch and base names are checked
    against git's ref rules and more (no leading `-`, which Herdr would pass to git as an option,
    no `HEAD`, no control, format or space character, so a name cannot pose as another in the
    Remove confirmation). Herdr never gets `trust_repository`, a `path` or `close_group`; its
    messages (git's stderr, with paths) are logged, never returned. A remove is bound to the
    path and branch the user confirmed. Create and remove run git with the user's own config,
    hooks and filters included, as typing the command would; a remove deletes ignored files.

## Scalability Notes

- Single-user design (no multi-tenancy)
- Sessions limited by tmux/Herdr capacity (~dozens)
- Terminal WebSocket connections are persistent; the server caps concurrent streams and evicts
  the oldest one past the limit
