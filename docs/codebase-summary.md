# Codebase Summary

## Directory Structure

```bash
termote/
├── Dockerfile                  # Docker mode (tmux-api + tmux, no ttyd)
├── docker-compose.yml          # Docker deployment
├── entrypoint.sh                # Docker entrypoint
├── pwa/                        # React PWA frontend
│   ├── src/
│   │   ├── App.tsx             # Main app component
│   │   ├── main.tsx            # Entry point
│   │   ├── components/
│   │   │   ├── about-modal.tsx              # About dialog
│   │   │   ├── agent-status-badge.tsx       # Herdr agent status icon (idle/working/blocked/done)
│   │   │   ├── bottom-navigation.tsx        # Mobile bottom nav
│   │   │   ├── command-history-dropdown.tsx # Command history search/select
│   │   │   ├── connection-indicator.tsx     # Connection status indicator
│   │   │   ├── gesture-hints-overlay.tsx    # First-time gesture tutorial (mobile)
│   │   │   ├── help-modal.tsx               # Help/gestures guide
│   │   │   ├── icon-picker.tsx              # Emoji icon selector
│   │   │   ├── keyboard-toolbar.tsx         # Virtual keyboard buttons
│   │   │   ├── pane-strip.tsx               # Pane switcher, shown only for multi-pane tabs
│   │   │   ├── quick-actions-menu.tsx       # Quick action buttons (clear, cancel, exit)
│   │   │   ├── session-sidebar.tsx          # Group switcher sidebar
│   │   │   ├── session-tabs.tsx             # Tab bar (switch, add, remove)
│   │   │   ├── settings-menu.tsx            # Settings dropdown
│   │   │   ├── settings-modal.tsx           # Settings dialog (IME, toolbar, paste, etc.)
│   │   │   ├── swipeable-session-item.tsx   # Swipe-to-delete session
│   │   │   ├── terminal-view.tsx            # xterm.js terminal component
│   │   │   ├── toast.tsx                    # Toast notification component
│   │   │   └── theme-toggle.tsx             # Theme switcher buttons
│   │   ├── hooks/
│   │   │   ├── use-command-history.ts       # Command history storage + retrieval (localStorage)
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
│   │   │   ├── haptic.ts                    # Vibration API wrapper
│   │   │   └── terminal-bridge.ts           # Drives the xterm.js terminal (key mapping, clipboard paste)
│   │   ├── test-setup.ts                    # Vitest configuration
│   ├── e2e/                    # Playwright e2e tests
│   └── package.json
├── tmux-api/                   # Go server + CLI (single binary, flat `package main`)
│   ├── main.go                  # Entry point (no args/`serve` = server, else CLI)
│   ├── serve.go                 # Server: PWA static files, auth, guard chain wiring
│   ├── guard.go                  # Host allowlist + Origin/Content-Type write guard
│   ├── mux.go                    # `Mux` interface + `/api/mux/*` routes
│   ├── mux_tmux.go               # tmux/psmux backend
│   ├── mux_herdr.go              # Herdr backend (native only)
│   ├── herdr_rpc.go, herdr_stream.go # Herdr JSON-RPC client + pane streaming
│   ├── stream.go                 # `/api/mux/stream` WebSocket (xterm.js feed)
│   ├── pty_*.go                  # PTY (Unix) / ConPTY (Windows) terminal backing
│   ├── cli.go                    # Subcommand dispatch, flag parsing, output helpers
│   ├── cli_install.go            # install/uninstall: native, container, allowlist, migrate
│   ├── cli_update.go              # Self-update: release fetch, checksum, extract, re-exec
│   ├── cli_config.go              # Saved config read/write (0.x-compatible encryption)
│   ├── cli_health.go, cli_logs.go, cli_link.go, cli_menu.go # health/logs/link/menu subcommands
│   ├── cli_unix.go, cli_windows.go # OS-specific process/service management
│   └── go.mod
├── scripts/
│   ├── termote.sh              # Thin Unix shim: resolve/build the binary, exec it
│   ├── termote.ps1             # Thin Windows shim: map -Flag to --flag, exec the binary
│   ├── get.sh                  # Online curl|bash installer (download, checksum, call shim)
│   └── get.ps1                 # Windows online installer (irm|iex)
├── tests/                      # Shell script tests
│   ├── test-termote.sh         # Unix shim tests
│   ├── test-termote.ps1        # Windows shim tests
│   ├── test-get.sh             # Online installer tests
│   ├── test-get.ps1            # Windows installer tests
│   └── test-entrypoints.sh     # Docker entrypoint tests
├── .github/workflows/
│   ├── ci.yml                  # CI (PWA build/lint/test, `go test` on Ubuntu/macOS/Windows)
│   ├── release.yml             # Release (Docker push, GitHub Release)
│   └── release-please.yml      # Auto versioning from commits
└── docs/                       # Documentation
```

## Key Components

### App.tsx

Main orchestrator combining:

- Session sidebar with collapse toggle (desktop) / slide-over panel (mobile)
- Terminal view (xterm.js) fed by the `/api/mux/stream` WebSocket
- Keyboard toolbar with special keys
- Settings menu with theme toggle and cache clearing
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
  never have more than one pane
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

Settings dialog with radio buttons, toggles, dropdown, and buttons:

- **IME send behavior**: "Send text only" (default) or "Send + Enter" (auto-press Enter after text)
- **Paste button source**: System clipboard (default) or tmux buffer
- **Toolbar default expanded**: Toggle to show all keys on load (vs. collapsed by default)
- **Disable right-click menu**: Toggle to disable context menu on terminal (default: enabled)
- **Show session tabs**: Toggle desktop tab bar visibility (default: enabled)
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

FAB (floating action button) with draggable positioning and auto-flipping menu (clear, cancel, clear line, exit).

### use-settings.ts

Settings state via `useSyncExternalStore`, persisted to `localStorage` (`termote-settings`
key): IME behavior, toolbar default, context menu, poll interval, gesture hints seen, paste
source, session tabs visibility.

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

### tmux-api/ (Go server + CLI)

Single Go binary, `package main`, flat file layout:

- **main.go** — dispatch: no arguments (or `serve`) starts the server, anything else runs a CLI subcommand
- **serve.go** — builds the handler chain: PWA static files, `/api/mux/*`, `/api/mux/stream`, basic auth, Host allowlist, write guard
- **guard.go** — `hostGuard` (Host allowlist) and `writeGuard` (Origin/`Sec-Fetch-Site`/Content-Type on write methods)
- **mux.go** — the `Mux` interface and the `/api/mux/*` HTTP routes shared by both backends
- **mux_tmux.go** / **mux_herdr.go** — the two backends (see [`system-architecture.md`](system-architecture.md))
- **stream.go** — `/api/mux/stream`: WebSocket upgrade, stream token validation, the hub that caps concurrent streams and closes them on shutdown
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
tmux-api → PTY/ConPTY → tmux/psmux or Herdr pane
    ↓
Terminal output → WebSocket binary frame → xterm.js → display
```

## CLI (Go, `tmux-api/cli*.go`)

The CLI is a set of subcommands compiled into the `tmux-api` binary; `scripts/termote.sh` and
`scripts/termote.ps1` are thin shims that resolve/build the binary and `exec` it with the same
arguments (mapping `-Flag` to `--flag` on Windows). Run `tmux-api help` (or
`./scripts/termote.sh help`) for the current command and flag list — it is generated from the
same code that parses them, so it never drifts from behavior.

**Commands:** `install [container|native]`, `uninstall [container|native|all]`, `update`,
`health`, `logs [tmux-api|all|follow|clean]`, `link`, `unlink`, `show-password`, `version`,
`menu` (no arguments).

**Config persistence:** Unix `~/.termote/config` (`KEY="value"`, chmod 600, password
AES-256-CBC + PBKDF2 encrypted, compatible with the 0.x `openssl enc` format); Windows
`~/.termote/config.json` (password DPAPI-encrypted). See `cli_config.go`.

**Safe self-replacement:** `update` hands off to the newly extracted binary via `exec`
(Unix) or a relaunch (Windows), so no stale code stays in memory mid-update.

### get.sh / get.ps1

Online installers (curl|bash / irm|iex): download from GitHub (latest or pinned version),
verify checksum, extract, then call the shim's `install` (or `update` when
`--update`/`TERMOTE_UPDATE` is set) to preserve config on updates.

## External Dependencies

| Package          | Purpose              |
| ---------------- | -------------------- |
| react            | UI framework (v19)   |
| @xterm/xterm     | Terminal emulator    |
| @xterm/addon-fit | Terminal auto-resize |
| hammerjs         | Touch gestures       |
| lucide-react     | Icons                |
| vite-plugin-pwa  | PWA generation       |
| tailwindcss      | Styling              |

## API Endpoints

See [`system-architecture.md`](system-architecture.md#communication-protocols) for the full
`/api/mux/*` shape and the terminal WebSocket protocol. All endpoints validate inputs and
enforce HTTP methods; invalid requests return 400/404/405/413 JSON errors.

## CI/CD Workflows

| Workflow             | Trigger                            | Purpose                                                                            |
| -------------------- | ---------------------------------- | ---------------------------------------------------------------------------------- |
| `ci.yml`             | Push/PR                            | Build, lint, type check, PWA test, `go test` (Ubuntu/macOS/Windows), website build |
| `release-please.yml` | Manual (workflow_dispatch)         | Create release PR with version bump from commits                                   |
| `release.yml`        | Tag push / Manual / Release Please | Build + push Docker images, create GitHub Release                                  |
| `deploy-website.yml` | Stable release / Manual            | Build + deploy the docs site to GitHub Pages (not on every push to `main`)         |

### Release Flow

```bash
Multiple commits → main
       ↓
Manual trigger: Release Please workflow
       ↓
Creates PR "chore: release x.y.z" (with CHANGELOG)
       ↓
Merge PR → creates tag → triggers release.yml
```

### Manual Release

```bash
make release VERSION=1.0.0      # Local: create + push tag
# Or: GitHub Actions UI → Run workflow → enter version
```

See [release-guide.md](release-guide.md) for full details, and
[upgrade-1.0.md](upgrade-1.0.md) for the 1.0.0 breaking-change and migration notes.
