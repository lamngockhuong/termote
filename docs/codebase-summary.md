# Codebase Summary

## Directory Structure

```
termote/
├── Dockerfile                  # All-in-one (nginx+ttyd+tmux-api)
├── Dockerfile.hybrid           # Hybrid (nginx+tmux-api)
├── docker-compose.yml          # Docker deployment
├── entrypoint-allinone.sh      # Docker entrypoint
├── entrypoint-hybrid.sh        # Hybrid entrypoint
├── pwa/                        # React PWA frontend
│   ├── src/
│   │   ├── App.tsx             # Main app component
│   │   ├── main.tsx            # Entry point
│   │   ├── components/
│   │   │   ├── about-modal.tsx        # About dialog
│   │   │   ├── bottom-navigation.tsx  # Mobile bottom nav
│   │   │   ├── icon-picker.tsx        # Emoji icon selector
│   │   │   ├── keyboard-toolbar.tsx   # Virtual keyboard buttons
│   │   │   ├── session-sidebar.tsx    # Session switcher sidebar
│   │   │   ├── settings-menu.tsx      # Settings dropdown
│   │   │   ├── terminal-frame.tsx     # Terminal iframe wrapper
│   │   │   ├── theme-toggle.tsx       # Theme switcher buttons
│   │   │   └── xterm-terminal.tsx     # xterm.js WebSocket terminal
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
├── nginx/
│   ├── nginx.conf              # Base config
│   ├── nginx-docker.conf       # Docker mode
│   ├── nginx-hybrid.conf       # Hybrid mode
│   ├── nginx-local.conf        # Native local (basic auth)
│   └── nginx-production.conf   # Native production (manual SSL)
├── tmux-api/                   # Go API server
│   ├── main.go                 # HTTP API for tmux control
│   └── go.mod
├── scripts/
│   ├── deploy.sh               # Deploy (--docker|--hybrid|--native) [--no-auth]
│   ├── install.sh              # Release mode installer
│   ├── get.sh                  # Online curl|bash installer
│   ├── uninstall.sh            # Uninstall
│   └── health-check.sh         # Service health check
├── .github/workflows/
│   ├── ci.yml                  # CI (build, lint, test)
│   ├── release.yml             # Release (Docker push, GitHub Release)
│   └── release-please.yml      # Auto versioning from commits
├── systemd/
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

### tmux-api/main.go (124 lines)

Go HTTP server for tmux control:

- Listens on port 7682
- Supports optional TMUX_SOCKET env for custom socket path
- Endpoints: /windows, /select/:id, /new, /kill/:id, /send-keys, /health

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

| Endpoint               | Method | Purpose             |
| ---------------------- | ------ | ------------------- |
| `/terminal/token`      | GET    | Get ttyd auth token |
| `/terminal/ws`         | WS     | ttyd WebSocket      |
| `/api/tmux/windows`    | GET    | List tmux windows   |
| `/api/tmux/select/:id` | POST   | Switch window       |
| `/api/tmux/new`        | POST   | Create window       |
| `/api/tmux/kill/:id`   | DELETE | Kill window         |
| `/api/tmux/send-keys`  | POST   | Send keystrokes     |

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
