# System Architecture

## High-Level Overview

**Unified Architecture (tmux-api serve mode):**

```bash
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
│              tmux-api (Built-in Server) :7680                   │
│  - Basic Auth (env vars)                                        │
│  - WebSocket tunneling                                          │
│  - Static file serving (PWA)                                    │
│  - tmux API endpoints (/api/tmux/*)                             │
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

- **Terminal Frame**: ttyd iframe with xterm.js terminal, in-place theme switching (no reload)
- **Hammer.js**: Touch gesture recognition (mobile only)
- **Session Sidebar**: Switch between tmux windows, add/edit/remove (collapsible on desktop)
- **Keyboard Toolbar**: Virtual keys, Ctrl combos, scroll controls (respects default expanded setting)
- **Settings Menu**: Theme toggle (light/dark/system), Clear Cache & Reload, Preferences
- **Settings Modal**: IME behavior, toolbar default expanded, context menu control (disable right-click)
- **Context Menu Control**: Block/unblock right-click on terminal via iframe postMessage
- **Font Controls**: Adjustable font size (6-24px)
- **Fullscreen Toggle**: Desktop-only fullscreen mode via Fullscreen API
- **Responsive Layout**: Collapsible desktop sidebar, mobile slide-over panel

### tmux-api Server

Go HTTP server providing:

- **Static file serving**: PWA assets from /pwa/dist
- **WebSocket proxy**: Tunnels connections to ttyd
- **Authentication**: Basic auth + iframe-only access with single-use tokens
- **tmux API endpoints**: Window management REST API

Configuration via environment variables:

| Variable           | Default                 | Description              |
| ------------------ | ----------------------- | ------------------------ |
| `TERMOTE_PORT`     | `7680`                  | Server listen port       |
| `TERMOTE_BIND`     | `0.0.0.0`               | Server bind address      |
| `TERMOTE_PWA_DIR`  | `./pwa/dist`            | Path to PWA static files |
| `TERMOTE_TTYD_URL` | `http://127.0.0.1:7681` | ttyd WebSocket URL       |
| `TERMOTE_USER`     | `admin`                 | HTTP basic auth username |
| `TERMOTE_PASS`     | (empty)                 | HTTP basic auth password |
| `TERMOTE_NO_AUTH`  | `false`                 | Disable basic auth       |

### ttyd Server

Terminal-over-WebSocket server:

- Runs on port 7681 (internal)
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

## Communication Protocols

### ttyd WebSocket Protocol

```bash
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

```bash
GET  /api/tmux/windows        → {windows: [{id, name, active}]}
POST /api/tmux/select/:id     → {ok: true}
POST /api/tmux/new?name=x     → {ok: true}
DELETE /api/tmux/kill/:id     → {ok: true}
POST /api/tmux/send-keys      → {ok: true}
     body: {target, keys}
```

## Deployment Modes

### Container Mode (All-in-one)

```bash
./scripts/termote.sh install container
```

Single container with tmux-api + ttyd + tmux.
Uses `Dockerfile` and `entrypoint.sh`.

**Container Runtime:** Auto-detects podman or docker (podman preferred).

### Native

```bash
./scripts/termote.sh install native
```

All services run natively (no container):

- tmux-api on port 7680 (PWA + proxy + API + auth)
- ttyd on port 7681 → tmux session

Auto-detects OS via `$(uname)`. Works on both macOS and Linux.

### With Tailscale

```bash
./scripts/termote.sh install container --tailscale myhost.ts.net
./scripts/termote.sh install native --tailscale myhost.ts.net
```

- Auto SSL via `tailscale serve` (no manual cert management)
- Access via Tailscale network (default port 443)

### Uninstall

```bash
./scripts/termote.sh uninstall container   # Container mode
./scripts/termote.sh uninstall native      # Native processes
./scripts/termote.sh uninstall all         # Everything
```

### Self-Update

```bash
./scripts/termote.sh update                # Update to latest release
./scripts/termote.sh update --version 0.1.5   # Pin to specific version
./scripts/termote.sh update --force        # Force reinstall current version
```

**Update flow:**

1. Fetch latest release tag from GitHub API (or use `--version` to pin)
2. Download tarball and checksums from GitHub releases
3. Verify SHA256 checksum (warn if unavailable, fail if mismatch)
4. Stop all services: `systemctl stop termote` (native), `docker/podman down` (container)
5. Extract tarball to `~/.termote` (preserves config file)
6. Load saved config: mode, LAN, auth, port, Tailscale settings
7. Re-link symlink if it existed (via `termote link`)
8. Execute new script with `exec` (safe self-replacement, avoids stale code in memory)
9. Re-install with saved config using new script binary

**Safeguards:**

- Refuses to run from git repo (dev-only via source installation)
- Warns on downgrade (but allows with explicit `--version`)
- Skips reinstall if already on target version (unless `--force`)
- Requires saved config (`~/.termote/.config.sh`) — run `install` first
- Preserves all user config and passwords during update

## Security Model

1. **Network**: VPN/Tailscale or local network only
2. **Auth**: Basic auth over HTTPS (use `--no-auth` for local dev only)
3. **Session cookies**: Stored after initial basic auth to prevent double prompts on mobile
4. **Terminal access** (`/terminal/`): Three-layer protection:
   - **Basic auth**: All requests require authentication
   - **Sec-Fetch-Dest**: Blocks direct URL navigation (`document`). Allows missing header for mobile browser compatibility (LAN/Tailscale access)
   - **Single-use token**: PWA fetches a 30s TTL token via `/api/tmux/terminal-token`, passes it as `?token=` query param. Server validates and consumes on iframe load (`Sec-Fetch-Dest: iframe`). Sub-resources (JS/CSS/WebSocket) don't need token
5. **Session**: tmux isolates terminal processes
6. **Origin**: Same-origin iframe (no cross-origin postMessage)

## Scalability Notes

- Single-user design (no multi-tenancy)
- Sessions limited by tmux capacity (~dozens)
- WebSocket connections are persistent
