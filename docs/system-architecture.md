# System Architecture

## High-Level Overview

**Docker Mode (nginx-based):**

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

**Hybrid+macOS+podman Mode (tmux-api serve mode):**

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
│           tmux-api --serve (Built-in Proxy)                    │
│  - Basic Auth (env vars)                                        │
│  - WebSocket tunneling                                          │
│  - Static file serving (PWA)                                    │
│  - tmux API endpoints                                           │
└────────────────────────┬────────────────────────────────────────┘
                         │
         ┌───────────────┼───────────────┐
         ▼               ▼               ▼
┌─────────────┐  ┌─────────────┐  ┌─────────────┐
│ ttyd :7681  │  │ tmux-api    │  │ PWA Assets  │
│ WebSocket   │  │ API calls   │  │ /dist       │
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

- **Terminal Frame**: ttyd iframe with xterm.js terminal
- **Hammer.js**: Touch gesture recognition (mobile only)
- **Session Sidebar**: Switch between tmux windows, add/edit/remove
- **Keyboard Toolbar**: Virtual keys, Ctrl combos, scroll controls
- **Settings Menu**: Theme toggle (light/dark/system)
- **Font Controls**: Adjustable font size (6-24px)
- **Responsive Layout**: Desktop sidebar, mobile slide-over panel

### nginx Proxy

Routes requests to appropriate backends:

- `/` → Static PWA files
- `/terminal/*` → ttyd WebSocket server
- `/api/tmux/*` → tmux control API (optional)

Provides:

- Basic authentication (enabled by default, use `--no-auth` to disable)
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

HTTP server with two operational modes:

**API-only mode (backward compatible):**

- Port 7682 (default)
- TMUX_SOCKET env for custom socket path (hybrid mode)
- Window management: list, select, create, kill
- Send keystrokes to tmux targets
- REST endpoints: `/windows`, `/select/:id`, `/new`, `/kill/:id`, `/rename/:id`, `/send-keys`

**Full serve mode (`--serve` flag or `TERMOTE_SERVE=true`):**

- REST endpoints: `/windows`, `/select/:id`, `/new`, `/kill/:id`, `/rename/:id`, `/send-keys`

**Full serve mode (`--serve` flag or `TERMOTE_SERVE=true`):**

- Port 7680 (configurable via TERMOTE_PORT)
- Serves PWA static files from TERMOTE_PWA_DIR
- Reverse proxies WebSocket to ttyd (TERMOTE_TTYD_URL)
- HTTP basic auth (TERMOTE_USER, TERMOTE_PASS, TERMOTE_NO_AUTH)
- Binds to address via TERMOTE_BIND (default: 0.0.0.0)
- Built-in WebSocket tunneling for ttyd connections
- Replaces nginx in hybrid mode on macOS+podman

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

**Container Runtime:** Auto-detects podman or docker (podman preferred if available).

### Hybrid

```bash
./scripts/deploy.sh --hybrid
```

- **Linux + docker/podman:** Container (nginx + tmux-api) + Native ttyd
  - Uses `Dockerfile.hybrid`
  - ttyd connects to host tmux socket
  - Use case: Access host binaries (claude, git, etc.)

- **macOS + podman:** Fully native (no container)
  - tmux-api runs in `--serve` mode (port 7680)
  - ttyd runs natively
  - Replaces nginx with built-in proxy in tmux-api

**Container Runtime:** Auto-detects podman or docker. On macOS+podman, skips container entirely.

### Native

```bash
./scripts/deploy.sh --native
```

- **Linux:** systemd services (termote@, tmux-api@) + nginx (port 7680)
- **macOS:** tmux-api `--serve` (port 7680) + native ttyd — same as hybrid+podman behavior

Auto-detects OS via `$(uname)`.

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
2. **Auth**: nginx basic auth over HTTPS (use `--no-auth` for local dev only)
3. **Session**: tmux isolates terminal processes
4. **Origin**: Same-origin iframe (no cross-origin postMessage)

## Scalability Notes

- Single-user design (no multi-tenancy)
- Sessions limited by tmux capacity (~dozens)
- WebSocket connections require persistent nginx workers
