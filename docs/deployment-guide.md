# Deployment Guide

## Prerequisites

| Dependency    | Container Mode | Native Mode (Unix)                | Native Mode (Windows)             |
| ------------- | -------------- | --------------------------------- | --------------------------------- |
| Docker/Podman | Required       | -                                 | -                                 |
| tmux          | -              | Required (default `--mux tmux`)   | -                                 |
| psmux         | -              | -                                 | Required (`winget install psmux`) |
| herdr         | -              | Required only for `--mux herdr`   | Required only for `--mux herdr`   |
| Go 1.24+      | -              | Required (build from source only) | Required (build from source only) |

> **Windows Support**: Container mode requires Docker Desktop or Podman Desktop; native mode
> requires psmux (or herdr for the Herdr backend). Report any issues on GitHub.

ttyd is not used anywhere in 1.0.0: tmux-api streams the terminal itself (PTY on Unix,
ConPTY on Windows) into xterm.js in the PWA. See
[`system-architecture.md`](system-architecture.md) for the request/stream design and
[`upgrade-1.0.md`](upgrade-1.0.md) if you are upgrading a 0.x install.

## Deployment Modes

### Container Mode (All-in-one)

Single container with tmux-api + tmux (no ttyd).

```bash
./scripts/termote.sh                           # Interactive menu
./scripts/termote.sh install container          # localhost with basic auth
./scripts/termote.sh install container --no-auth  # localhost without auth
./scripts/termote.sh install container --lan    # LAN accessible
./scripts/termote.sh link                       # Create 'termote' global command
```

**Container Runtime:** Auto-detects podman (preferred) or docker.

**When to use:** Simple setup, isolated environment. The Herdr backend is not available in
container mode (`--mux herdr` requires `native`).

### Native

All services run natively (no container). tmux-api opens the terminal itself; there is
nothing else to install for the terminal transport.

**Linux:**

```bash
sudo apt install tmux

./scripts/termote.sh install native
./scripts/termote.sh install native --lan
./scripts/termote.sh install native --mux herdr   # Herdr backend instead of tmux
```

**macOS:**

```bash
brew install tmux go

./scripts/termote.sh install native
./scripts/termote.sh install native --lan
```

**Windows (PowerShell):**

> **Note:** If script execution is disabled, run first:
> `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned`

```powershell
# Install psmux (tmux-compatible for Windows)
winget install psmux

.\scripts\termote.ps1 install native
.\scripts\termote.ps1 install native -Lan
.\scripts\termote.ps1 install native -Mux herdr   # Herdr backend instead of psmux
```

**When to use:** Need host tool access (claude, git, node), no container overhead, or the
Herdr backend.

## Command Options

**Unix (termote.sh):**

| Flag                        | Description                                                |
| --------------------------- | ---------------------------------------------------------- |
| `--lan`                     | Expose to LAN (default: localhost only)                    |
| `--tailscale <host[:port]>` | Enable Tailscale HTTPS                                     |
| `--no-auth`                 | Disable basic authentication                               |
| `--port <port>`             | Host port (default: 7680)                                  |
| `--mux <tmux\|herdr>`       | Terminal backend, native only (default: `tmux`)            |
| `--allow-host <name>`       | Allow an extra Host header value (repeatable, no wildcard) |
| `--allow-herdr-no-auth`     | Required together with `--mux herdr --no-auth`             |
| `--fresh`                   | Force new password prompt (ignore saved config)            |

**Windows (termote.ps1):**

| Flag                 | Description                                                |
| -------------------- | ---------------------------------------------------------- |
| `-Lan`               | Expose to LAN (default: localhost only)                    |
| `-Tailscale <h>`     | Enable Tailscale HTTPS                                     |
| `-NoAuth`            | Disable basic authentication                               |
| `-Port <port>`       | Host port (default: 7680, or 7690 if installed standalone) |
| `-Mux <tmux\|herdr>` | Terminal backend, native only (default: `tmux`)            |
| `-AllowHost <name>`  | Allow an extra Host header value (repeatable, no wildcard) |
| `-AllowHerdrNoAuth`  | Required together with `-Mux herdr -NoAuth`                |
| `-Fresh`             | Force new password prompt (ignore saved config)            |
| `-Version <X.Y.Z>`   | Pin `update` to a specific version                         |
| `-Force`             | Reinstall current version (with `update`)                  |

`--ttyd`/`-Ttyd` is still accepted (a 0.x install passes it when it relaunches the new
installer during `update`) but is ignored with a warning.

## Config Persistence

Installation settings are automatically saved:

- **Unix:** `~/.termote/config` (AES-256 encrypted password, chmod 600)
- **Windows:** `~/.termote/config.json` (DPAPI encrypted password)

Saved settings include mode, network flags (`--lan`, `--tailscale`), auth setting
(`--no-auth`), mux backend, the Host allowlist, and the encrypted password.

**Reusing saved config:**

- On restart, existing config is loaded automatically
- Password is reused unless `--fresh`/`-Fresh` flag is provided (view it again with
  `termote show-password`)
- Useful for quick restarts without re-entering settings

```bash
# Unix: First install (saves config)
./scripts/termote.sh install container --lan

# Restart later (reuses saved mode, flags, password)
./scripts/termote.sh install container --lan

# Force new password
./scripts/termote.sh install container --lan --fresh
```

```powershell
# Windows: First install (saves config)
.\scripts\termote.ps1 install container -Lan

# Restart later (reuses saved config)
.\scripts\termote.ps1 install container -Lan

# Force new password
.\scripts\termote.ps1 install container -Lan -Fresh
```

## Tailscale HTTPS

Auto SSL via `tailscale serve` (no manual cert management); the Tailscale name is also added
to the Host allowlist automatically:

```bash
./scripts/termote.sh install container --tailscale myhost.ts.net
./scripts/termote.sh install native --tailscale myhost.ts.net:8765
./scripts/termote.sh install container --tailscale myhost.ts.net --lan
```

## Environment Variables

### tmux-api Server

| Variable                      | Default      | Description                                                          |
| ----------------------------- | ------------ | -------------------------------------------------------------------- |
| `TERMOTE_PORT`                | `7680`       | Server listen port                                                   |
| `TERMOTE_BIND`                | `0.0.0.0`    | Server bind address                                                  |
| `TERMOTE_PWA_DIR`             | `./pwa/dist` | Path to PWA static files                                             |
| `TERMOTE_USER`                | `admin`      | HTTP basic auth username                                             |
| `TERMOTE_PASS`                | (empty)      | HTTP basic auth password                                             |
| `TERMOTE_NO_AUTH`             | `false`      | Disable basic auth                                                   |
| `TERMOTE_MUX`                 | `tmux`       | Backend: `tmux` or `herdr` (native only)                             |
| `TERMOTE_ALLOWED_HOSTS`       | (empty)      | Extra `Host` header values, comma-separated; loopback always allowed |
| `TERMOTE_HERDR_ALLOW_NO_AUTH` | `false`      | Required with `TERMOTE_MUX=herdr` and `TERMOTE_NO_AUTH=true`         |

`termote install` computes and sets `TERMOTE_ALLOWED_HOSTS` from `--lan`/`--tailscale`/
`--allow-host`; you only need to set it by hand when running the server outside the CLI.

## Port Mapping

```text
tmux-api:7680 → /api/mux/stream (terminal WebSocket, xterm.js)
             → /api/mux/* (REST API)
             → /* (PWA static files)
```

## Security Hardening

### Basic Auth (Default)

- Enabled by default for all modes
- Credentials auto-generated on first run; an empty saved password no longer disables auth —
  `install` generates and saves a new one instead
- Use `--no-auth` only for local development

### Host allowlist and write guard

- Requests with an unrecognised `Host` header are rejected (DNS-rebinding protection); the
  allowed set is loopback + `--lan` LAN IP + `--tailscale` name + `--allow-host` entries, with
  no wildcard to disable the check
- State-changing `/api/mux/*` requests and the terminal WebSocket require a same-site
  Origin and (for the WebSocket) a single-use token

See [`system-architecture.md`](system-architecture.md#security-model) for the full model.

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
4. **Herdr backend**: only use `--allow-herdr-no-auth` when you understand it exposes every
   Herdr workspace on the host, not just the pane the PWA is showing

## Health Check

```bash
make health
# Or manually:
./scripts/termote.sh health
curl http://localhost:7680/api/mux/health
```

## Troubleshooting

### Quick Diagnostics

```bash
# Health check (works for both modes)
./scripts/termote.sh health

# Check the port
ss -tlnp | grep 7680
lsof -i :7680
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
ps aux                      # Check processes (tmux-api, tmux)
curl localhost:7680/api/mux/health  # Test API
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
ps aux | grep tmux-api
pgrep -f tmux-api
```

#### View logs

```bash
termote logs tmux-api   # Recent log lines
termote logs follow     # Tail live (Ctrl+C to stop)
termote logs clean      # Delete log files
```

Logs are written to `~/.termote/logs/` by the CLI when it starts the server in the
background; running the server binary directly in the foreground prints to stdout/stderr
instead:

```bash
cd tmux-api
TERMOTE_PORT=7680 \
TERMOTE_BIND=127.0.0.1 \
TERMOTE_PWA_DIR=../pwa/dist \
./tmux-api-native serve
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
pnpm --filter termote build
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

#### Herdr backend issues

```bash
# herdr must be on PATH before `install native --mux herdr`
which herdr

# Check the server picked the right backend
curl http://localhost:7680/api/mux/health   # {"backend":"herdr",...}
```

---

### Common Issues (Both Modes)

#### WebSocket / terminal connection failed

1. Check browser console for errors
2. Confirm the server answers at all:

   ```bash
   curl -v http://localhost:7680/  # Should return HTML
   ```

3. A rejected Host header answers 403 with the exact `--allow-host <name>` to add; check the
   server log for `rejected request for host`

#### Authentication issues

```bash
# Check if auth is enabled
curl -v http://localhost:7680/

# 401 = auth enabled, need credentials
# 200 = auth disabled or credentials correct

# View the saved password again
termote show-password

# Reset credentials (container mode)
docker rm -f termote
./scripts/termote.sh install container --fresh  # New password generated
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
pnpm install --filter termote... && pnpm --filter termote build

# Container mode: rebuild image
docker build -t termote .
```

---

### API Debugging

```bash
# Health check
curl http://localhost:7680/api/mux/health

# Snapshot (groups/tabs/panes)
curl http://localhost:7680/api/mux/snapshot

# With auth
curl -u admin:password http://localhost:7680/api/mux/health
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
- `--strict` - Require checksum verification (fail if unavailable)

### Manual Update

```bash
# 1. Stop services
./scripts/termote.sh uninstall [container|native]

# 2. Pull latest
git pull origin main  # If installed from source

# 3. Reinstall with same options
./scripts/termote.sh install [container|native] [--lan] [--tailscale ...]
```

If you are updating a 0.1.x install to 1.0.0, see [`upgrade-1.0.md`](upgrade-1.0.md) for what
changes and what the migration preserves.

## Uninstall

```bash
./scripts/termote.sh uninstall container   # Container mode
./scripts/termote.sh uninstall native      # Native processes
./scripts/termote.sh uninstall all         # Everything (including saved config)
```

**Note:** `uninstall all` removes the saved config file at `~/.termote/config`. Use this when
fully removing Termote or wanting to reset installation settings.
