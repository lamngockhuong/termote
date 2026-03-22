# Codebase Summary

## Directory Structure

```
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
│   │   │   ├── swipeable-session-item.tsx   # Swipe-to-delete session
│   │   │   ├── terminal-frame.tsx           # Terminal iframe wrapper
│   │   │   ├── theme-toggle.tsx             # Theme switcher buttons
│   │   │   └── xterm-terminal.tsx           # xterm.js WebSocket terminal
│   │   ├── contexts/
│   │   │   └── theme-context.tsx      # Theme provider (light/dark/system)
│   │   ├── hooks/
│   │   │   ├── use-font-size.ts       # Font size state (6-24)
│   │   │   ├── use-gestures.ts        # Hammer.js gesture handling
│   │   │   ├── use-haptic.ts          # Haptic feedback
│   │   │   ├── use-keyboard-visible.ts # Mobile keyboard detection
│   │   │   ├── use-local-sessions.ts  # Session CRUD + tmux sync
│   │   │   ├── use-media-query.ts     # Responsive hooks
│   │   │   └── use-tmux-api.ts        # tmux HTTP API client
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
├── systemd/                    # Systemd service files (optional)
│   ├── termote.service         # ttyd WebSocket service
│   └── tmux-api.service        # tmux API service
└── docs/                       # Documentation
```

## Key Components

### App.tsx (~200 lines)

Main orchestrator combining:

- Session sidebar (desktop) / slide-over panel (mobile)
- Terminal frame with ttyd iframe
- Keyboard toolbar with special keys
- Settings menu with theme toggle
- Font size controls (A-/A+)
- Gesture handlers → terminal commands (mobile only)

### xterm-terminal.tsx (~230 lines)

Direct xterm.js WebSocket terminal:

- Connects to ttyd via WebSocket
- Handles ttyd protocol (auth token, resize)
- Auto-reconnects on disconnect
- Exposes `sendInput`, `sendCommand`, `focus` methods

### keyboard-toolbar.tsx (~90 lines)

Virtual keyboard for mobile:

- Standard keys: Tab, Esc, Enter, Ctrl, Arrow keys
- Ctrl combos: ^C, ^D, ^Z, ^L, ^A, ^E
- Scroll controls: PageUp/PageDown for tmux copy mode
- Keyboard toggle button
- Haptic feedback on key press

### use-gestures.ts (52 lines)

Hammer.js integration:

- Swipe left/right/up/down
- Long press (paste)
- Pinch in/out (font size)

### use-local-sessions.ts (~170 lines)

Session management + tmux sync:

- Sessions loaded from tmux windows via API
- LocalStorage for metadata (icons, descriptions)
- tmux window create/select/kill via API
- Polling every 5s for external changes

### use-tmux-api.ts (43 lines)

tmux HTTP API client:

- `fetchWindows()` - list windows
- `selectWindow(id)` - switch window
- `createWindow(name)` - new window
- `killWindow(id)` - close window
- `sendKeys(target, keys)` - send keystrokes

### tmux-api/ (6 files)

Go HTTP server:

- **main.go** — Entry point, starts serve mode
- **serve.go** — Server: PWA static files, ttyd WebSocket proxy, basic auth
- **tmux.go** — tmux handlers with input validation and method checks
- **serve_test.go** — Server unit tests (auth, middleware, proxy)
- **tmux_test.go** — Handler unit tests (validation, errors)
- **integration_test.go** — Integration tests requiring real tmux

**Security:**

- Input validation: regex `^[a-zA-Z0-9_\-:.]+$` for tmux targets
- HTTP method enforcement: POST for mutations, GET for reads
- Length limits: 4096 bytes for keys, 64 chars for targets
- Constant-time password comparison

**Test coverage:** 71% (unit + integration)

Configuration via env vars: TERMOTE_PORT, TERMOTE_BIND, TERMOTE_PWA_DIR, TERMOTE_USER, TERMOTE_PASS, TERMOTE_NO_AUTH

## Data Flow

```
User Input
    ↓
Gesture/Toolbar → sendKeyToTerminal()
    ↓
postMessage → iframe
    ↓
ttyd WebSocket → tmux session
    ↓
Terminal output → xterm.js → display
```

## External Dependencies

| Package          | Purpose              |
| ---------------- | -------------------- |
| react            | UI framework         |
| xterm            | Terminal emulator    |
| @xterm/addon-fit | Terminal auto-resize |
| hammerjs         | Touch gestures       |
| vite-plugin-pwa  | PWA generation       |
| tailwindcss      | Styling              |

## API Endpoints

| Endpoint               | Method      | Purpose           |
| ---------------------- | ----------- | ----------------- |
| `/terminal/`           | WS          | ttyd WebSocket    |
| `/api/tmux/windows`    | GET         | List tmux windows |
| `/api/tmux/select/:id` | POST        | Switch window     |
| `/api/tmux/new`        | POST        | Create window     |
| `/api/tmux/kill/:id`   | POST/DELETE | Kill window       |
| `/api/tmux/rename/:id` | POST        | Rename window     |
| `/api/tmux/send-keys`  | POST        | Send keystrokes   |
| `/api/tmux/health`     | GET         | Health check      |

All endpoints validate inputs and enforce HTTP methods. Invalid requests return 400/405 JSON errors.

## CI/CD Workflows

| Workflow             | Trigger                            | Purpose                                           |
| -------------------- | ---------------------------------- | ------------------------------------------------- |
| `ci.yml`             | Push/PR to main                    | Build, lint, type check, test                     |
| `release-please.yml` | Manual (workflow_dispatch)         | Create release PR with version bump from commits  |
| `release.yml`        | Tag push / Manual / Release Please | Build + push Docker images, create GitHub Release |

### Release Flow

```
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
