# System Architecture

## High-Level Overview

**Unified Architecture (termote serve mode):**

```bash
┌─────────────────────────────────────────────────────────────────┐
│                         Client (Browser)                        │
│  ┌───────────────┐  ┌───────────────┐  ┌───────────────────┐    │
│  │ Session       │  │ xterm.js      │  │ Keyboard Toolbar  │    │
│  │ Sidebar       │  │ Terminal      │  │ + Gestures        │    │
│  └───────┬───────┘  └───────┬───────┘  └─────────┬─────────┘    │
│          │                  │                    │              │
│          │    WebSocket     │      direct calls  │              │
│          └────────┬─────────┴──────────┬─────────┘              │
└───────────────────┼────────────────────┼────────────────────────┘
                    │                    │
                    ▼                    ▼
┌─────────────────────────────────────────────────────────────────┐
│              termote (Built-in Server) :7680                    │
│  - Basic Auth + Host allowlist + Origin/CSRF guard              │
│  - Terminal WebSocket (/api/mux/stream, xterm.js stream)        │
│  - Static file serving (PWA)                                    │
│  - Mux API endpoints (/api/mux/*)                                │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│              Mux backend (tmux/psmux, or Herdr)                 │
│  termote opens the terminal itself: a PTY on Unix, ConPTY on     │
│  Windows, attached to `tmux attach` (or, with Herdr, an          │
│  `observe`/`pane.send_text` session over Herdr's socket)         │
└────────────────────────┬────────────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                         tmux Session                            │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                       │
│  │ Window 0 │  │ Window 1 │  │ Window 2 │  ...                  │
│  │ claude   │  │ copilot  │  │ shell    │                       │
│  └──────────┘  └──────────┘  └──────────┘                       │
└─────────────────────────────────────────────────────────────────┘
```

There is no separate terminal server or WebSocket proxy: termote owns the PTY/ConPTY and
streams its bytes straight to xterm.js. ttyd was removed in 1.0.0.

## Components

### PWA Frontend

React SPA with:

- **Terminal View**: xterm.js terminal fed directly by the `/api/mux/stream` WebSocket, in-place theme switching (no reload)
- **Hammer.js**: Touch gesture recognition (mobile only)
- **Session Sidebar**: Switch between groups (tmux sessions, or Herdr workspaces), add/edit/remove (collapsible on desktop)
- **Session Tabs**: Horizontal tab bar for tab switching (hidden/shown via setting), add/remove via UI
- **Pane Strip**: Second-level switcher shown only when a tab has more than one pane (Herdr split panes)
- **Agent Status Badge**: Per-pane coding-agent status (idle/working/blocked/done) shown next to the pane, only ever set by the Herdr backend
- **Keyboard Toolbar**: Virtual keys, Ctrl combos, scroll controls (respects default expanded setting)
- **Settings Menu**: Theme toggle (light/dark/system), Clear Cache & Reload, Preferences
- **Settings Modal**: IME behavior, toolbar expanded, context menu control, session tabs visibility, poll interval, gesture hints, update check (inline toast), history clear
- **Session Poll Interval**: Configurable sync frequency (3s-5m, default 5s) to control snapshot polling rate
- **Connection Indicator**: Real-time auto-detection of server status (connecting/connected/disconnected/error), clickable to retry
- **Command History**: Search/recall previously sent commands (mobile-friendly delete buttons), persisted in localStorage
- **Quick Actions Menu**: Draggable FAB with auto-flipping menu, preset commands (clear, cancel, exit), position persisted
- **Context Menu Control**: Block/unblock right-click on the terminal
- **Font Controls**: Adjustable font size (6-24px)
- **Fullscreen Toggle**: Desktop-only fullscreen mode via Fullscreen API
- **Update Check**: Auto-detect new releases via GitHub API, inline result in settings dialog
- **Responsive Layout**: Collapsible desktop sidebar, mobile slide-over panel

### Termote Server

Go HTTP server providing:

- **Static file serving**: PWA assets from /pwa/dist
- **Terminal WebSocket**: `/api/mux/stream` opens a PTY/ConPTY attached to the selected pane and streams it as binary WebSocket frames; a text control frame carries resize (client→server) and exit/error/size (server→client)
- **Authentication**: Basic auth with a session cookie, rate-limited, plus a Host allowlist and an Origin/CSRF write guard in front of everything
- **Mux API endpoints**: `/api/mux/*` — snapshot (groups→tabs→panes), tab create/rename/close/select, send-keys, health

Configuration via environment variables:

| Variable                      | Default      | Description                                                                     |
| ----------------------------- | ------------ | ------------------------------------------------------------------------------- |
| `TERMOTE_PORT`                | `7680`       | Server listen port                                                              |
| `TERMOTE_BIND`                | `0.0.0.0`    | Server bind address                                                             |
| `TERMOTE_PWA_DIR`             | `./pwa/dist` | Path to PWA static files                                                        |
| `TERMOTE_USER`                | `admin`      | HTTP basic auth username                                                        |
| `TERMOTE_PASS`                | (empty)      | HTTP basic auth password                                                        |
| `TERMOTE_NO_AUTH`             | `false`      | Disable basic auth                                                              |
| `TERMOTE_MUX`                 | `tmux`       | Backend: `tmux` or `herdr` (native only)                                        |
| `TERMOTE_ALLOWED_HOSTS`       | (empty)      | Extra `Host` header values allowed, comma-separated; loopback is always allowed |
| `TERMOTE_HERDR_ALLOW_NO_AUTH` | `false`      | Required together with `TERMOTE_MUX=herdr` and `TERMOTE_NO_AUTH=true`           |

`termote install` computes `TERMOTE_ALLOWED_HOSTS` from `--lan`/`--tailscale`/`--allow-host`
and passes it through; see `server/cli_install.go` (`computeAllowedHosts`).

### Mux Backend

`server/mux.go` defines a `Mux` interface (snapshot, select/new/rename/close tab, send-keys,
attach a terminal, health) with two implementations:

- **`mux_tmux.go`** (tmux on Unix, psmux on Windows): a tmux/psmux session is a group, a window
  is a tab, panes are tmux panes. Every client shares the same attached window, as in 0.x.
- **`mux_herdr.go`** (native mode only, `TERMOTE_MUX=herdr`): drives a Herdr server over its
  socket. A Herdr workspace is a group, a Herdr tab is a tab, a Herdr pane is a pane. Selecting
  a tab in the PWA only changes which pane the client streams (`Caps.ClientSideSelect`); it
  never changes what is shown on the Herdr desktop. The stream follows the pane's real size
  (`session.observe`) and sends keys with `pane.send_text` through a single serialising writer;
  it does not use Herdr's `control`, which would resize the shared desktop PTY. Per-pane agent
  status comes from Herdr's `pane.agent_status_changed` event and is surfaced as the PWA's
  agent-status badge, refreshed at most once per `pollInterval`.

## Communication Protocols

### Terminal WebSocket (`/api/mux/stream`)

```bash
Client → Server:
  - binary frame                      (input bytes)
  - {"type":"resize","cols":N,"rows":N} (text frame)

Server → Client:
  - binary frame                      (output bytes)
  - {"type":"size","cols":N,"rows":N}   (backend-fixed size, e.g. Herdr)
  - {"type":"exit","code":N}
  - {"type":"error","message":"..."}
```

The connection requires a same-origin/allowed Origin, a single-use token minted by
`GET /api/mux/stream-token` (30s TTL, consumed on upgrade), and `?pane=<id>` naming an
existing pane from the last snapshot.

### Mux API (REST, JSON)

```bash
GET    /api/mux/snapshot          → {apiVersion, backend, caps, groups:[{id,name,tabs:[{id,name,active,panes:[{id,active,title,agent}]}]}]}
POST   /api/mux/tabs               body: {groupId, name}       → {ok, id}
PATCH  /api/mux/tabs/{id}          body: {name}                → {ok}
DELETE /api/mux/tabs/{id}                                       → {ok}
POST   /api/mux/tabs/{id}/select                                 → {ok}
POST   /api/mux/panes/{id}/keys    body: {keys}                 → {ok}
GET    /api/mux/health             → {status, apiVersion, backend}
```

`apiVersion` is bumped on every breaking change to this API; the PWA compares it with its own
build and reloads on mismatch. The old `/api/tmux/*` paths and the `/terminal/` iframe route
are gone; `/terminal/` now answers `410 Gone` so a stale cached PWA bundle gets a readable
error instead of a broken page.

## Deployment Modes

### Container Mode (All-in-one)

```bash
./scripts/termote.sh install container
```

Single container with termote + tmux (no ttyd).
Uses `Dockerfile` (`debian:stable-slim`, pinned by digest, `tini -s` as PID 1) and `entrypoint.sh`.

**Container Runtime:** Auto-detects podman or docker (podman preferred).

The Herdr backend is not available in container mode (`--mux herdr` requires `native`).

### Native

```bash
./scripts/termote.sh install native
./scripts/termote.sh install native --mux herdr   # Herdr backend instead of tmux
```

All services run natively (no container): termote on port 7680 (PWA + terminal stream + API + auth).

Auto-detects OS via `runtime.GOOS`. Works on macOS, Linux and Windows (with psmux instead of tmux).

### With Tailscale

```bash
./scripts/termote.sh install container --tailscale myhost.ts.net
./scripts/termote.sh install native --tailscale myhost.ts.net
```

- Auto SSL via `tailscale serve` (no manual cert management)
- Access via Tailscale network (default port 443); the Tailscale name is also added to the
  Host allowlist automatically

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

**Update flow** (implemented in `server/cli_update.go`, invoked through the `scripts/termote.sh`/`termote.ps1` shim):

1. Fetch latest release tag from GitHub API (or use `--version` to pin)
2. Download tarball and checksums from GitHub releases, verify SHA256
3. Stop running services (native + container)
4. Extract tarball into the install directory, preserving the saved config
5. Re-install with the saved configuration (mode, LAN, auth, port, mux, allowlist, Tailscale)
6. Re-link the global command if it existed
7. Hand off to the new binary via self-replace (`exec`/relaunch)

**Safeguards:**

- Refuses to run from a git checkout (dev-only)
- Warns on downgrade (but allows it with an explicit `--version`)
- Skips reinstall if already on target version (unless `--force`)
- Requires saved config for a plain `update` — run `install` first
- Preserves all user config and passwords during update; see [`upgrade-1.0.md`](upgrade-1.0.md) for what a 0.x → 1.0.0 update migrates

## Security Model

1. **Network**: VPN/Tailscale or local network only
2. **Auth**: Basic auth over HTTPS (use `--no-auth` for local dev only); an empty saved
   password no longer disables auth — `install` generates a new one and prints it once
   (`termote show-password` to see it again)
3. **Session cookies**: Stored after initial basic auth to prevent double prompts on mobile
4. **Host allowlist**: every request's `Host` header must match loopback, the LAN IP
   (`--lan`), the Tailscale name (`--tailscale`), or a name added with `--allow-host`; there is
   no wildcard, so DNS rebinding from an attacker-controlled page cannot reach the server
5. **Write/CSRF guard**: state-changing `/api/mux/*` requests must be same-site
   (`Sec-Fetch-Site`/`Origin` on the allowlist) and `Content-Type: application/json`
6. **Terminal access** (`/api/mux/stream`): same Origin check, plus a single-use 30s-TTL token
   minted by `/api/mux/stream-token` and consumed on WebSocket upgrade
7. **Herdr guard**: `--mux herdr --no-auth` is refused unless `--allow-herdr-no-auth` is also
   given, since Herdr exposes every workspace on the host, not just this session's pane
8. **Session**: tmux isolates terminal processes; Herdr sessions are isolated by Herdr itself
9. **Rate limiting**: 5 failed basic-auth attempts/min per IP → 429; rejected-Host log lines
   are rate-limited to one per 10s

## Scalability Notes

- Single-user design (no multi-tenancy)
- Sessions limited by tmux/Herdr capacity (~dozens)
- Terminal WebSocket connections are persistent; the server caps concurrent streams and evicts
  the oldest one past the limit
