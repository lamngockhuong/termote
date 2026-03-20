# System Architecture

## High-Level Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         Client (Browser)                        │
│  ┌───────────────┐  ┌───────────────┐  ┌───────────────────┐   │
│  │ Session       │  │ xterm.js      │  │ Keyboard Toolbar  │   │
│  │ Sidebar       │  │ Terminal      │  │ + Gestures        │   │
│  └───────┬───────┘  └───────┬───────┘  └─────────┬─────────┘   │
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
│ ttyd :7681  │  │ tmux API    │  │ PWA Assets  │
│ WebSocket   │  │ (optional)  │  │ /dist       │
└──────┬──────┘  └──────┬──────┘  └─────────────┘
       │                │
       └────────┬───────┘
                ▼
┌─────────────────────────────────────────────────────────────────┐
│                         tmux Session                            │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                      │
│  │ Window 0 │  │ Window 1 │  │ Window 2 │  ...                 │
│  │ claude   │  │ copilot  │  │ shell    │                      │
│  └──────────┘  └──────────┘  └──────────┘                      │
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
- HTTP API for window management (via wrapper script)

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

### Docker

```bash
./scripts/deploy.sh --docker
```

All services in containers (ttyd + nginx).

### Native (local)

```bash
./scripts/deploy.sh --native
```

- termote@.service (ttyd:7681, localhost only)
- tmux-api@.service (API:7682)
- nginx (port 8080, basic auth)

### Native + Tailscale

```bash
./scripts/deploy.sh --native --tailscale <hostname[:port]>
```

- Auto SSL via Tailscale certs
- Default port: 8080
- Access via Tailscale network
- No basic auth (Tailscale handles auth)

### Native (production)

```bash
./scripts/deploy.sh --native --production
```

nginx with SSL + domain (manual cert setup).

### Hybrid

```bash
./scripts/deploy.sh --hybrid
./scripts/deploy.sh --hybrid --nginx=docker --ttyd=native --api=native
```

Mix docker + native per service.

### Uninstall

```bash
./scripts/uninstall.sh --docker   # Docker containers
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
