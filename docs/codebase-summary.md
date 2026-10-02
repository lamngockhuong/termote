# Codebase Summary

## Directory Structure

```bash
termote/
├── Dockerfile                  # Docker mode (termote + tmux, no ttyd)
├── docker-compose.yml          # Docker deployment
├── entrypoint.sh                # Docker entrypoint
├── pwa/                        # React PWA frontend
│   ├── src/
│   │   ├── App.tsx             # Main app component
│   │   ├── main.tsx            # Entry point
│   │   ├── app-views.ts        # Views of a pane (terminal, chat, files, changes)
│   │   ├── ui-style.ts         # Interface styles (neutral, terminal, native) + token helpers
│   │   ├── index.css           # Design tokens (--tm-*) per style and theme
│   │   ├── components/
│   │   │   ├── about-modal.tsx              # About dialog
│   │   │   ├── agent-status-badge.tsx       # Herdr agent status icon (idle/working/blocked/done)
│   │   │   ├── app-header.tsx               # Header: session chip (mobile) / tabs (desktop), More menu
│   │   │   ├── chat-composer.tsx            # Chat view: message box, sends to the pane's Claude Code
│   │   │   ├── chat-message.tsx             # One transcript entry (markdown without raw HTML, images as links)
│   │   │   ├── chat-view.tsx                # Chat view of a pane running Claude Code (lazy-loaded)
│   │   │   ├── changes-view.tsx             # Changes view: git status grouped, a file's diff (lazy-loaded)
│   │   │   ├── code-block.tsx               # Code frame with line numbers, highlighted tokens
│   │   │   ├── diff-viewer.tsx              # Unified diff of one changed file, one side
│   │   │   ├── command-history-dropdown.tsx # Command history search/select
│   │   │   ├── connection-indicator.tsx     # Connection status indicator
│   │   │   ├── file-viewer.tsx              # One file of Files (asks before a sensitive one)
│   │   │   ├── files-view.tsx               # Files view: the pane's root as a tree (lazy-loaded)
│   │   │   ├── gesture-hints-overlay.tsx    # First-time gesture tutorial (mobile)
│   │   │   ├── help-modal.tsx               # Help/gestures guide
│   │   │   ├── icon-picker.tsx              # Emoji icon selector
│   │   │   ├── keyboard-toolbar.tsx         # Virtual keyboard buttons
│   │   │   ├── markdown-preview.tsx         # Markdown file rendered (Files/Changes, lazy-loaded)
│   │   │   ├── open-terminal-button.tsx     # Way out of a view to the pane's terminal
│   │   │   ├── pane-dir-header.tsx          # Root, branch and refresh line of Files and Changes
│   │   │   ├── panel-toggles.tsx            # Desktop header toggles of the side panel
│   │   │   ├── pane-strip.tsx               # Pane switcher, shown only for multi-pane tabs
│   │   │   ├── prompt-card.tsx              # Claude Code dialog as a card (answer buttons, or read-only)
│   │   │   ├── quick-actions-menu.tsx       # Quick actions sheet (clear, cancel, clear line, exit)
│   │   │   ├── session-sidebar.tsx          # Group switcher sidebar
│   │   │   ├── session-switcher-chip.tsx    # Mobile header chip that opens the sessions sheet
│   │   │   ├── session-tabs.tsx             # Tab bar (switch, add, remove)
│   │   │   ├── side-panel.tsx               # Desktop side panel: resize handle, maximize over the main area
│   │   │   ├── settings-menu.tsx            # "More" overflow menu (font size, theme, Settings, Help, About, Copy link)
│   │   │   ├── settings-modal.tsx           # Settings dialog (IME, toolbar, paste, etc.)
│   │   │   ├── swipeable-session-item.tsx   # Swipe-to-delete session
│   │   │   ├── terminal-view.tsx            # xterm.js terminal component
│   │   │   ├── toast.tsx                    # Toast notification component
│   │   │   └── ui/                          # Shared primitives (Button, Sheet, Menu, Switch, ...)
│   │   ├── hooks/
│   │   │   ├── use-agent-prompt.ts          # Polls a pane's open Claude Code dialog (one store per pane)
│   │   │   ├── use-agent-transcript.ts      # Polls a pane's transcript (one store per pane)
│   │   │   ├── use-command-history.ts       # Command history storage + retrieval (localStorage)
│   │   │   ├── use-files.ts                 # File tree of a pane's root (one store per pane)
│   │   │   ├── use-git-changes.ts           # Polls a pane's git status (one store per pane)
│   │   │   ├── use-font-size.ts             # Font size state (6-24)
│   │   │   ├── use-gestures.ts              # Hammer.js gesture handling
│   │   │   ├── use-group-collapsed.ts       # Collapsed-group state (sidebar)
│   │   │   ├── use-haptic.ts                # Haptic feedback
│   │   │   ├── use-keyboard-visible.ts      # Mobile keyboard detection
│   │   │   ├── use-local-sessions.ts        # Group/tab/pane CRUD + mux snapshot sync
│   │   │   ├── use-media-query.ts           # Responsive hooks
│   │   │   ├── use-mux-api.ts               # /api/mux/* HTTP client + types
│   │   │   ├── use-settings.ts              # Settings state with localStorage
│   │   │   ├── use-sidebar-collapsed.ts     # Sidebar collapse state
│   │   │   ├── use-term-socket.ts           # /api/mux/stream WebSocket (xterm.js feed)
│   │   │   ├── use-update-check.ts          # Check GitHub for new releases
│   │   │   └── use-viewport.ts              # Viewport height + keyboard detection
│   │   ├── types/
│   │   │   └── session.ts                   # Group/Tab/Pane/AgentStatus types
│   │   ├── utils/
│   │   │   ├── app-info.ts                  # App metadata
│   │   │   ├── files-format.ts              # Sizes and paths shown by Files and Changes
│   │   │   ├── haptic.ts                    # Vibration API wrapper
│   │   │   ├── highlight.ts                 # Syntax highlighting through the worker, with a timeout
│   │   │   ├── highlight-langs.ts           # Highlighted languages by file extension or name
│   │   │   ├── highlight-worker.ts          # Shiki in a module worker (grammars loaded on demand)
│   │   │   ├── markdown-links.ts            # Markdown preview: link resolution under the root, heading ids, front matter
│   │   │   ├── markdown-safety.ts           # Raw HTML as text, http(s)-only URLs (Chat and Markdown preview)
│   │   │   ├── side-panel-width.ts          # Side panel width limits (min panel, min main area)
│   │   │   └── terminal-bridge.ts           # Drives the xterm.js terminal (key mapping, clipboard paste)
│   │   ├── test-setup.ts                    # Vitest configuration
│   ├── e2e/                    # Playwright e2e tests (chat-view.spec.ts drives tests/fixtures/fake-claude.sh; files-changes.spec.ts uses a throwaway git repo)
│   └── package.json
├── server/                     # Go server + CLI (single binary, flat `package main`)
│   ├── main.go                  # Entry point (`serve` runs the server, no args opens the menu)
│   ├── serve.go                 # Server: PWA static files, auth, guard chain wiring
│   ├── serve_config.go           # Server config from the saved config, else the environment
│   ├── guard.go                  # Host allowlist + Origin/Content-Type write guard
│   ├── mux.go                    # `Mux` interface + `/api/mux/*` routes
│   ├── mux_tmux.go               # tmux/psmux backend
│   ├── mux_herdr.go              # Herdr backend
│   ├── herdr_rpc.go, herdr_stream.go # Herdr JSON-RPC client + pane streaming
│   ├── herdr_socket_*.go          # Herdr socket path + dial (Unix socket / Windows named pipe)
│   ├── herdr_observer_*.go        # Stops `observe`/`control` (process group / Windows Job Object)
│   ├── stream.go                 # `/api/mux/stream` WebSocket (xterm.js feed)
│   ├── files.go                  # `/api/mux/panes/{id}/files/*` routes: tree, contents, errors
│   ├── files_root.go             # Pane root (git toplevel, settling), safe git runner
│   ├── files_git.go              # git status (porcelain v2) and unified diff
│   ├── files_sensitive.go        # Names of files that usually hold secrets
│   ├── files_os_*.go             # Per-OS deny list, ownership check, non-blocking open
│   ├── agent.go                  # `/api/mux/panes/{id}/agent/*` routes, adapter interfaces, transcript reads
│   ├── agent_claude.go           # Claude Code transcript (JSONL) + session file (`sessions/<pid>.json`)
│   ├── agent_claude_prompt.go    # Reads a Claude Code screen: input box state, dialogs
│   ├── agent_input.go            # Send a message, read and answer a dialog (checks before every write)
│   ├── agent_proc*.go            # Finds Claude Code under a tmux/psmux pane (start time, config dir)
│   ├── testdata/claude/          # Recorded Claude Code screens and a transcript fixture
│   ├── pty_*.go                  # PTY (Unix) / ConPTY (Windows) terminal backing
│   ├── webui/                    # Embeds the built PWA into the binary
│   ├── cli.go                    # Subcommand dispatch, flag parsing, output helpers
│   ├── cli_start.go              # `start`/`stop`/`restart`: options, service registration
│   ├── cli_service*.go            # OS supervisor registration (systemd/launchd/Scheduled Task)
│   ├── cli_container.go          # `container up/down/logs/status`
│   ├── cli_update.go              # Self-update: release fetch, checksum, extract, re-exec
│   ├── cli_config.go              # Saved config read/write (AES-256-CBC + HMAC, or DPAPI)
│   ├── install_layout.go         # Versioned install layout (versions/<v>, current, prune)
│   ├── release_tags.go           # Picks the newest stable 1.x GitHub tag
│   ├── tailscale.go              # `tailscale serve` mapping (apply/remove, never sudo)
│   ├── cli_logs.go, cli_link.go, cli_menu.go # logs/link/menu subcommands
│   ├── cli_unix.go, cli_windows.go # OS-specific process management
│   └── go.mod
├── scripts/
│   ├── install.sh               # Release installer (curl|sh): download, verify, lay out
│   ├── install.ps1              # Windows release installer (irm|iex), same job
│   ├── termote.sh               # Checkout-only dev shim: builds/runs server/termote-dev
│   └── termote.ps1              # Checkout-only dev shim (Windows), same job
├── tests/                      # Shell script tests
│   ├── fixtures/fake-claude.sh # Stand-in Claude Code for the Chat view E2E (Linux)
│   ├── test-termote.sh         # Dev shim tests (Unix)
│   ├── test-termote.ps1        # Dev shim tests (Windows)
│   ├── test-install.sh         # install.sh tests (fake curl)
│   ├── test-install.ps1        # install.ps1 tests
│   └── test-entrypoints.sh     # Docker entrypoint tests
├── .github/workflows/
│   ├── ci.yml                  # CI (PWA build/lint/test, `go test` on Ubuntu/macOS/Windows, Playwright E2E)
│   ├── release.yml             # Release: build, draft, upload assets, publish, Docker push
│   ├── release-please.yml      # Auto versioning from commits
│   └── deploy-website.yml      # Docs site deploy, only after a stable release
└── docs/                       # Documentation
```

## Key Components

### App.tsx

Main orchestrator combining:

- Session sidebar with collapse toggle (desktop) / sessions bottom sheet opened from the header chip (mobile)
- Terminal view (xterm.js) fed by the `/api/mux/stream` WebSocket
- Keyboard toolbar with special keys
- "More" overflow menu with theme, font size, Settings, Help, About, Copy link and cache clearing
- Deep links (`#/s/<group>/<tab>[/<pane>]`) that select a session, and address-bar sync
- Font size controls (A-/A+)
- Fullscreen toggle (desktop only, Fullscreen API)
- Gesture handlers → terminal commands (mobile only)
- Gesture hints overlay (first mobile visit)
- Toast notifications for clipboard errors

### terminal-view.tsx

xterm.js terminal component:

- Owns the `Terminal` instance and the `use-term-socket` WebSocket connection
- Renders binary stream frames as terminal output; sends a resize control frame on layout change
- In-place theme switching (no reconnect) via xterm theme API
- Controls right-click context menu (disable/enable) via terminal-bridge

### pane-strip.tsx / agent-status-badge.tsx

Second-level pane switcher and per-pane agent status:

- `PaneStrip` renders only when a tab has more than one pane (Herdr split panes); tmux tabs
  never have more than one pane. Each pane has a close button; App confirms before calling
  `DELETE /api/mux/panes/{id}`
- `AgentStatusBadge` renders an icon for `idle`/`working`/`blocked`/`done`, set only by the
  Herdr backend's `agent` field on a pane

### keyboard-toolbar.tsx

Virtual keyboard for mobile:

- Standard keys: Tab, Esc, Enter, Ctrl, Arrow keys
- Ctrl combos: ^C, ^D, ^Z, ^L, ^A, ^E
- Scroll controls: PageUp/PageDown for tmux copy mode
- Keyboard toggle button
- Haptic feedback on key press
- Respects `defaultExpanded` prop from settings

### settings-modal.tsx

Settings sheet (full screen on phone, two-column dialog on desktop) grouped as Appearance, Keyboard, Terminal, Sessions, Data & help:

- **IME send behavior**: "Send text only" (default) or "Send + Enter" (auto-press Enter after text)
- **Interface style**: Neutral (default), Terminal or Native (`uiStyle`)
- **Paste button source**: System clipboard (default) or tmux buffer ("Session buffer" on other backends)
- **Toolbar default expanded**: Toggle to show all keys on load (vs. collapsed by default)
- **Disable right-click menu**: Toggle to disable context menu on terminal (default: enabled)
- **Show session tabs**: Toggle desktop session tabs visibility (default: enabled)
- **Terminal font**: Text field for a font installed on the device, saved on blur/Enter; Nerd Font
  icons fall back to the bundled Symbols Nerd Font either way (`utils/terminal-font.ts`)
- **Session poll interval**: Dropdown to set snapshot sync frequency (3s, 5s, 10s, 15s, 30s, 1m, 2m, 5m; default: 5s)
- **Show Gesture Hints**: Button to re-show gesture tutorial (mobile only)
- **Check for Updates**: Button with inline toast result (no global toast behind dialog)
- **Clear Command History**: Button with history count disabled when empty
- Persists changes via `useSettings()` hook

### connection-indicator.tsx

Connection status indicator with network awareness:

- Displays connection state: connecting (pulsing yellow), connected (green), disconnected/error (red)
- Clickable on error/disconnected to retry connection
- Syncs with `isServerReachable` state from `useLocalSessions()` polling and the term socket state

### session-tabs.tsx

Horizontal tab bar for tab switching:

- Scrollable, add/remove buttons, auto-scrolls active tab into view
- Selecting a tab is client-side-only for Herdr (`caps.clientSideSelect`): it changes which
  pane the client streams without touching the Herdr desktop

### command-history-dropdown.tsx

Command search/recall dropdown UI with mobile support (search, keyboard nav, delete).

### quick-actions-menu.tsx

Quick actions sheet (clear, cancel, clear line, exit), opened from the Quick actions key of the keyboard toolbar on mobile.

### use-settings.ts

Settings state via `useSyncExternalStore`, persisted to `localStorage` (`termote-settings`
key): IME behavior, toolbar default, context menu, poll interval, gesture hints seen, paste
source, session tabs visibility, terminal font.

### use-gestures.ts

Hammer.js integration: swipe left/right/up/down, long press (paste), pinch in/out (font size).

### use-local-sessions.ts

Group/tab/pane state synced from `/api/mux/snapshot`, polled at `pollInterval`:

- Maps the mux snapshot (groups → tabs → panes) to the UI's session model
- LocalStorage for metadata (icons, descriptions) keyed by group/tab
- Tab create/select/kill via `use-mux-api`
- Exposes `isServerReachable` derived from polling success/failure

### use-mux-api.ts

`/api/mux/*` HTTP client and shared types (`MuxSnapshot`, `MuxGroup`, `MuxTab`, `MuxPane`,
`MuxAgent`); state-changing calls always send `Content-Type: application/json` since the
server rejects any other content type on writes.

### use-term-socket.ts

Opens and maintains the `/api/mux/stream` WebSocket for one pane: fetches a single-use
stream token first, reconnects on drop, and exposes `ConnectionState` plus parsed
`StreamControl` frames (`size`/`exit`/`error`) to the terminal view.

### use-command-history.ts

Command history with localStorage persistence: up to 100 commands, add/remove/clear,
`useSyncExternalStore` for reactive updates.

### use-update-check.ts

GitHub release checker with semver comparison, 1-hour cache in localStorage, silent failure.

### server/ (Go server + CLI)

Single Go binary, `package main`, flat file layout:

- **main.go** — dispatch: `termote serve` runs the server; no arguments opens the interactive menu; anything else runs a CLI subcommand
- **serve.go** — builds the handler chain: PWA static files, `/api/mux/*`, `/api/mux/stream`, basic auth, Host allowlist, write guard
- **guard.go** — `hostGuard` (Host allowlist) and `writeGuard` (Origin/`Sec-Fetch-Site`/Content-Type on write methods)
- **mux.go** — the `Mux` interface and the `/api/mux/*` HTTP routes shared by both backends
- **mux_tmux.go** / **mux_herdr.go** — the two backends (see [`system-architecture.md`](system-architecture.md))
- **stream.go** — `/api/mux/stream`: WebSocket upgrade, stream token validation, the hub that caps concurrent streams and closes them on shutdown
- **agent\*.go** — the Chat view's routes: finding the Claude Code session of a pane, reading its transcript, sending it a message and answering its dialogs, writing only when the screen shows the expected state (see [`system-architecture.md`](system-architecture.md#agent-chat-apimuxpanesidagent))
- **files\*.go** — the Files and Changes views' read-only routes: the pane's root, directory listings and file contents through `os.Root`, git status and diff run with every repo-configured program disabled (see [`system-architecture.md`](system-architecture.md#files-and-changes-apimuxpanesidfiles))
- **cli\*.go** — CLI subcommands (see below)

**Security** (server):

- Input validation on pane/tab/group IDs and request bodies (size-limited JSON, 4096-byte key payloads)
- HTTP method enforcement per route, with a JSON 405 for a wrong method
- Constant-time password comparison; rate-limited auth failures (5/min/IP → 429)
- Host allowlist and Origin/CSRF write guard in front of every `/api/` route (see [`system-architecture.md`](system-architecture.md#security-model))

Configuration via env vars: see the table in [`system-architecture.md`](system-architecture.md).

## Data Flow

```bash
User Input
    ↓
Gesture/Toolbar → sendKeyToTerminal()
    ↓
WebSocket binary frame → /api/mux/stream
    ↓
termote → PTY/ConPTY → tmux/psmux or Herdr pane
    ↓
Terminal output → WebSocket binary frame → xterm.js → display
```

## CLI (Go, `server/cli*.go`)

The CLI is a set of subcommands compiled into the `termote` binary. Run `termote help` for the
current command and flag list — it is generated from the same code that parses them, so it
never drifts from behavior.

**Commands:** `start [options]`, `stop`, `restart`, `status`/`health`, `container <cmd>`
(`up`/`down`/`logs`/`status`), `update [--version X.Y.Z] [--force]`, `uninstall`,
`logs [server|all|follow|clean]`, `link`, `unlink`, `show-password`, `version`, `serve`,
`menu` (no arguments). There is no `install` command in 1.0 (it prints the replacement above).

**Config persistence:** Unix `~/.config/termote/config` (`KEY="value"`, chmod 600, password
AES-256-CBC with an HMAC keyed by a random per-install `secret` file, 0600); Windows
`%APPDATA%\termote\config.json` (password DPAPI-encrypted). See `cli_config.go`.

**Versioned install layout:** `versions/<v>/bin/termote`, a `current` pointer switched
atomically by `update`, and only the current and previous version kept on disk (see
`install_layout.go`).

**Safe self-replacement:** `update` restarts the service to run the new `current` version;
nothing re-execs the running process.

### Release installers (`scripts/install.sh` / `install.ps1`)

Downloads the newest stable 1.x release (or `TERMOTE_VERSION`) for the OS/arch, verifies its
`.sha256` (mandatory), lays it out under the versioned install root, and prints `termote
start` — they never start the server or touch any saved config.

## External Dependencies

| Package          | Purpose              |
| ---------------- | -------------------- |
| react            | UI framework (v19)   |
| @xterm/xterm     | Terminal emulator    |
| @xterm/addon-fit | Terminal auto-resize |
| hammerjs         | Touch gestures       |
| lucide-react     | Icons                |
| react-markdown   | Chat view markdown   |
| remark-gfm       | GFM tables, lists    |
| vite-plugin-pwa  | PWA generation       |
| tailwindcss      | Styling              |

## API Endpoints

See [`system-architecture.md`](system-architecture.md#communication-protocols) for the full
`/api/mux/*` shape and the terminal WebSocket protocol. All endpoints validate inputs and
enforce HTTP methods; invalid requests return 400/404/405/413 JSON errors.

## CI/CD Workflows

| Workflow             | Trigger                                 | Purpose                                                                                                   |
| -------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `ci.yml`             | Push/PR                                 | Build, lint, type check, PWA test, `go test` (Ubuntu/macOS/Windows), Playwright E2E, website build        |
| `release-please.yml` | Push to `main` / Manual                 | Create/update the release PR (draft release), then call `deploy-website.yml` after a stable one publishes |
| `release.yml`        | Tag push / Manual / Release Please      | Build assets, create a draft GitHub Release, upload assets, publish, push Docker images                   |
| `deploy-website.yml` | Called by `release-please.yml` / Manual | Build + deploy the docs site to GitHub Pages (only after a stable release, not on every push to `main`)   |

### Release Flow

```bash
Commits pushed to main
       ↓
release-please.yml opens/updates the "chore: release x.y.z" PR (CHANGELOG)
       ↓
Merge PR → tag created → release.yml builds assets, drafts the release,
           uploads assets, then publishes it (never public before assets land)
       ↓
Stable release published → release-please.yml calls deploy-website.yml
```

### Manual Release

```bash
make release VERSION=1.0.0      # Local: create + push tag
# Or: GitHub Actions UI → Run workflow → enter version
```

See [release-guide.md](release-guide.md) for full details.
