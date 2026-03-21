# Deployment Guide

## Prerequisites

| Dependency | Docker Mode | Hybrid Mode | Native Mode |
| ---------- | ----------- | ----------- | ----------- |
| Docker     | Required    | Required    | -           |
| ttyd       | -           | Required    | Required    |
| tmux       | -           | Required    | Required    |
| nginx      | -           | -           | Required    |
| Go 1.21+   | -           | -           | Required    |

## Deployment Modes

### Docker (All-in-one)

Single container with nginx + ttyd + tmux + tmux-api.

```bash
./scripts/deploy.sh --docker             # localhost with basic auth
./scripts/deploy.sh --docker --no-auth   # localhost without auth
./scripts/deploy.sh --docker --lan       # LAN accessible
```

**When to use:** Simple setup, no host binary access needed.

### Hybrid

Container (nginx + tmux-api) + Native ttyd.

```bash
# Install ttyd first
sudo apt install ttyd tmux  # Ubuntu/Debian
brew install ttyd tmux      # macOS

./scripts/deploy.sh --hybrid
./scripts/deploy.sh --hybrid --lan
```

**When to use:** Need ttyd to access host binaries (claude, git, node).

### Native

All services run natively with systemd.

```bash
sudo apt install ttyd tmux nginx
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

## Tailscale HTTPS

Auto SSL via `tailscale serve` (no manual cert management):

```bash
./scripts/deploy.sh --docker --tailscale myhost.ts.net
./scripts/deploy.sh --hybrid --tailscale myhost.ts.net:8765
./scripts/deploy.sh --docker --tailscale myhost.ts.net --lan
```

## Environment Variables

| Variable       | Default               | Description                      |
| -------------- | --------------------- | -------------------------------- |
| `TMUX_SOCKET`  | `/tmp/tmux-*/default` | Custom tmux socket path (hybrid) |
| `TERMOTE_PORT` | `7680`                | Main nginx port                  |
| `TTYD_PORT`    | `7681`                | ttyd WebSocket port              |
| `API_PORT`     | `7682`                | tmux-api HTTP port               |

## Port Mapping

```
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
# Common: port already in use
lsof -i :7680
```

## Uninstall

```bash
./scripts/uninstall.sh --docker   # Docker containers
./scripts/uninstall.sh --hybrid   # Hybrid mode
./scripts/uninstall.sh --native   # Systemd + files
./scripts/uninstall.sh --all      # Everything
```
