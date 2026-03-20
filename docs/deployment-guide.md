# Deployment Guide

## Prerequisites

| Dependency    | Container Mode | Native Mode |
| ------------- | -------------- | ----------- |
| Docker/Podman | Required       | -           |
| ttyd          | -              | Required    |
| tmux          | -              | Required    |
| Go 1.21+      | -              | Required    |

## Deployment Modes

### Container Mode (All-in-one)

Single container with tmux-api + ttyd + tmux.

```bash
./scripts/termote.sh                           # Interactive menu
./scripts/termote.sh install container          # localhost with basic auth
./scripts/termote.sh install container --no-auth  # localhost without auth
./scripts/termote.sh install container --lan    # LAN accessible
```

**Container Runtime:** Auto-detects podman (preferred) or docker.

**When to use:** Simple setup, isolated environment.

### Native

All services run natively (no container).

**Linux:**

```bash
sudo apt install ttyd tmux
# Or: sudo snap install ttyd

./scripts/termote.sh install native
./scripts/termote.sh install native --lan
```

**macOS:**

```bash
brew install ttyd tmux go

./scripts/termote.sh install native
./scripts/termote.sh install native --lan
```

**When to use:** Need host tool access (claude, git, node), no container overhead.

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
./scripts/termote.sh install container --tailscale myhost.ts.net
./scripts/termote.sh install native --tailscale myhost.ts.net:8765
./scripts/termote.sh install container --tailscale myhost.ts.net --lan
```

## Environment Variables

### tmux-api Server

| Variable           | Default                 | Description              |
| ------------------ | ----------------------- | ------------------------ |
| `TERMOTE_PORT`     | `7680`                  | Server listen port       |
| `TERMOTE_BIND`     | `0.0.0.0`               | Server bind address      |
| `TERMOTE_PWA_DIR`  | `./pwa/dist`            | Path to PWA static files |
| `TERMOTE_TTYD_URL` | `http://127.0.0.1:7681` | ttyd WebSocket URL       |
| `TERMOTE_USER`     | `admin`                 | HTTP basic auth username |
| `TERMOTE_PASS`     | (empty)                 | HTTP basic auth password |
| `TERMOTE_NO_AUTH`  | `false`                 | Disable basic auth       |

## Port Mapping

```text
tmux-api:7680 → ttyd:7681 (WebSocket proxy)
             → /api/tmux/* (REST API)
             → /* (PWA static files)
```

## Security Hardening

### Basic Auth (Default)

- Enabled by default for all modes
- Credentials auto-generated on first run
- Use `--no-auth` only for local development

### Network Isolation

```bash
# Localhost only (default)
./scripts/termote.sh install container

# LAN (trusted network)
./scripts/termote.sh install container --lan

# Tailscale (recommended for remote)
./scripts/termote.sh install container --tailscale myhost.ts.net
```

### Recommendations

1. **Production**: Always use Tailscale HTTPS
2. **LAN**: Ensure network is trusted, consider VPN
3. **Never expose to public internet** without additional security

## Health Check

```bash
make health
# Or manually:
./scripts/termote.sh health
curl http://localhost:7680/api/tmux/health
```

## Troubleshooting

### Session not persisting

```bash
tmux ls                    # Check tmux sessions
docker logs termote        # Check container logs
```

### WebSocket errors

- Verify ttyd is running on port 7681
- Check tmux-api logs for proxy errors

### Container won't start

```bash
docker logs termote
# Or with podman:
podman logs termote
# Common: port already in use
lsof -i :7680
```

### Native mode: processes not starting

```bash
ps aux | grep ttyd         # Check if ttyd is running
ps aux | grep tmux-api     # Check if tmux-api is running
lsof -i :7680              # Verify port is in use
lsof -i :7681              # Verify ttyd port
```

## Uninstall

```bash
./scripts/termote.sh uninstall container   # Container mode
./scripts/termote.sh uninstall native      # Native processes
./scripts/termote.sh uninstall all         # Everything
```
