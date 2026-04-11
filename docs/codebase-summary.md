# Codebase Summary

## Directory Structure

```bash
termote/
├── Dockerfile                  # Docker mode (tmux-api + ttyd)
├── docker-compose.yml          # Docker deployment
├── entrypoint.sh      # Docker entrypoint
├── pwa/                        # React PWA frontend
│   ├── src/
│   │   ├── App.tsx             # Main app component
│   │   ├── main.tsx            # Entry point
│   │   ├── components/
│   │   │   ├── about-modal.tsx              # About dialog
│   │   │   ├── bottom-navigation.tsx        # Mobile bottom nav
│   │   │   ├── command-history-dropdown.tsx # Command history search/select
│   │   │   ├── connection-indicator.tsx     # Connection status indicator
│   │   │   ├── gesture-hints-overlay.tsx    # First-time gesture tutorial (mobile)
│   │   │   ├── help-modal.tsx               # Help/gestures guide
│   │   │   ├── icon-picker.tsx              # Emoji icon selector
│   │   │   ├── keyboard-toolbar.tsx         # Virtual keyboard buttons
│   │   │   ├── quick-actions-menu.tsx       # Quick action buttons (clear, cancel, exit)
│   │   │   ├── session-sidebar.tsx          # Session switcher sidebar
│   │   │   ├── session-tabs.tsx             # Session tabs (switch, add, remove)
│   │   │   ├── settings-menu.tsx            # Settings dropdown
│   │   │   ├── settings-modal.tsx           # Settings dialog (IME, toolbar, paste, etc.)
│   │   │   ├── swipeable-session-item.tsx   # Swipe-to-delete session
│   │   │   ├── terminal-frame.tsx           # Terminal iframe wrapper (ttyd)
│   │   │   ├── toast.tsx                    # Toast notification component
│   │   │   └── theme-toggle.tsx             # Theme switcher buttons
│   │   ├── contexts/
│   │   │   ├── theme-context.tsx            # Theme provider (light/dark/system)
│   │   │   └── theme-context.test.tsx       # Theme context tests
│   │   ├── hooks/
│   │   │   ├── use-command-history.ts       # Command history storage + retrieval (localStorage)
│   │   │   ├── use-font-size.ts             # Font size state (6-24)
│   │   │   ├── use-font-size.test.ts        # Font size hook tests
│   │   │   ├── use-fullscreen.test.ts       # Fullscreen hook tests
│   │   │   ├── use-gestures.ts              # Hammer.js gesture handling
│   │   │   ├── use-haptic.ts                # Haptic feedback
│   │   │   ├── use-keyboard-visible.ts      # Mobile keyboard detection
│   │   │   ├── use-local-sessions.ts        # Session CRUD + tmux sync
│   │   │   ├── use-media-query.ts           # Responsive hooks
│   │   │   ├── use-settings.ts              # Settings state with localStorage
│   │   │   ├── use-settings.test.ts         # Settings hook tests
│   │   │   ├── use-sidebar-collapsed.test.ts # Sidebar collapse state tests
│   │   │   ├── use-tmux-api.ts              # tmux HTTP API client
│   │   │   ├── use-tmux-api.test.ts         # API client tests
│   │   │   ├── use-update-check.ts          # Check GitHub for new releases
│   │   │   └── use-viewport.ts              # Viewport height + keyboard detection
│   │   ├── types/
│   │   │   └── session.ts                   # Session interface
│   │   ├── utils/
│   │   │   ├── app-info.ts                  # App metadata
│   │   │   ├── haptic.ts                    # Vibration API wrapper
│   │   │   ├── terminal-bridge.ts           # Iframe keystroke injection + theme/context menu
│   │   │   └── terminal-bridge.test.ts      # Terminal bridge tests
│   │   ├── test-setup.ts                    # Vitest configuration
│   ├── e2e/                    # Playwright e2e tests
│   └── package.json
├── tmux-api/                   # Go server
│   ├── main.go                 # Entry point
│   ├── serve.go                # Server (PWA, proxy, auth)
│   ├── tmux.go                 # tmux API handlers
│   ├── serve_test.go           # Server unit tests
│   ├── tmux_test.go            # tmux handler unit tests
│   ├── integration_test.go     # Integration tests (requires tmux)
│   └── go.mod
├── scripts/
│   ├── termote.sh              # Unified CLI (install/uninstall/health/link)
│   ├── termote.ps1             # Windows PowerShell CLI
│   ├── get.sh                  # Online curl|bash installer
│   └── get.ps1                 # Windows PowerShell online installer
├── tests/                      # Shell script tests
│   ├── test-termote.sh         # Unix CLI tests
│   ├── test-termote.ps1        # Windows CLI tests
│   ├── test-get.sh             # Online installer tests
│   ├── test-get.ps1            # Windows installer tests
│   └── test-entrypoints.sh     # Docker entrypoint tests
├── .github/workflows/
│   ├── ci.yml                  # CI (build, lint, test)
│   ├── release.yml             # Release (Docker push, GitHub Release)
│   └── release-please.yml      # Auto versioning from commits
└── docs/                       # Documentation
```

## Key Components

### App.tsx (~400 lines)

Main orchestrator combining:

- Session sidebar with collapse toggle (desktop) / slide-over panel (mobile)
- Terminal frame with ttyd iframe
- Keyboard toolbar with special keys
- Settings menu with theme toggle and cache clearing
- Font size controls (A-/A+)
- Fullscreen toggle (desktop only, Fullscreen API)
- Gesture handlers → terminal commands (mobile only)
- Gesture hints overlay (first mobile visit)
- Toast notifications for clipboard errors

### terminal-frame.tsx (~197 lines)

Terminal iframe wrapper:

- Embeds ttyd terminal via iframe (`/terminal/`)
- In-place theme switching (no iframe reload) via postMessage
- Handles font size changes dynamically
- Controls right-click context menu (disable/enable) via terminal-bridge

### keyboard-toolbar.tsx (~301 lines)

Virtual keyboard for mobile:

- Standard keys: Tab, Esc, Enter, Ctrl, Arrow keys
- Ctrl combos: ^C, ^D, ^Z, ^L, ^A, ^E
- Scroll controls: PageUp/PageDown for tmux copy mode
- Keyboard toggle button
- Haptic feedback on key press
- Respects `defaultExpanded` prop from settings

### settings-modal.tsx (~270 lines)

Settings dialog with radio buttons, toggles, dropdown, and buttons:

- **IME send behavior**: "Send text only" (default) or "Send + Enter" (auto-press Enter after text)
- **Paste button source**: System clipboard (default) or tmux buffer
- **Toolbar default expanded**: Toggle to show all keys on load (vs. collapsed by default)
- **Disable right-click menu**: Toggle to disable context menu on terminal (default: enabled)
- **Show session tabs**: Toggle desktop tab bar visibility (default: enabled)
- **Session poll interval**: Dropdown to set sync frequency (3s, 5s, 10s, 15s, 30s, 1m, 2m, 5m; default: 5s)
- **Show Gesture Hints**: Button to re-show gesture tutorial (mobile only)
- **Check for Updates**: Button with inline toast result (no global toast behind dialog)
- **Clear Command History**: Button with history count disabled when empty
- Uses `ToggleRow` helper component for consistent toggle styling
- Accessible dialog with custom styling
- Toast timer properly cleaned up on unmount and re-click
- Persists changes via `useSettings()` hook

### connection-indicator.tsx (~54 lines)

Connection status indicator with network awareness:

- Displays connection state: connecting (pulsing yellow), connected (green), disconnected/error (red)
- Clickable on error/disconnected to retry connection
- Shows Wifi/WifiOff icon (desktop only)
- Syncs with `isServerReachable` state from `useLocalSessions()` polling
- Auto-detects server disconnect and updates indicator in real-time
- Minimal footprint, integrates with keyboard toolbar area

### session-tabs.tsx (~94 lines)

Horizontal session tabs for window switching:

- Scrollable tab bar with add/remove buttons
- Auto-scrolls active tab into view on selection
- Icon + name display for each session (truncated to 100px)
- Close button on hover (hidden if only 1 session)
- Integrates with session management (onSelect, onAdd, onRemove handlers)
- Mobile/desktop responsive bar layout
- Visibility controlled by `showSessionTabs` setting (default: true)

### command-history-dropdown.tsx (~150 lines)

Command search/recall dropdown UI with mobile support:

- Search input with filtering (case-insensitive)
- Keyboard navigation (Arrow keys, Enter, Escape)
- Recent commands listed chronologically (newest first)
- Remove/clear buttons for individual commands and full history
- Delete button always visible on mobile (was hidden on desktop, now visible at breakpoint)
- Uses `crypto.randomUUID()` with HTTP LAN fallback (non-secure context support)
- Auto-focuses input on open
- Smooth scroll-into-view for selected items

### quick-actions-menu.tsx (~110 lines)

FAB (floating action button) with draggable positioning and auto-flipping menu:

- Actions: Clear (clears terminal), Cancel (Ctrl+C), Clear line (Ctrl+U), Exit (Ctrl+D)
- Blue FAB button → taps to open/close
- Draggable via touch on mobile — position persisted to localStorage
- Direct DOM manipulation for smooth 60fps drag (no React re-renders during drag)
- Menu popup auto-flips in 4 directions based on FAB position (top/bottom + left/right)
- Animated popover with icon + label for each action
- Haptic feedback on button tap and action selection
- Bounds clamping to keep FAB within viewport

### use-settings.ts (~75 lines)

Settings state management using `useSyncExternalStore`:

- Stores settings in localStorage (`termote-settings` key) as JSON
- Provides `settings` object with type-safe config:
  - `imeSendBehavior`: 'send-only' | 'send-enter'
  - `toolbarDefaultExpanded`: boolean
  - `disableContextMenu`: boolean (default: true)
  - `pollInterval`: number in seconds (default: 5, range: 3-300 for 3s-5m)
  - `hasSeenGestureHints`: boolean (default: false)
  - `pasteSource`: 'clipboard' | 'tmux' (default: 'clipboard')
  - `showSessionTabs`: boolean (default: true)
- `updateSetting()` callback to update individual settings
- Defaults to send-only + collapsed toolbar + context menu disabled + 5s poll + clipboard paste + tabs shown

### use-gestures.ts (~53 lines)

Hammer.js integration:

- Swipe left/right/up/down
- Long press (paste)
- Pinch in/out (font size)

### use-local-sessions.ts (~203 lines)

Session management + tmux sync with stale closure fix:

- Sessions loaded from tmux windows via API
- LocalStorage for metadata (icons, descriptions)
- tmux window create/select/kill via API
- Polling interval configurable via `pollInterval` parameter (seconds, default: 5)
- Exposes `isServerReachable` state derived from polling success/failure
- Auto-updates connection indicator when server becomes unreachable
- Uses `isReadyRef` to avoid stale `isReady` state closure in refresh handler
- Extracted `applyWindows` helper to deduplicate window-to-session mapping

### use-command-history.ts (~75 lines)

Command history management with localStorage persistence:

- Stores up to 100 commands (max) in localStorage
- `addCommand(text)` — adds to history, deduplicates, newest first
- `removeCommand(id)` — delete single command
- `clearHistory()` — wipe all commands
- `useSyncExternalStore` for reactive updates across app
- Auto-initialized on first use, cached for performance

### use-update-check.ts (~114 lines)

GitHub release checker with semver comparison:

- Fetches latest release tag from GitHub API (lamngockhuong/termote)
- Compares with APP_INFO.version using simple semver (X.Y.Z)
- 1-hour cache in localStorage to avoid rate limits
- Returns hasUpdate, latestVersion, releaseUrl
- Silent failure (returns no update if API fails)
- `checkForUpdate(force?: boolean)` with optional cache bypass

### use-tmux-api.ts (~56 lines)

tmux HTTP API client:

- `fetchWindows()` - list windows
- `selectWindow(id)` - switch window
- `createWindow(name)` - new window
- `killWindow(id)` - close window
- `sendKeys(target, keys)` - send keystrokes

### tmux-api/ (6 files)

Go HTTP server:

- **main.go** — Entry point, starts serve mode
- **serve.go** — Server: PWA static files, ttyd WebSocket proxy, auth (basic + iframe-only + session cookie + token)
- **tmux.go** — tmux handlers with input validation and method checks
- **serve_test.go** — Server unit tests (auth, middleware, proxy, tokenStore)
- **tmux_test.go** — Handler unit tests (validation, errors)
- **integration_test.go** — Integration tests requiring real tmux

**tokenStore:** Generic token manager with configurable TTL and single-use flag. Replaces dedicated terminalTokenStore. RWMutex for read-optimized access to reusable tokens.

**Security:**

- Input validation: regex `^[a-zA-Z0-9_\-:.]+$` for tmux targets
- HTTP method enforcement: POST for mutations, GET for reads
- Length limits: 4096 bytes for keys, 64 chars for targets
- Constant-time password comparison
- `/terminal/` protected: basic auth + Sec-Fetch-Dest check (blocks direct navigation) + single-use token (30s TTL)

**Test coverage:** ~59% (unit), ~71% with integration tests

Configuration via env vars: TERMOTE_PORT, TERMOTE_BIND, TERMOTE_PWA_DIR, TERMOTE_USER, TERMOTE_PASS, TERMOTE_NO_AUTH

## Data Flow

```bash
User Input
    ↓
Gesture/Toolbar → sendKeyToTerminal()
    ↓
postMessage → iframe (ttyd)
    ↓
ttyd WebSocket → tmux session
    ↓
Terminal output → ttyd (xterm.js) → display
```

## CLI Scripts

### termote.sh (~1130 lines)

Unified Unix CLI for installation, management, and updates:

**Commands:**

- `install [container|native]` — deploy with optional flags (--lan, --no-auth, --port, --tailscale, --fresh)
- `uninstall [container|native|all]` — cleanup
- `health` — service status check
- `link` — create `/usr/local/bin/termote` symlink (global command)
- `unlink` — remove symlink
- `update` — fetch + install latest release from GitHub
- `update --version X.Y.Z` — pin to specific release
- `update --force` — force reinstall current version

**Key functions:**

- `cmd_install()` — deploy: build PWA/binary, start services, set up auth
- `cmd_update()` — self-update: fetch release, verify checksum, stop services, extract, re-install with saved config
- `stop_native_services()` — stop systemd units (termote, ttyd)
- `interactive_menu()` — terminal UI for users (install/update/health/link options)
- `get_latest_version_api()` — fetch latest tag from GitHub API
- `verify_checksum_update()` — validate SHA256 before extraction
- `get_config_value()` — read saved config from `~/.termote/.config.sh`

**Config persistence:** Saves settings to `~/.termote/.config.sh` (chmod 600, AES-256-CBC + PBKDF2 encrypted password). Updates preserve all settings.

**Safe self-replacement:** Uses `exec` to replace process with new script binary (avoids stale code in memory during mid-update).

**Test coverage:** 87 test cases in `test-termote.sh` (all passing)

### termote.ps1

Windows PowerShell equivalent of `termote.sh` with same commands (planned, matches Unix behavior).

### get.sh / get.ps1

Online installers (curl|bash / irm|iex):

- Download from GitHub (latest or pinned version)
- Verify checksum
- Extract to `~/.termote`
- Run `termote.sh install` with `--update` flag to preserve config on updates

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

| Endpoint                   | Method      | Purpose                                      |
| -------------------------- | ----------- | -------------------------------------------- |
| `/terminal/?token=`        | WS          | ttyd WebSocket (iframe-only, token required) |
| `/api/tmux/terminal-token` | GET         | Generate single-use terminal token           |
| `/api/tmux/windows`        | GET         | List tmux windows                            |
| `/api/tmux/select/:id`     | POST        | Switch window                                |
| `/api/tmux/new`            | POST        | Create window                                |
| `/api/tmux/kill/:id`       | POST/DELETE | Kill window                                  |
| `/api/tmux/rename/:id`     | POST        | Rename window                                |
| `/api/tmux/send-keys`      | POST        | Send keystrokes                              |
| `/api/tmux/health`         | GET         | Health check                                 |

All endpoints validate inputs and enforce HTTP methods. Invalid requests return 400/405 JSON errors.

## CI/CD Workflows

| Workflow             | Trigger                            | Purpose                                           |
| -------------------- | ---------------------------------- | ------------------------------------------------- |
| `ci.yml`             | Push/PR to main                    | Build, lint, type check, test                     |
| `release-please.yml` | Manual (workflow_dispatch)         | Create release PR with version bump from commits  |
| `release.yml`        | Tag push / Manual / Release Please | Build + push Docker images, create GitHub Release |

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

See [release-guide.md](release-guide.md) for full details.
