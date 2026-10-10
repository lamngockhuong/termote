# Deployment Guide

## Prerequisites

| Dependency    | Native (Unix)                        | Native (Windows)      | Container Mode |
| ------------- | ------------------------------------ | --------------------- | -------------- |
| tmux          | One of tmux or herdr (`--mux tmux`)  | -                     | -              |
| herdr         | One of tmux or herdr (`--mux herdr`) | One of psmux or herdr | -              |
| psmux         | -                                    | One of psmux or herdr | -              |
| Docker/Podman | -                                    | -                     | Required       |

Native mode needs one terminal backend, not both: tmux (psmux on Windows), or a running
[Herdr](https://herdr.dev/#install) server. The first `termote start` detects which one is there, and asks when it finds both.

> **Windows Support**: native mode requires psmux or a running Herdr server; container mode
> requires Docker Desktop or Podman Desktop. Report any issues on GitHub.

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
it never starts anything itself. From 1.10.0 on, `install.sh` also checks the release
signature (see Updating) when OpenSSL 3 is there, and says so when it is not (LibreSSL on
macOS); `install.ps1` cannot check it, as Windows PowerShell has no Ed25519. Pin a version, or rescue a broken install, with
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

### Pre-releases

A pre-release (`X.Y.Z-rc.N`) is never picked on its own: without `TERMOTE_VERSION` the installer,
like `termote update` without `--version`, takes the newest **published** stable 1.x release. A
release counts once it is published, not when its tag appears: release-please pushes the tag
while the release is still a draft waiting for the `release` environment's approval, and a
draft's archives cannot be downloaded. Name the pre-release to install it:

```bash
curl -fsSL https://termote.ohnice.app/install.sh | TERMOTE_VERSION=1.13.0-rc.1 sh
termote update --version 1.13.0-rc.1   # an existing install
```

```powershell
$env:TERMOTE_VERSION = '1.13.0-rc.1'; irm https://termote.ohnice.app/install.ps1 | iex
```

It too has to be published first; until then the download fails with `still publishing`. The
site serves the installer of the last stable release (it is redeployed only after one, see
[`release-guide.md`](release-guide.md#website-deploys)); to run the pre-release's own installer,
take it from the tag:

```bash
curl -fsSL https://raw.githubusercontent.com/lamngockhuong/termote/v1.13.0-rc.1/scripts/install.sh | TERMOTE_VERSION=1.13.0-rc.1 sh
```

```powershell
$env:TERMOTE_VERSION = '1.13.0-rc.1'; irm https://raw.githubusercontent.com/lamngockhuong/termote/v1.13.0-rc.1/scripts/install.ps1 | iex
```

The tag's installer still needs `TERMOTE_VERSION`: without it, it takes the newest stable release
like any other. To go back to stable, run `termote update`. Before the final `X.Y.Z` is out
that is a downgrade (a pre-release sorts above the release before it), which `update` makes
with a warning.

**Coming from 0.x:** there is no in-place upgrade. Remove the 0.x version completely first (its
`uninstall` only stops it; see
[Coming from a 0.x install](getting-started.md#coming-from-a-0x-install) for the commands),
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
winget install psmux   # tmux-compatible backend for Windows (or run Herdr instead)

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

Single container with termote + tmux or Herdr (no ttyd), published at `-p <bind>:<port>:7680`. Runs
`ghcr.io/lamngockhuong/termote:<version of the installed binary>` with podman (preferred) or
docker (from 1.10.0 by the digest the release's signed `image-digest.txt` names, never by the
tag, which can be moved); from a git checkout (or `--build`) it builds `termote:local` from the `Dockerfile`
instead of pulling. Default workspace `~/termote-workspace`, mounted with `--mount` at
`/workspace`; change it with `--workspace <dir>`. The container runs as `--user <uid>:<gid>`
(rootless podman: `--userns=keep-id` instead; rootless Docker: no `--user` at all). The
username, password and Host allowlist are passed as `-e NAME` values taken from the CLI's own process
environment — never written to a file or a command-line argument (`docker inspect` still shows
them, as with any container env var). The container's password is shared with the native
server (setting a new one with `--fresh` applies to both; `--no-auth` on either side keeps the
shared password saved rather than clearing it), and so is the username (`--user` on either side;
the other takes it at its next `termote restart` or `container up`).

**Container Runtime:** Auto-detects podman (preferred) or docker.

**Backend:** the image carries both tmux and a pinned [Herdr](https://herdr.dev) release;
`--mux <tmux|herdr>` picks one. The first `container up` without `--mux` asks in a terminal and
uses tmux otherwise; the choice is saved with the container settings (apart from the native
`--mux`), and `--mux tmux` switches back. With `--mux herdr` the Herdr server runs inside the
container, so it sees only the container's terminals, never the host's Herdr or agents. No
Herdr client is attached there, so panes keep Herdr's own size and the PWA fits the terminal to
it rather than resizing the pane.

**When to use:** Simple setup, isolated environment.

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
| `--mux <tmux\|herdr>`       | Terminal backend (`start`: detected; container: asked)     | ✓       | ✓              |
| `--allow-host <name>`       | Allow an extra Host header value (repeatable, no wildcard) | ✓       | ✓              |
| `--remove-host <name>`      | Remove a previously allowed name (repeatable)              | ✓       | ✓              |
| `--allow-herdr-no-auth`     | Required together with `--mux herdr --no-auth`             | ✓       | ✓              |
| `--user <name>`             | Login username (default `admin`; shared by both)           | ✓       | ✓              |
| `--fresh`                   | Set a new password (ignore the saved one)                  | ✓       | ✓              |
| `--workspace <dir>`         | Mounted directory (default `~/termote-workspace`)          | -       | ✓              |
| `--build`                   | Build `termote:local` from a checkout instead of pulling   | -       | ✓              |

`update` takes `--version <X.Y.Z>` and `--force` instead. There is no `--ttyd` flag and no
PowerShell `-Flag` parameter names in 1.0.

## Config Persistence

`start` and `container up` save their settings automatically, separately from each other (a
`container` config and a native config can coexist, but share the same username and password):

- **Unix:** `~/.config/termote/config` (`$XDG_CONFIG_HOME`), plus a `secret` file (0600) that
  keys the password's encryption
- **Windows:** `%APPDATA%\termote\config.json` (password DPAPI-encrypted)

Saved settings include the port, network flags (`--lan`, `--tailscale`), auth setting
(`--no-auth`), mux backend, the Host allowlist, the workspace (container only), the login
username (`--user`, default `admin`) and the encrypted password.

**Reusing saved config:**

- On restart, the existing config is loaded automatically; a flag not given on the command
  line keeps its saved value
- The password is reused unless `--fresh` is given (view it again with `termote show-password`)
- The username is kept unless `--user <name>` is given: 1 to 64 letters, digits, `.`, `_`, `-`
  or `@`, starting with a letter or digit (no `:`, which separates it from the password)

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
(`--tailscale host:8443`). The native server removes its mapping when it stops (a stop, or a
logout without lingering), so the Tailscale name
never leads to a port it no longer holds (a crash leaves it until the service restarts); it adds it again when it starts. `stop`,
`start --no-tailscale`, `container down` and `uninstall` remove only Termote's own mapping, and only while it still points at their own port
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
| `TERMOTE_MUX`                 | `tmux`       | Backend: `tmux` or `herdr`; in the image, also picks what starts     |
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

### Paired devices and the view-only role

Instead of sharing the password, `termote pair` makes a one-time code (`--role view|full`, default
`view`; `--name`; `--expires 12h|7d|2w|never`, default `30d`) that a new device types at `/pair`;
`termote devices` lists the paired devices with their limit and who paired them, and
`termote devices revoke <id>` signs one out with every device it paired. Only the password (or the
CLI) pairs a full device; a paired device pairs view-only ones. A paired device holds a cookie valid
400 days, refused past its limit (a cookie is not bound to a port, so give Termote a host name of
its own). What a paired device can be trusted with: [`security-model.md`](security-model.md). The server must run with sign-in
on; with `--no-auth` the commands answer 501. A new password (`start --fresh`) signs every device out.
Devices live in `<stateDir>/devices/`; in the container that is the volume `termote-state-<uid>`,
kept by `container down` and removed by `uninstall --purge`. Design, limits and trade-offs:
[`system-architecture.md`](system-architecture.md#paired-devices-and-the-view-only-role).

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
5. **A host name of its own**: browsers send cookies to every port of a host name, so any other
   web service on the same name (another port, another app on the same domain) receives the
   session cookie when the user opens it. On a server that runs anything else, reach Termote
   under a name only it answers on (its Tailscale name, or e.g. `termote.example.com`); Log out
   in the More menu ends a session on the server

## Health Check

```bash
make health
# Or manually:
termote status
termote status --json   # one JSON object for scripts (no password); exit 1 when not running
curl http://localhost:7680/api/mux/health
```

## Links and the Herdr Plugin

`termote url` prints the address to open, on Tailscale, else the first LAN address, else
`localhost` (never with the password): `--group/--tab/--pane` (the ids of
`/api/mux/snapshot`) and `--view` make it a deep link, `--herdr` takes them from a Herdr plugin
context, and `--open`, `--copy`, `--qr` open it, copy it or print a QR code. Only the link goes to
stdout.

The Herdr plugin in [`herdr-plugin/`](../herdr-plugin/README.md)
(`herdr plugin install lamngockhuong/termote/herdr-plugin`, Herdr 0.7.4+) runs these commands:
a `panel` popup (`termote panel`: status, every address, a QR code of the focused pane's link,
keys to open, copy, start, stop and restart) and the actions `panel`, `open`, `copy`, `start`,
`stop`, `restart`. On Linux and macOS each entry runs `herdr-plugin/bin/termote.sh`, which finds
`termote` on `PATH`, in `~/.local/bin` or in the install (Herdr's own `PATH` often lacks
`~/.local/bin`) and keeps the popup open when it is missing, too old or fails; Windows entries
(ids ending in `-windows`) run `termote` from the user `PATH`. It selects the pane only when the
server runs the Herdr backend. User guide:
[Herdr Plugin](https://termote.ohnice.app/usage/herdr-plugin/).

A server started detached (no systemd/launchd/Scheduled Task) from a Herdr pane or the plugin
drops Herdr's per-pane variables (`HERDR_ENV`, `HERDR_PANE_ID`, `HERDR_PLUGIN_*`, ...) and keeps
`HERDR_SOCKET_PATH`, so its terminals do not claim to be that pane.

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

# View the saved username and password again
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
curl -u admin:password http://localhost:7680/api/mux/health   # or the name set with --user
```

## Updating

```bash
termote update                   # Update to the latest stable 1.x release
termote update --version 1.0.1   # Pin to a specific version
termote update --version 1.13.0-rc.1  # A pre-release (never picked without --version)
termote update --force           # Force reinstall current version
```

`update` downloads the archive and its checksum (mandatory) and, for 1.10.0 and later, the
release's `checksums.txt` with its signature, checked against the public key built into the
binary: a release published from a pushed tag, or an asset replaced afterwards, is refused even
when its checksums match. A release before 1.10.0 is checked against its `.sha256` alone, with a
warning. It then unpacks it into a new
`versions/<v>`, switches the `current` pointer atomically, restarts the service and waits for
health to report the new version. It refuses in a git checkout, for a binary not installed
by the installer, and when the service runs another binary (registered from a checkout with
`./scripts/termote.sh start`: run `termote start` from the install first); the saved config and service registration are untouched, and only the
current and previous version are kept on disk.

## Uninstall

```bash
termote uninstall          # keeps the config (and saved password), the logs and the deleted files
termote uninstall --purge  # removes them too
```

Removes the service registration, Termote's Tailscale mapping, the `termote` command, the
install root and the images uploaded from the PWA (a cache: `~/.cache/termote/uploads`,
`~/Library/Caches/termote/uploads` on macOS, inside the install root on Windows). The saved
config (`~/.config/termote/`) and logs (`~/.local/state/termote/`) stay, so a reinstall keeps the
password (signed-in devices stay signed in) and the container still shares it; the command prints
both paths. The files deleted from the PWA's Files view stay as well, in the trash next to the
uploads (`~/.cache/termote/trash`, `~/Library/Caches/termote/trash` on macOS): they are the
user's files, not a cache, so a plain `uninstall` prints their path and keeps them. `--purge`
removes all of these (the interactive menu asks). Run from a checkout while
a release is installed, `--purge` keeps them, since that install still uses them.

On Windows the command cannot delete the binary it runs from: what is still locked is removed
by a hidden PowerShell process once the command has exited.
