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
│   │   │   ├── keyboard-toolbar.tsx   # Virtual keyboard buttons
│   │   │   ├── session-sidebar.tsx    # Session switcher sidebar
│   │   │   ├── terminal-frame.tsx     # Terminal container
│   │   │   └── xterm-terminal.tsx     # xterm.js WebSocket terminal
│   │   ├── hooks/
│   │   │   ├── use-gestures.ts        # Hammer.js gesture handling
│   │   │   ├── use-font-size.ts       # Font size zoom state
│   │   │   ├── use-local-sessions.ts  # Session CRUD + tmux sync
│   │   │   ├── use-session.ts         # Basic session state
│   │   │   ├── use-tmux-api.ts        # tmux HTTP API client
│   │   │   └── use-viewport.ts        # Viewport dimension hook
│   │   ├── types/
│   │   │   └── session.ts             # Session interface + defaults
│   │   └── utils/
│   │       └── terminal-bridge.ts     # Iframe keystroke injection
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
│   ├── deploy.sh               # Deploy (--docker|--hybrid|--native)
│   ├── uninstall.sh            # Uninstall
│   └── health-check.sh         # Service health check
├── systemd/
│   ├── termote.service         # ttyd WebSocket service
│   └── tmux-api.service        # tmux API service
└── docs/                       # Documentation
```

## Key Components

### App.tsx (82 lines)

Main orchestrator combining:

- Session sidebar
- Terminal frame with iframe
- Keyboard toolbar
- Gesture handlers → terminal commands

### xterm-terminal.tsx (222 lines)

Direct xterm.js WebSocket terminal:

- Connects to ttyd via WebSocket
- Handles ttyd protocol (auth token, resize)
- Auto-reconnects on disconnect
- Exposes `sendInput`, `sendCommand`, `focus` methods

### keyboard-toolbar.tsx (74 lines)

Virtual keyboard for mobile:

- Standard keys: Tab, Esc, Ctrl, Arrow keys
- Ctrl mode: reveals ^C, ^D, ^Z, ^L, ^A, ^E combos
- Toggle state for Ctrl modifier

### use-gestures.ts (52 lines)

Hammer.js integration:

- Swipe left/right/up/down
- Long press (paste)
- Pinch in/out (font size)

### use-local-sessions.ts (110 lines)

Session management + tmux sync:

- LocalStorage persistence
- tmux window create/select/kill via API
- Default sessions: Claude, Copilot, Shell

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
