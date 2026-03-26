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
│   │   │   ├── help-modal.tsx               # Help/gestures guide
│   │   │   ├── icon-picker.tsx              # Emoji icon selector
│   │   │   ├── keyboard-toolbar.tsx         # Virtual keyboard buttons
│   │   │   ├── session-sidebar.tsx          # Session switcher sidebar
│   │   │   ├── settings-menu.tsx            # Settings dropdown
│   │   │   ├── settings-modal.tsx           # Settings dialog (IME behavior, toolbar expand)
│   │   │   ├── swipeable-session-item.tsx   # Swipe-to-delete session
│   │   │   ├── terminal-frame.tsx           # Terminal iframe wrapper (ttyd)
│   │   │   └── theme-toggle.tsx             # Theme switcher buttons
│   │   ├── contexts/
│   │   │   └── theme-context.tsx      # Theme provider (light/dark/system)
│   │   ├── hooks/
│   │   │   ├── use-font-size.ts       # Font size state (6-24)
│   │   │   ├── use-gestures.ts        # Hammer.js gesture handling
│   │   │   ├── use-haptic.ts          # Haptic feedback
│   │   │   ├── use-keyboard-visible.ts # Mobile keyboard detection
│   │   │   ├── use-local-sessions.ts  # Session CRUD + tmux sync
│   │   │   ├── use-media-query.ts     # Responsive hooks
│   │   │   ├── use-settings.ts        # Settings state with localStorage
│   │   │   ├── use-tmux-api.ts        # tmux HTTP API client
│   │   │   └── use-viewport.ts        # Viewport height + keyboard detection
│   │   ├── types/
│   │   │   └── session.ts             # Session interface
│   │   └── utils/
│   │       ├── app-info.ts            # App metadata
│   │       ├── haptic.ts              # Vibration API wrapper
│   │       └── terminal-bridge.ts     # Iframe keystroke injection
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
│   ├── termote.sh              # Unified CLI (install/uninstall/health)
│   └── get.sh                  # Online curl|bash installer
├── tests/                      # Shell script tests
│   ├── test-termote.sh         # CLI tests
│   ├── test-get.sh             # Online installer tests
│   └── test-entrypoints.sh     # Docker entrypoint tests
├── .github/workflows/
│   ├── ci.yml                  # CI (build, lint, test)
│   ├── release.yml             # Release (Docker push, GitHub Release)
│   └── release-please.yml      # Auto versioning from commits
└── docs/                       # Documentation
```

## Key Components

### App.tsx (~315 lines)

Main orchestrator combining:

- Session sidebar with collapse toggle (desktop) / slide-over panel (mobile)
- Terminal frame with ttyd iframe
- Keyboard toolbar with special keys
- Settings menu with theme toggle and cache clearing
- Font size controls (A-/A+)
- Fullscreen toggle (desktop only, Fullscreen API)
- Gesture handlers → terminal commands (mobile only)

### terminal-frame.tsx (~118 lines)

Terminal iframe wrapper:

- Embeds ttyd terminal via iframe (`/terminal/`)
- Applies theme (light/dark) via postMessage
- Handles font size changes dynamically
- Forces iframe reload on theme change

### keyboard-toolbar.tsx (~301 lines)

Virtual keyboard for mobile:

- Standard keys: Tab, Esc, Enter, Ctrl, Arrow keys
- Ctrl combos: ^C, ^D, ^Z, ^L, ^A, ^E
- Scroll controls: PageUp/PageDown for tmux copy mode
- Keyboard toggle button
- Haptic feedback on key press
- Respects `defaultExpanded` prop from settings

### settings-modal.tsx (~153 lines)

Settings dialog with radio buttons and toggles:

- **IME send behavior**: "Send text only" (default) or "Send + Enter" (auto-press Enter after text)
- **Toolbar default expanded**: Toggle to show all keys on load (vs. collapsed by default)
- Accessible dialog with custom styling
- Persists changes via `useSettings()` hook

### use-settings.ts (~66 lines)

Settings state management using `useSyncExternalStore`:

- Stores settings in localStorage (`termote-settings` key) as JSON
- Provides `settings` object with type-safe config:
  - `imeSendBehavior`: 'send-only' | 'send-enter'
  - `toolbarDefaultExpanded`: boolean
- `updateSetting()` callback to update individual settings
- Defaults to send-only + collapsed toolbar

### use-gestures.ts (~53 lines)

Hammer.js integration:

- Swipe left/right/up/down
- Long press (paste)
- Pinch in/out (font size)

### use-local-sessions.ts (~203 lines)

Session management + tmux sync:

- Sessions loaded from tmux windows via API
- LocalStorage for metadata (icons, descriptions)
- tmux window create/select/kill via API
- Polling every 5s for external changes

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
- **serve.go** — Server: PWA static files, ttyd WebSocket proxy, auth (basic + iframe-only + token)
- **tmux.go** — tmux handlers with input validation and method checks
- **serve_test.go** — Server unit tests (auth, middleware, proxy)
- **tmux_test.go** — Handler unit tests (validation, errors)
- **integration_test.go** — Integration tests requiring real tmux

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
