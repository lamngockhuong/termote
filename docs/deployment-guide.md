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

| Flag                        | Description                                     |
| --------------------------- | ----------------------------------------------- |
| `--lan`                     | Expose to LAN (default: localhost only)         |
| `--tailscale <host[:port]>` | Enable Tailscale HTTPS                          |
| `--no-auth`                 | Disable basic authentication                    |
| `--port <port>`             | Host port (default: 7680)                       |
| `--fresh`                   | Force new password prompt (ignore saved config) |

## Config Persistence

Installation settings are automatically saved to `~/.termote/config` (chmod 600):

- Mode (container/native)
- Network flags (--lan, --tailscale)
- Authentication setting (--no-auth)
- Encrypted password (base64-encoded)

**Reusing saved config:**

**Reusing saved config:**

- On restart, existing config is loaded automatically
- Password is reused unless `--fresh` flag is provided
- Useful for quick restarts without re-entering settings

```bash
# First install (saves config)
./scripts/termote.sh install container --lan

# Restart later (reuses saved mode, flags, password)
./scripts/termote.sh install container --lan

# Force new password
./scripts/termote.sh install container --lan --fresh

# Remove saved config on uninstall
./scripts/termote.sh uninstall all
```

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

### Quick Diagnostics

```bash
# Health check (works for both modes)
./scripts/termote.sh health

# Check ports
ss -tlnp | grep -E "7680|7681"
lsof -i :7680
lsof -i :7681
```

---

### Container Mode

#### View Logs

```bash
docker logs termote
docker logs -f termote      # Follow logs

# Or with podman:
podman logs termote
podman logs -f termote
```

#### Container won't start

```bash
# Check container status
docker ps -a | grep termote

# View startup errors
docker logs termote

# Common: port already in use
lsof -i :7680
# Kill conflicting process or change port
./scripts/termote.sh install container --port 7690
```

#### Enter container for debugging

```bash
docker exec -it termote /bin/sh
# Inside container:
ps aux                      # Check processes
curl localhost:7681         # Test ttyd
curl localhost:7680/api/tmux/health  # Test API
```

#### Restart container

```bash
docker restart termote
# Or full reinstall:
./scripts/termote.sh uninstall container
./scripts/termote.sh install container
```

---

### Native Mode

#### Check running processes

```bash
ps aux | grep ttyd
ps aux | grep tmux-api
pgrep -f "ttyd|tmux-api"
```

#### View logs (debug mode)

By default, native mode discards logs. To debug with logs:

```bash
# Stop existing services
./scripts/termote.sh uninstall native

# Start ttyd manually (foreground with logs)
ttyd -W -i lo -p 7681 tmux new-session -A -s main

# In another terminal, start tmux-api manually
cd tmux-api
TERMOTE_PORT=7680 \
TERMOTE_BIND=127.0.0.1 \
TERMOTE_PWA_DIR=../pwa/dist \
./tmux-api-native
```

#### ttyd not starting

```bash
# Check if ttyd is installed
which ttyd
ttyd --version

# Check if port is in use
lsof -i :7681

# Test ttyd directly
ttyd -p 7681 tmux new-session -A -s main
```

#### tmux-api not starting

```bash
# Check if binary exists
ls -la tmux-api/tmux-api-native

# Rebuild if missing
cd tmux-api && go build -o tmux-api-native .

# Check PWA dist exists
ls -la pwa/dist/

# Rebuild PWA if missing
cd pwa && pnpm build
```

#### tmux session issues

```bash
# List sessions
tmux list-sessions

# Attach to session
tmux attach -t main

# Kill and recreate session
tmux kill-session -t main
tmux new-session -d -s main
```

---

### Common Issues (Both Modes)

#### WebSocket connection failed

1. Verify ttyd running on port 7681
2. Check browser console for errors
3. Test WebSocket proxy:

   ```bash
   curl -v http://localhost:7680/  # Should return HTML
   ```

#### Authentication issues

```bash
# Check if auth is enabled
curl -v http://localhost:7680/

# 401 = auth enabled, need credentials
# 200 = auth disabled or credentials correct

# Reset credentials (container mode)
docker rm -f termote
./scripts/termote.sh install container  # New password generated
```

#### Session not persisting

```bash
# Check tmux sessions exist
tmux ls

# Container mode: check volume
docker inspect termote | grep -A5 Mounts

# Native mode: check tmux server
tmux list-sessions
```

#### PWA not loading / blank page

```bash
# Check PWA files exist
ls -la pwa/dist/

# Rebuild PWA
cd pwa && pnpm install && pnpm build

# Container mode: rebuild image
docker build -t termote .
```

---

### API Debugging

```bash
# Health check
curl http://localhost:7680/api/tmux/health

# List sessions
curl http://localhost:7680/api/tmux/sessions

# With auth
curl -u admin:password http://localhost:7680/api/tmux/health
```

## Updating

### Via One-liner (Recommended)

Re-run the installer - it compares versions and prompts before updating:

```bash
# Auto-update using saved config
curl -fsSL https://raw.githubusercontent.com/lamngockhuong/termote/main/scripts/get.sh | bash -s -- --update

# Or standard update
curl -fsSL https://raw.githubusercontent.com/lamngockhuong/termote/main/scripts/get.sh | bash
```

Options:

- `--update` - Auto-update using saved config (mode, flags, password)
- `--yes` - Auto-update without prompt
- `--download-only` - Download only, no install
- `--fresh` - Force new password prompt
- `--version <ver>` - Install specific version

### Manual Update

```bash
# 1. Stop services
./scripts/termote.sh uninstall [container|native]

# 2. Pull latest
git pull origin main  # If installed from source

# 3. Reinstall with same options
./scripts/termote.sh install [container|native] [--lan] [--tailscale ...]
```

## Uninstall

```bash
./scripts/termote.sh uninstall container   # Container mode
./scripts/termote.sh uninstall native      # Native processes
./scripts/termote.sh uninstall all         # Everything (including saved config)
```

**Note:** `uninstall all` removes the saved config file at `~/.termote/config`. Use this when fully removing Termote or wanting to reset installation settings.
