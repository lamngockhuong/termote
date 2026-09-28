# Deployment Guide

## Prerequisites

| Dependency    | Native (Unix)                   | Native (Windows)                  | Container Mode |
| ------------- | ------------------------------- | --------------------------------- | -------------- |
| tmux          | Required (default `--mux tmux`) | -                                 | -              |
| psmux         | -                               | Required (`winget install psmux`) | -              |
| herdr         | Required only for `--mux herdr` | Required only for `--mux herdr`   | -              |
| Docker/Podman | -                               | -                                 | Required       |

> **Windows Support**: native mode requires psmux (or herdr for the Herdr backend); container
> mode requires Docker Desktop or Podman Desktop. Report any issues on GitHub.

ttyd is not used anywhere in 1.0: termote streams the terminal itself (PTY on Unix, ConPTY on
Windows) into xterm.js in the PWA. See [`system-architecture.md`](system-architecture.md) for
the request/stream design.

## Installing

```bash
curl -fsSL https://termote.ohnice.app/install.sh | sh      # Linux, macOS
```

```powershell
irm https://termote.ohnice.app/install.ps1 | iex           # Windows
```

The installer needs only `curl`, `tar` and `sha256sum`/`shasum` (Windows: PowerShell) — no
sudo/admin. It downloads the newest stable 1.x release for your OS/arch, verifies its
`.sha256` (mandatory), lays it out under a versioned install root and prints `termote start` —
it never starts anything itself. Pin a version, or rescue a broken install, with
`TERMOTE_VERSION`:

```bash
curl -fsSL https://termote.ohnice.app/install.sh | TERMOTE_VERSION=1.0.0 sh
```

```powershell
$env:TERMOTE_VERSION = '1.0.0'; irm https://termote.ohnice.app/install.ps1 | iex
```

An existing install is left alone (the installer prints `termote update` instead) unless
`TERMOTE_VERSION` names a different version, in which case that version is laid down beside it
and made current.

**Coming from 0.x:** there is no in-place upgrade. Uninstall the 0.x version first (see the
archived [0.x documentation](https://termote.ohnice.app/0.x/) for its own uninstall steps),
then install 1.0 fresh with the command above.

## Deployment Modes

### Native

All services run natively (no container): termote on port 7680 (7690 on Windows) serving the
PWA, the terminal stream and the API. There is nothing else to install for the terminal
transport — termote opens it itself.

**Linux:**

```bash
sudo apt install tmux

termote start
termote start --lan
termote start --mux herdr   # Herdr backend instead of tmux
```

**macOS:**

```bash
brew install tmux

termote start
termote start --lan
```

**Windows (PowerShell):**

```powershell
winget install psmux   # tmux-compatible backend for Windows

termote start
termote start --lan
termote start --mux herdr   # Herdr backend instead of psmux
```

`start` registers the server with the OS supervisor so it survives logins: a systemd user unit
on Linux (falls back to a detached process + PID file where there is no user systemd, e.g.
WSL2), a launchd agent on macOS, a Scheduled Task on Windows (no admin needed). `stop` keeps
the registration — it starts again at the next login; `uninstall` removes it.

**When to use:** need host tool access (claude, git, node), no container overhead, or the
Herdr backend.

### Container Mode (All-in-one)

```bash
termote container up
termote container up --no-auth      # localhost without auth
termote container up --lan          # LAN accessible
```

Single container with termote + tmux (no ttyd), published at `-p <bind>:<port>:7680`. Runs
`ghcr.io/lamngockhuong/termote:<version of the installed binary>` with podman (preferred) or
docker; from a git checkout (or `--build`) it builds `termote:local` from the `Dockerfile`
instead of pulling. Default workspace `~/termote-workspace`, mounted with `--mount` at
`/workspace`; change it with `--workspace <dir>`. The container runs as `--user <uid>:<gid>`
(rootless podman: `--userns=keep-id` instead; rootless Docker: no `--user` at all). The
password and Host allowlist are passed as `-e NAME` values taken from the CLI's own process
environment — never written to a file or a command-line argument (`docker inspect` still shows
them, as with any container env var). The container's password is shared with the native
server (setting a new one with `--fresh` applies to both; `--no-auth` on either side keeps the
shared password saved rather than clearing it).

**Container Runtime:** Auto-detects podman (preferred) or docker.

**When to use:** Simple setup, isolated environment. The Herdr backend is not available in
container mode (`--mux herdr` requires native).

## Command Options

`start` and `container up` share the same flag syntax on every OS in 1.0 (`--lan`, not
`-Lan`); a flag not given keeps its saved value, and a boolean is turned off with `=false`.

| Flag                        | Description                                                | `start` | `container up` |
| --------------------------- | ---------------------------------------------------------- | ------- | -------------- |
| `--lan[=false]`             | Listen on `0.0.0.0` instead of `127.0.0.1`                 | ✓       | ✓              |
| `--tailscale <host[:port]>` | Publish over Tailscale HTTPS (default port 443)            | ✓       | ✓              |
| `--no-tailscale`            | Stop publishing over Tailscale                             | ✓       | ✓              |
| `--no-auth[=false]`         | Disable basic authentication                               | ✓       | ✓              |
| `--port <port>`             | Listen port (default 7680, Windows 7690 for `start`)       | ✓       | ✓              |
| `--mux <tmux\|herdr>`       | Terminal backend, native only (default: detected)          | ✓       | -              |
| `--allow-host <name>`       | Allow an extra Host header value (repeatable, no wildcard) | ✓       | ✓              |
| `--remove-host <name>`      | Remove a previously allowed name (repeatable)              | ✓       | ✓              |
| `--allow-herdr-no-auth`     | Required together with `--mux herdr --no-auth`             | ✓       | -              |
| `--fresh`                   | Set a new password (ignore the saved one)                  | ✓       | ✓              |
| `--workspace <dir>`         | Mounted directory (default `~/termote-workspace`)          | -       | ✓              |
| `--build`                   | Build `termote:local` from a checkout instead of pulling   | -       | ✓              |

`update` takes `--version <X.Y.Z>` and `--force` instead. There is no `--ttyd` flag and no
PowerShell `-Flag` parameter names in 1.0.

## Config Persistence

`start` and `container up` save their settings automatically, separately from each other (a
`container` config and a native config can coexist, but share the same password):

- **Unix:** `~/.config/termote/config` (`$XDG_CONFIG_HOME`), plus a `secret` file (0600) that
  keys the password's encryption
- **Windows:** `%APPDATA%\termote\config.json` (password DPAPI-encrypted)

Saved settings include the port, network flags (`--lan`, `--tailscale`), auth setting
(`--no-auth`), mux backend, the Host allowlist, the workspace (container only) and the
encrypted password.

**Reusing saved config:**

- On restart, the existing config is loaded automatically; a flag not given on the command
  line keeps its saved value
- The password is reused unless `--fresh` is given (view it again with `termote show-password`)

```bash
# First start (saves config)
termote start --lan

# Restart later (reuses saved flags, password)
termote start

# Force a new password
termote start --fresh
```

## Tailscale HTTPS

Auto SSL via `tailscale serve --bg` (no manual cert management); the Tailscale name is also
added to the Host allowlist automatically. It is applied at every start (boot, restart,
update), and never runs with `sudo`:

```bash
termote start --tailscale myhost.ts.net
termote container up --tailscale myhost.ts.net:8765
termote start --tailscale myhost.ts.net --lan
```

On Linux, run `sudo tailscale set --operator=$USER` once — `start` prints this hint if the
`tailscale serve` call is refused. An HTTPS port already serving something else (for example
the native server, from `container up`) is refused too; pick another port
(`--tailscale host:8443`). `stop`, `start --no-tailscale`, `container down` and `uninstall`
remove only Termote's own mapping, and only while it still points at their own port
(`tailscale serve --https=<port> off`), never `tailscale serve reset`, which would drop
mappings that are not Termote's.

## Environment Variables (no saved config only)

`termote serve` reads the saved config and ignores every `TERMOTE_*` variable whenever one
exists; these variables only configure the server when there is no saved config — the
container image (the CLI passes them as `-e NAME` from its own environment, never on the command line), or a
manual `go run`/`termote-dev serve` from a checkout:

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

You do not set these by hand for a normal install: `termote start`/`container up` compute and
save the equivalent settings from their flags.

## Port Mapping

```text
termote:7680 → /api/mux/stream (terminal WebSocket, xterm.js)
             → /api/mux/* (REST API)
             → /* (PWA static files)
```

## Security Hardening

### Basic Auth (Default)

- Enabled by default for all modes
- Credentials auto-generated on first run; an empty saved password no longer disables auth —
  `start`/`container up` generate and save a new one instead
- Use `--no-auth` only for local development

### Host allowlist and write guard

- Requests with an unrecognised `Host` header are rejected (DNS-rebinding protection); the
  allowed set is loopback + (with `--lan`) the address the request arrived on + the Tailscale
  name + `--allow-host` entries, with no wildcard to disable the check
- State-changing `/api/mux/*` requests and the terminal WebSocket require a same-site
  Origin and (for the WebSocket) a single-use token

See [`system-architecture.md`](system-architecture.md#security-model) for the full model.

### Network Isolation

```bash
# Localhost only (default)
termote start

# LAN (trusted network)
termote start --lan

# Tailscale (recommended for remote)
termote start --tailscale myhost.ts.net
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
termote status
curl http://localhost:7680/api/mux/health
```

## Troubleshooting

### Quick Diagnostics

```bash
# Health check (works for both modes)
termote status

# Check the port
ss -tlnp | grep 7680
lsof -i :7680
```

---

### Container Mode

#### View Logs

```bash
termote container logs
termote container logs -f    # Follow logs
```

#### Container won't start

```bash
# Check container status
termote container status
docker ps -a | grep termote   # or: podman ps -a | grep termote

# Common: port already in use
lsof -i :7680
# Kill conflicting process or change port
termote container up --port 7690
```

#### Enter container for debugging

```bash
docker exec -it termote /bin/sh
# Inside container:
ps aux                      # Check processes (termote, tmux)
curl localhost:7680/api/mux/health  # Test API
```

#### Restart container

```bash
docker restart termote
# Or full reinstall:
termote container down
termote container up
```

---

### Native Mode

#### Check running processes

```bash
ps aux | grep termote
pgrep -f "termote serve"
```

#### View logs

```bash
termote logs server     # Recent log lines
termote logs follow     # Tail live (Ctrl+C to stop)
termote logs clean      # Delete log files
```

Logs and the PID file live in `~/.local/state/termote/` (`$XDG_STATE_HOME`) on Unix,
`%LOCALAPPDATA%\termote\state` on Windows. Running the server binary directly in the
foreground prints to stdout/stderr instead:

```bash
cd server
go build -o termote-dev .
TERMOTE_PORT=7680 \
TERMOTE_BIND=127.0.0.1 \
TERMOTE_PWA_DIR=../pwa/dist \
./termote-dev serve
```

#### Server not starting

```bash
# Check if the dev binary exists
ls -la server/termote-dev

# Rebuild if missing
cd server && go build -o termote-dev .

# Check the PWA build exists
ls -la pwa/dist/

# Rebuild the PWA if missing
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
# herdr must be on PATH before `termote start --mux herdr`
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

# Reset credentials
termote start --fresh          # native
termote container up --fresh   # container
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
# Check the PWA build exists (checkout only)
ls -la pwa/dist/

# Rebuild the PWA
pnpm install --filter termote... && pnpm --filter termote build

# Container mode: rebuild image
termote container up --build
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

```bash
termote update                   # Update to the latest stable 1.x release
termote update --version 1.0.1   # Pin to a specific version
termote update --force           # Force reinstall current version
```

`update` downloads the archive and its `.sha256` (mandatory), unpacks it into a new
`versions/<v>`, switches the `current` pointer atomically, restarts the service and waits for
health to report the new version. It refuses in a git checkout, and for a binary not installed
by the installer; the saved config and service registration are untouched, and only the
current and previous version are kept on disk.

## Uninstall

```bash
termote uninstall
```

Removes the service registration, Termote's Tailscale mapping, the `termote` command and the
install root. The saved config (`~/.config/termote/`) and logs (`~/.local/state/termote/`)
stay; the command prints both paths to delete by hand.
