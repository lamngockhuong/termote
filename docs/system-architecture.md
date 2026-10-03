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
- **Files and Changes**: read-only views of the pane's directory (`caps.files`): a tree with a highlighted file viewer, and `git status` with per-file diffs. A side panel next to the terminal on desktop (header toggles), views of the header's view menu on mobile. Shiki runs in a module worker (`pwa/src/utils/highlight-worker.ts`); the worker, its themes and grammars are built under `assets/shiki/`, left out of the precache and cached on first use
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
GET    /api/mux/panes/{id}/agent/prompt                          → {prompt: null | {promptId, kind, title, body, options, steps, freeText}}
POST   /api/mux/panes/{id}/agent/answer   body: {promptId, choice} → 204
GET    /api/mux/panes/{id}/agent/commands                        → {commands: [{name, description, source, kind}]}
GET    /api/mux/panes/{id}/files/tree?path=&root=               → {root, isRepo, path, entries, truncated}
GET    /api/mux/panes/{id}/files/content?path=&root=&reveal=    → {root, path, size, text} | {…, previewable: false, reason} | {…, sensitive: true}
GET    /api/mux/panes/{id}/files/changes?root=                  → {root, isRepo, branch, entries, truncated}
GET    /api/mux/panes/{id}/files/diff?path=&orig=&staged=&root=&reveal= → {root, path, binary, conflict, truncated, sensitive, reason, hunks}
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
window's active pane: a split window chats with the pane that has focus.

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
and the card never starts partway through the command. In the PWA the card takes at most 70% of
the screen, its content scrolls and the Cancel row stays at its foot. A body taller than its box
shows a fade and **Show all**; on a `permission` card only the refusing options can be tapped
until the body is opened or scrolled to its end, so a long command is not approved unread.

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
registered for every backend and answers 501 where it is off. All four are read-only GETs.

**Root.** The pane's directory, raised to `git rev-parse --show-toplevel` when it is in a
repository; resolutions are cached for 2 s. A directory a foreground command only passes
through does not move the root: a new root is taken once reads at least 2 s apart
agree on it. Every response
carries `root`; a client sends back the root it saw, and gets `409 {error, root}` with the
current one when it moved, so it reloads instead of mixing two trees. `safe.directory` is
passed for the toplevel only when it belongs to the server's user (or is under `/workspace` in
the container).

**Paths.** A client path is relative to the root: absolute paths, `..`, NUL and (Windows)
drive or device names are refused with 400, and every open goes through `os.Root`, so a symlink
that leaves the root fails too (400 `path outside root`). Termote's config and state
directories (`serveConfig.FilesDenyDirs`, filled by `runServe`), `/proc`, `/sys`, `/dev` and the
repository's `.git` are never served (403 `path not allowed`), checked on the path and on what
it resolves to; `.git` is also left out of listings. Files are opened non-blocking and judged on
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
`core.fsmonitor=false`, every `filter.<driver>` it configures emptied, `--no-ext-diff`,
`--no-textconv`, `--ignore-submodules=all`, no lazy fetch and `protocol.allow=never`. Each
command has a 10 s timeout (503 `git timed out`) and takes one of two server-wide slots; nothing
a client sends becomes a git option.

**Guards.** Basic auth and the Host allowlist like every route; GETs pass `writeGuard`, so the
handlers check `Sec-Fetch-Site`/`Origin` themselves (403 cross-site), which keeps another page
from making a `--no-auth` server run git. Other methods get 405. `requireFilesRead` is where a
view-only role (#236) will be enforced.

**PWA.** One store per pane for the tree (`use-files.ts`) and for the status
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
    itself, read from the server user's config dir); a Codex rollout only when a process named
    `codex`, not an `app-server`, holds it open for writing inside its `CODEX_HOME/sessions`,
    the identity checked again after opening; every write, Codex's included, re-checks the
    target and the screen and sends nothing on doubt, and a Codex approval dialog is answerable
    only where Herdr reports the agent blocked (read only on tmux); markdown images in the Chat
    view never load
11. **Files and changes**: read-only; paths confined to the pane's root by `os.Root`; Termote's
    config/state dirs, `/proc`, `/sys`, `/dev` and `.git` never served; sensitive files only
    with `reveal=1`; git run without a shell and with every repo-configured program disabled;
    `Sec-Fetch-Site`/`Origin` checked on these GETs too

## Scalability Notes

- Single-user design (no multi-tenancy)
- Sessions limited by tmux/Herdr capacity (~dozens)
- Terminal WebSocket connections are persistent; the server caps concurrent streams and evicts
  the oldest one past the limit
