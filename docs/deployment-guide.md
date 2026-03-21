# Deployment Guide

## Prerequisites

| Dependency    | Docker Mode | Hybrid Mode | Native (Linux) | Native (macOS) |
| ------------- | ----------- | ----------- | -------------- | -------------- |
| Docker/Podman | Required    | Required\*  | -              | -              |
| ttyd          | -           | Required    | Required       | Required       |
| tmux          | -           | Required    | Required       | Required       |
| nginx         | -           | -           | Required       | -              |
| Go 1.21+      | -           | -           | Required       | Required       |

\*Hybrid mode on macOS+podman runs fully native (no container required). Linux requires Docker/Podman.

## Deployment Modes

### Docker (All-in-one)

Single container with nginx + ttyd + tmux + tmux-api.

```bash
./scripts/deploy.sh --docker             # localhost with basic auth
./scripts/deploy.sh --docker --no-auth   # localhost without auth
./scripts/deploy.sh --docker --lan       # LAN accessible
```

**Container Runtime:** Auto-detects podman (preferred) or docker.

**When to use:** Simple setup, no host binary access needed.

### Hybrid

**Linux:** Container (nginx + tmux-api) + Native ttyd.

```bash
# Install ttyd first
sudo apt install ttyd tmux  # Ubuntu/Debian

./scripts/deploy.sh --hybrid
./scripts/deploy.sh --hybrid --lan
```

**macOS:** Fully native (no container).

```bash
# Install required packages
brew install ttyd tmux go

./scripts/deploy.sh --hybrid
./scripts/deploy.sh --hybrid --lan
```

On macOS, hybrid mode detects podman and runs entirely natively:

- ttyd on port 7681 (native)
- tmux-api in serve mode on port 7680 (native)
  - Replaces nginx container
  - Serves PWA, proxies WebSocket, provides auth

**Container Runtime:** Auto-detects podman or docker. On macOS+podman, skips container entirely.

**When to use:** Need ttyd to access host binaries (claude, git, node).

### Native

Auto-detects OS and uses the appropriate strategy.

**Linux:** All services run natively with systemd.

```bash
sudo apt install ttyd tmux nginx
./scripts/deploy.sh --native
```

**macOS:** tmux-api serve mode + native ttyd (no container, no systemd).

```bash
brew install ttyd tmux go
./scripts/deploy.sh --native
```

**When to use:** No Docker available, full control over services.

## Command Options

| Flag                        | Description                             |
| --------------------------- | --------------------------------------- |
| `--lan`                     | Expose to LAN (default: localhost only) |
| `--tailscale <host[:port]>` | Enable Tailscale HTTPS                  |
| `--no-auth`                 | Disable basic authentication            |
| `--port <port>`             | Host port (default: 7680)               |

## macOS Notes

### Container Runtime Support

- Docker Desktop and Podman both supported
- Podman preferred (auto-detected if available)
- Both can be installed via Homebrew

### Native Mode on macOS

- `--native` auto-detects macOS and uses tmux-api serve mode (no systemd needed)
- Runs ttyd natively + tmux-api `--serve` (replaces nginx)
- Equivalent to hybrid+podman behavior but without requiring a container runtime

### Hybrid Mode Behavior

When deploying hybrid mode on macOS with podman:

- Automatically detects podman + macOS combination
- Runs entirely natively (no container)
- tmux-api serves PWA + proxies ttyd (replaces nginx)
- Useful for accessing local CLI tools (claude, copilot, git, node, etc.)

### Socket Permissions

- tmux socket directory permissions enforced to 700 (tmux requirement)
- Hybrid mode on macOS: sockets in `/private/tmp/tmux-$(id -u)/`
- Container mode on macOS: socket mounted with proper permissions

## Tailscale HTTPS

Auto SSL via `tailscale serve` (no manual cert management):

```bash
./scripts/deploy.sh --docker --tailscale myhost.ts.net
./scripts/deploy.sh --hybrid --tailscale myhost.ts.net:8765
./scripts/deploy.sh --docker --tailscale myhost.ts.net --lan
```

## Environment Variables

### Common

| Variable       | Default               | Description                      |
| -------------- | --------------------- | -------------------------------- |
| `TMUX_SOCKET`  | `/tmp/tmux-*/default` | Custom tmux socket path (hybrid) |
| `TERMOTE_PORT` | `7680`                | Main server port                 |
| `TTYD_PORT`    | `7681`                | ttyd WebSocket port              |
| `API_PORT`     | `7682`                | tmux-api API-only mode port      |

### tmux-api Serve Mode (--serve or TERMOTE_SERVE=true)

| Variable           | Default                 | Description              |
| ------------------ | ----------------------- | ------------------------ |
| `TERMOTE_SERVE`    | `false`                 | Enable full server mode  |
| `TERMOTE_PORT`     | `7680`                  | Server listen port       |
| `TERMOTE_BIND`     | `0.0.0.0`               | Server bind address      |
| `TERMOTE_PWA_DIR`  | `./pwa/dist`            | Path to PWA static files |
| `TERMOTE_TTYD_URL` | `http://127.0.0.1:7681` | ttyd WebSocket URL       |
| `TERMOTE_USER`     | `admin`                 | HTTP basic auth username |
| `TERMOTE_PASS`     | (empty)                 | HTTP basic auth password |
| `TERMOTE_NO_AUTH`  | `false`                 | Disable basic auth       |

## Port Mapping

```text
nginx:7680 → ttyd:7681 (WebSocket)
           → tmux-api:7682 (REST API)
           → /dist (PWA static files)
```

## Security Hardening

### Basic Auth (Default)

- Enabled by default for all modes
- Credentials stored in `.htpasswd`
- Use `--no-auth` only for local development

### Network Isolation

```bash
# Localhost only (default)
./scripts/deploy.sh --docker

# LAN (trusted network)
./scripts/deploy.sh --docker --lan

# Tailscale (recommended for remote)
./scripts/deploy.sh --docker --tailscale myhost.ts.net
```

### Recommendations

1. **Production**: Always use Tailscale HTTPS
2. **LAN**: Ensure network is trusted, consider VPN
3. **Never expose to public internet** without additional security
4. **fail2ban**: Consider for brute-force protection

## Health Check

```bash
make health
# Or manually:
./scripts/health-check.sh
curl http://localhost:7682/windows
```

## Troubleshooting

### Session not persisting

```bash
tmux ls                    # Check tmux sessions
docker logs termote        # Check container logs
```

### WebSocket errors

- Check nginx `proxy_read_timeout` (should be high, e.g., 3600s)
- Verify WebSocket upgrade headers in nginx config

### Hybrid mode: tmux-api can't find session

```bash
ls -la /tmp/tmux-$(id -u)/  # Verify tmux socket exists
# Check TMUX_SOCKET env in container
docker exec termote env | grep TMUX
```

### Container won't start

```bash
docker logs termote
# Or with podman:
podman logs termote
# Common: port already in use
lsof -i :7680
```

### Podman hybrid mode on macOS: can't reach ttyd

Ensure ttyd is listening on 127.0.0.1:7681. Hybrid mode on macOS+podman runs fully natively:

```bash
ps aux | grep ttyd        # Check if ttyd is running
lsof -i :7681            # Verify port is in use
```

### Podman hybrid mode: tmux socket not found

Container can't reach host tmux socket:

```bash
# Linux: check socket dir
ls -la /tmp/tmux-$(id -u)/

# macOS: check socket in private tmp
ls -la /private/tmp/tmux-$(id -u)/

# Verify socket permissions (must be 700)
stat /tmp/tmux-*/default 2>/dev/null
```

## Uninstall

```bash
./scripts/uninstall.sh --docker   # Docker containers
./scripts/uninstall.sh --hybrid   # Hybrid mode
./scripts/uninstall.sh --native   # Systemd + files
./scripts/uninstall.sh --all      # Everything
```
