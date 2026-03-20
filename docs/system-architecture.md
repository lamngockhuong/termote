# System Architecture

## High-Level Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         Client (Browser)                        │
│  ┌───────────────┐  ┌───────────────┐  ┌───────────────────┐    │
│  │ Session       │  │ xterm.js      │  │ Keyboard Toolbar  │    │
│  │ Sidebar       │  │ Terminal      │  │ + Gestures        │    │
│  └───────┬───────┘  └───────┬───────┘  └─────────┬─────────┘    │
│          │                  │                    │              │
│          │    WebSocket     │      postMessage   │              │
│          └────────┬─────────┴──────────┬─────────┘              │
└───────────────────┼────────────────────┼────────────────────────┘
                    │                    │
                    ▼                    ▼
┌─────────────────────────────────────────────────────────────────┐
│                      nginx (Reverse Proxy)                      │
│  - Basic Auth (.htpasswd)                                       │
│  - WebSocket upgrade                                            │
│  - Static file serving (PWA)                                    │
│  - API routing                                                  │
└────────────────────────┬────────────────────────────────────────┘
                         │
         ┌───────────────┼───────────────┐
         ▼               ▼               ▼
┌─────────────┐  ┌─────────────┐  ┌─────────────┐
│ ttyd :7681  │  │ tmux-api    │  │ PWA Assets  │
│ WebSocket   │  │ Go :7682    │  │ /dist       │
└──────┬──────┘  └──────┬──────┘  └─────────────┘
       │                │
       └────────┬───────┘
                ▼
┌─────────────────────────────────────────────────────────────────┐
│                         tmux Session                            │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                       │
│  │ Window 0 │  │ Window 1 │  │ Window 2 │  ...                  │
│  │ claude   │  │ copilot  │  │ shell    │                       │
│  └──────────┘  └──────────┘  └──────────┘                       │
└─────────────────────────────────────────────────────────────────┘
```

## Components

### PWA Frontend

React SPA with:

- **xterm.js**: Terminal emulator connecting to ttyd via WebSocket
- **Hammer.js**: Touch gesture recognition
- **Session Sidebar**: Switch between tmux windows
- **Keyboard Toolbar**: Virtual keys for mobile

### nginx Proxy

Routes requests to appropriate backends:

- `/` → Static PWA files
- `/terminal/*` → ttyd WebSocket server
- `/api/tmux/*` → tmux control API (optional)

Provides:

- Basic authentication
- SSL termination (production)
- WebSocket proxying with proper headers

### ttyd Server

Terminal-over-WebSocket server:

- Runs on port 7681 (default)
- Connects to tmux session with `-A` (attach-or-create)
- WebSocket protocol with message types:
  - `0` + data: Terminal I/O
  - `1` + JSON: Resize
  - Auth token exchange on connect

### tmux Backend

Session manager providing:

- Persistent terminal sessions
- Multiple windows per session
- Detach/reattach capability

### tmux-api (Go)

Lightweight HTTP API server (tmux-api/main.go):

- Port 7682
- TMUX_SOCKET env for custom socket path (hybrid mode)
- Window management: list, select, create, kill
- Send keystrokes to tmux targets

## Communication Protocols

### ttyd WebSocket Protocol

```
Client → Server:
  - JSON {AuthToken, columns, rows}  (init)
  - '0' + data                       (input)
  - '1' + JSON {columns, rows}       (resize)

Server → Client:
  - '0' + data                       (output)
  - '1' + string                     (title)
  - '2' + JSON                       (preferences)
```

### tmux API (REST)

```
GET  /api/tmux/windows        → {windows: [{id, name, active}]}
POST /api/tmux/select/:id     → {ok: true}
POST /api/tmux/new?name=x     → {ok: true}
DELETE /api/tmux/kill/:id     → {ok: true}
POST /api/tmux/send-keys      → {ok: true}
     body: {target, keys}
```

## Deployment Modes

### Docker (All-in-one)

```bash
./scripts/deploy.sh --docker
```

Single container with nginx + ttyd + tmux + tmux-api.
Uses `Dockerfile` and `entrypoint-allinone.sh`.

### Hybrid

```bash
./scripts/deploy.sh --hybrid
```

- Container: nginx + tmux-api (uses `Dockerfile.hybrid`)
- Native: ttyd connects to host tmux socket
- Use case: Access host binaries (claude, git, etc.)

### Native

```bash
./scripts/deploy.sh --native
```

- termote.service (ttyd:7681)
- tmux-api.service (API:7682)
- nginx (port 7680, basic auth)

### With Tailscale

```bash
./scripts/deploy.sh --docker --tailscale myhost.ts.net
./scripts/deploy.sh --hybrid --tailscale myhost.ts.net
./scripts/deploy.sh --native --tailscale myhost.ts.net
```

- Auto SSL via `tailscale serve` (no manual cert management)
- Access via Tailscale network (default port 443)

### Uninstall

```bash
./scripts/uninstall.sh --docker   # Docker containers
./scripts/uninstall.sh --hybrid   # Hybrid mode
./scripts/uninstall.sh --native   # Systemd + files
./scripts/uninstall.sh --all      # Everything
```

## Security Model

1. **Network**: VPN/Tailscale or local network only
2. **Auth**: nginx basic auth over HTTPS
3. **Session**: tmux isolates terminal processes
4. **Origin**: Same-origin iframe (no cross-origin postMessage)

## Scalability Notes

- Single-user design (no multi-tenancy)
- Sessions limited by tmux capacity (~dozens)
- WebSocket connections require persistent nginx workers
