<p align="center">
  <img src="pwa/public/banner-readme.svg" alt="Termote" width="600" />
</p>

<p align="center">
  <a href="https://github.com/lamngockhuong/termote/releases"><img src="https://img.shields.io/github/v/release/lamngockhuong/termote?style=flat-square&color=blue" alt="Release" /></a>
  <a href="https://github.com/lamngockhuong/termote/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/lamngockhuong/termote/ci.yml?branch=main&style=flat-square&label=CI" alt="CI" /></a>
  <a href="https://github.com/lamngockhuong/termote/blob/main/LICENSE"><img src="https://img.shields.io/github/license/lamngockhuong/termote?style=flat-square" alt="License" /></a>
  <a href="https://ghcr.io/lamngockhuong/termote"><img src="https://img.shields.io/badge/GHCR-termote-blue?style=flat-square&logo=github" alt="GHCR" /></a>
  <a href="https://hub.docker.com/r/lamngockhuong/termote"><img src="https://img.shields.io/docker/pulls/lamngockhuong/termote?style=flat-square&logo=docker" alt="Docker Pulls" /></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Go-1.21-00ADD8?style=flat-square&logo=go&logoColor=white" alt="Go" />
  <img src="https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=black" alt="React" />
  <img src="https://img.shields.io/badge/TypeScript-5.9-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/PWA-ready-5A0FC8?style=flat-square&logo=pwa&logoColor=white" alt="PWA" />
</p>

<p align="center">
  <a href="https://launch.j2team.dev/products/termote?utm_source=badge-launched&utm_medium=badge&utm_campaign=badge-termote" target="_blank" rel="noopener noreferrer"><img src="https://launch.j2team.dev/badge/termote/dark" alt="Termote - Launched on J2TEAM Launch" width="170" height="36" loading="lazy" /></a>
  &nbsp;
  <a href="https://unikorn.vn/p/termote?ref=embed-termote" target="_blank"><img src="https://unikorn.vn/api/widgets/badge/termote?theme=dark" alt="Termote trên Unikorn.vn" width="170" height="42" /></a>
</p>

Remote control CLI tools (Claude Code, GitHub Copilot, any terminal) from mobile/desktop via PWA.

> **Termote** = Terminal + Remote
>
> 🇻🇳 [Tiếng Việt](README.vi.md) | 🇨🇳 [简体中文](README.zh-CN.md) | 🇯🇵 [日本語](README.ja.md) | 🇰🇷 [한국어](README.ko.md) | 🇪🇸 [Español](README.es.md) | 🇧🇷 [Português (BR)](README.pt-BR.md) | 🇫🇷 [Français](README.fr.md) | 🇩🇪 [Deutsch](README.de.md) | 🇷🇺 [Русский](README.ru.md) | 🇮🇩 [Bahasa Indonesia](README.id.md)

## Features

- **Session switching**: Multiple tmux sessions with create/edit/delete
- **Session tabs**: Horizontal tab bar for quick window switching
- **Herdr backend** (native only): drive Herdr workspaces instead of tmux, with per-pane coding-agent status badges — see [Native Installation](https://termote.ohnice.app/installation/native/)
- **Mobile-friendly**: Virtual keyboard toolbar (Tab/Ctrl/Shift/arrows, expandable)
- **Gesture support**: Swipe for Ctrl+C, Tab, history navigation
- **Command history**: Recall previously sent commands with search
- **Quick actions**: Floating menu for common operations (clear, cancel, exit)
- **Connection indicator**: Real-time server status with auto-detect disconnect
- **Update checker**: Automatic new version notification from GitHub releases
- **PWA**: Installable to homescreen, offline-capable
- **Persistent sessions**: tmux keeps sessions alive
- **Collapsible sidebar**: Desktop UI with toggleable session sidebar
- **Fullscreen mode**: Immersive terminal experience
- **Config persistence**: Auto-save installation settings with AES-256 encrypted password

## Screenshots

<p align="center">
  <img src="docs/images/screenshots/mobile-terminal.png" alt="Mobile Terminal" width="280" />
  &nbsp;&nbsp;
  <img src="docs/images/screenshots/mobile-sidebar.png" alt="Session Sidebar" width="280" />
</p>

## Architecture

```mermaid
flowchart TB
    subgraph Client["Client (Mobile/Desktop)"]
        PWA["PWA - React + xterm.js"]
        Gestures["Gesture Controls"]
        Keyboard["Virtual Keyboard"]
    end

    subgraph Server["tmux-api Server :7680"]
        Static["Static Files"]
        Stream["Terminal WebSocket /api/mux/stream"]
        API["REST API /api/mux/*"]
        Guard["Host allowlist + Origin/CSRF guard"]
        Auth["Basic Auth"]
    end

    subgraph Backend["Mux Backend (tmux/psmux or Herdr)"]
        Mux["Mux interface"]
        tmux["tmux/psmux (PTY)"]
        herdr["Herdr (native only)"]
        Shell["Shell"]
        Tools["CLI Tools"]
    end

    Gestures --> PWA
    Keyboard --> PWA
    PWA --> Static
    PWA <--> Stream
    PWA --> API
    Guard -.-> Static & Stream & API
    Auth -.-> Static & Stream & API
    Stream --> Mux
    API --> Mux
    Mux --> tmux & herdr
    tmux --> Shell --> Tools
```

tmux-api streams the terminal itself (PTY on Unix, ConPTY on Windows) into xterm.js in the PWA; there is no separate terminal process to proxy to. See [`docs/system-architecture.md`](docs/system-architecture.md) for the full request-guard model.

## Quick Start

> 📖 **New to Termote?** Check out the [Getting Started Guide](docs/getting-started.md) for a complete walkthrough with examples.

```bash
./scripts/termote.sh                   # Interactive menu
./scripts/termote.sh install container # Container mode (docker/podman)
./scripts/termote.sh install native    # Native mode (host tools)
./scripts/termote.sh link              # Create 'termote' global command
make test                              # Run tests
```

> After `link`, use `termote` from anywhere: `termote health`, `termote install native --lan`

## Installation

### One-liner (recommended)

**macOS/Linux:**

```bash
# Download and prompt before install (defaults to native mode)
curl -fsSL https://raw.githubusercontent.com/lamngockhuong/termote/main/scripts/get.sh | bash

# Auto-install without prompt
curl -fsSL .../get.sh | bash -s -- --yes

# Download only (no install)
curl -fsSL .../get.sh | bash -s -- --download-only

# Auto-update with saved config
curl -fsSL .../get.sh | bash -s -- --update

# Install specific version
curl -fsSL .../get.sh | bash -s -- --version 0.0.4

# With explicit mode and options
curl -fsSL .../get.sh | bash -s -- --yes --container --lan
curl -fsSL .../get.sh | bash -s -- --yes --native --tailscale myhost

# Force new password (ignore saved config)
curl -fsSL .../get.sh | bash -s -- --yes --container --fresh
```

**Windows (PowerShell):**

> **Note:** If script execution is disabled on your system, run this first:
>
> ```powershell
> Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
> ```

```powershell
# Download and prompt before install (defaults to native mode)
irm https://raw.githubusercontent.com/lamngockhuong/termote/main/scripts/get.ps1 | iex

# Auto-install without prompt
$env:TERMOTE_AUTO_YES = "true"; irm .../get.ps1 | iex

# With explicit mode
$env:TERMOTE_MODE = "container"; irm .../get.ps1 | iex

# Auto-update with saved config
$env:TERMOTE_UPDATE = "true"; irm .../get.ps1 | iex
```

### Docker

```bash
# All-in-one (auto-generates credentials, check logs: docker logs termote)
docker run -d --name termote -p 7680:7680 ghcr.io/lamngockhuong/termote:latest

# With custom credentials
docker run -d --name termote -p 7680:7680 \
  -e TERMOTE_USER=admin -e TERMOTE_PASS=secret \
  ghcr.io/lamngockhuong/termote:latest

# Without auth (local dev only)
docker run -d --name termote -p 7680:7680 \
  -e NO_AUTH=true \
  ghcr.io/lamngockhuong/termote:latest

# With volume for persistence
docker run -d --name termote -p 7680:7680 \
  -v termote-data:/home/termote \
  ghcr.io/lamngockhuong/termote:latest

# Mount custom workspace directory
docker run -d --name termote -p 7680:7680 \
  -v ~/projects:/workspace \
  ghcr.io/lamngockhuong/termote:latest

# With Tailscale HTTPS (requires Tailscale on host)
docker run -d --name termote -p 7680:7680 \
  -e TERMOTE_USER=admin -e TERMOTE_PASS=secret \
  ghcr.io/lamngockhuong/termote:latest
sudo tailscale serve --bg --https=443 http://127.0.0.1:7680
# Access at: https://your-hostname.tailnet-name.ts.net
```

### From Release

```bash
# Download latest release
VERSION=$(curl -s https://api.github.com/repos/lamngockhuong/termote/releases/latest | grep tag_name | cut -d '"' -f4)
wget https://github.com/lamngockhuong/termote/releases/download/${VERSION}/termote-${VERSION}.tar.gz
tar xzf termote-${VERSION}.tar.gz
cd termote-${VERSION#v}

# Install (interactive menu or with mode)
./scripts/termote.sh install
./scripts/termote.sh install container
```

### From Source

```bash
git clone https://github.com/lamngockhuong/termote.git
cd termote
./scripts/termote.sh install container
```

> **Note**: `termote.sh` is the unified CLI supporting `install` (builds from source, uses pre-built artifacts when available), `uninstall`, and `health` commands.

## Deployment Modes

```mermaid
flowchart LR
    subgraph Container["Container Mode"]
        direction TB
        C1["Docker/Podman"] --> C2["tmux-api :7680 (streams terminal itself)"] --> C3["tmux"]
    end

    subgraph Native["Native Mode"]
        direction TB
        N1["Host System"] --> N2["tmux-api :7680 (streams terminal itself)"] --> N3["tmux/psmux or Herdr + Host Tools"]
    end

    User["User"] --> Container & Native
```

| Mode          | Description    | Use Case                                                      | Platform              |
| ------------- | -------------- | ------------------------------------------------------------- | --------------------- |
| `--container` | Container mode | Simple deployment, isolated env                               | macOS, Linux, Windows |
| `--native`    | All native     | Host tool access (claude, gh); required for the Herdr backend | macOS, Linux, Windows |

### Options

| Flag                        | Description                                                                    |
| --------------------------- | ------------------------------------------------------------------------------ |
| `--lan`                     | Expose to LAN (default: localhost only)                                        |
| `--tailscale <host[:port]>` | Enable Tailscale HTTPS                                                         |
| `--no-auth`                 | Disable basic authentication                                                   |
| `--port <port>`             | Host port (default: 7680, Windows: 7690)                                       |
| `--mux <tmux\|herdr>`       | Terminal backend, native only (default: `tmux`)                                |
| `--allow-host <name>`       | Allow an extra Host header value (repeatable; no wildcard, see security notes) |
| `--allow-herdr-no-auth`     | Required together with `--mux herdr --no-auth`                                 |
| `--fresh`                   | Force new password prompt (ignore saved config)                                |
| `--update`                  | Auto-update with saved config                                                  |
| `--version <ver>`           | Install specific version (with or without `v`)                                 |

`--ttyd`/`-Ttyd` is still accepted (0.x relies on it when it relaunches the installer during an update) but is ignored with a warning: ttyd was removed in 1.0.0. See [`docs/upgrade-1.0.md`](docs/upgrade-1.0.md) for every breaking change.

| Environment Variable | Description                                      |
| -------------------- | ------------------------------------------------ |
| `WORKSPACE`          | Host directory to mount (default: `./workspace`) |
| `TERMOTE_USER`       | Basic auth username (default: auto-generated)    |
| `TERMOTE_PASS`       | Basic auth password (default: auto-generated)    |
| `NO_AUTH`            | Set to `true` to disable authentication          |

### Container Mode (recommended for simplicity)

Scripts auto-detect `podman` or `docker` — both work identically.

```bash
./scripts/termote.sh install container             # localhost with basic auth
./scripts/termote.sh install container --no-auth   # localhost without auth
./scripts/termote.sh install container --lan       # LAN accessible
# Access: http://localhost:7680

# Custom workspace directory (mounted to /workspace in container)
WORKSPACE=~/projects ./scripts/termote.sh install container
WORKSPACE=/path/to/code make install-container
```

> **Security note**: Avoid mounting `$HOME` directly — sensitive directories like `.ssh`, `.gnupg` will be accessible in container. Mount specific project directories instead.

### Native (recommended for host binary access)

Use when you need access to host binaries (claude, git, etc):

```bash
# Linux
sudo apt install tmux
./scripts/termote.sh install native

# macOS
brew install tmux go
./scripts/termote.sh install native
# Access: http://localhost:7680
```

To drive [Herdr](https://termote.ohnice.app/installation/native/) workspaces instead of tmux, add `--mux herdr` (native mode only; `herdr` must already be on `PATH`).

### With Tailscale HTTPS (all modes)

Uses `tailscale serve` for automatic HTTPS (no manual cert management):

```bash
# Tailscale only (default port 443)
./scripts/termote.sh install container --tailscale myhost.ts.net

# Custom port
./scripts/termote.sh install native --tailscale myhost.ts.net:8765

# Tailscale + LAN accessible
./scripts/termote.sh install container --tailscale myhost.ts.net --lan

# Access: https://myhost.ts.net (or :8765 for custom port)
```

### Uninstall

```bash
./scripts/termote.sh uninstall container   # Container mode
./scripts/termote.sh uninstall native      # Native mode
./scripts/termote.sh uninstall all         # Everything
```

### Updating

```bash
# Option 1: Auto-update with saved config
curl -fsSL .../get.sh | bash -s -- --update

# Option 2: Re-run one-liner (compares versions, prompts before install)
curl -fsSL .../get.sh | bash

# Option 3: Manual update
./scripts/termote.sh uninstall [container|native]
git pull origin main                    # If installed from source
./scripts/termote.sh install [container|native] [--lan] [--tailscale ...]
```

## Platform Support

| Platform | Container | Native | CLI Script  |
| -------- | --------- | ------ | ----------- |
| Linux    | ✓         | ✓      | termote.sh  |
| macOS    | ✓         | ✓      | termote.sh  |
| Windows  | ✓         | ✓      | termote.ps1 |

> **Windows Support**: Container mode requires Docker Desktop or Podman Desktop; native mode requires psmux. Report any issues on GitHub.

### Windows Native Mode

Windows native mode uses [psmux](https://github.com/psmux/psmux) (tmux-compatible terminal multiplexer for Windows):

```powershell
# Install psmux
winget install psmux

# Run Termote
.\scripts\termote.ps1 install native
.\scripts\termote.ps1 install container  # Or container mode with Docker Desktop

# Update & logs
.\scripts\termote.ps1 update             # Self-update to latest release
.\scripts\termote.ps1 logs follow        # Tail all logs live
```

## Mobile Usage

| Action           | Gesture             |
| ---------------- | ------------------- |
| Cancel/interrupt | Swipe left (Ctrl+C) |
| Tab completion   | Swipe right         |
| History up       | Swipe up            |
| History down     | Swipe down          |
| Paste            | Long press          |
| Font size        | Pinch in/out        |

Virtual toolbar provides: Tab, Esc, Ctrl, Shift, Arrow keys, and common key combos. Supports Ctrl+Shift combinations (paste, copy). Toggle between minimal and expanded mode for additional keys (Home, End, Delete, etc.).

## Project Structure

```
termote/
├── Makefile                # Build/test/deploy commands
├── Dockerfile              # Docker mode (tmux-api + tmux, no ttyd)
├── docker-compose.yml
├── entrypoint.sh           # Docker entrypoint
├── docs/                   # Documentation
│   └── images/screenshots/ # App screenshots
├── pwa/                    # React PWA
│   └── src/
│       ├── components/
│       ├── contexts/
│       ├── hooks/
│       ├── types/
│       └── utils/
├── tmux-api/               # Go server + CLI (single binary)
│   ├── main.go             # Entry point (no args/`serve` = server, else CLI)
│   ├── serve.go            # Server (PWA, auth, guards)
│   ├── mux.go              # Mux interface + /api/mux/* routes
│   ├── mux_tmux.go         # tmux/psmux backend
│   ├── mux_herdr.go        # Herdr backend (native only)
│   ├── stream.go           # Terminal WebSocket (xterm.js stream)
│   └── cli*.go             # install/update/health/logs/link/menu subcommands
├── scripts/
│   ├── termote.sh          # Thin Unix shim -> tmux-api CLI
│   ├── termote.ps1         # Thin Windows PowerShell shim -> tmux-api CLI
│   ├── get.sh              # Unix online installer (curl | bash)
│   └── get.ps1             # Windows online installer (irm | iex)
├── tests/                  # Test suite
│   ├── test-termote.sh
│   ├── test-termote.ps1    # Windows tests
│   ├── test-get.sh
│   └── test-entrypoints.sh
└── website/                # Astro Starlight docs site
    └── src/content/docs/   # MDX documentation
```

## Development

```bash
make build          # Build PWA and tmux-api
make test           # Run all tests
make health         # Check service health
make clean          # Stop containers

# E2E tests (requires running server)
./scripts/termote.sh install container  # Start server first
pnpm --filter termote test:e2e       # Run Playwright tests
pnpm --filter termote test:e2e:ui    # Run with UI debugger
```

**Manual Testing:** See [Self-Test Checklist](docs/self-test-checklist.md)

## Troubleshooting

### Session not persisting

- Check tmux: `tmux ls`
- tmux-api attaches with `tmux new-session -A` (attach-or-create)

### WebSocket errors

- Check tmux-api logs: `docker logs termote` (container) or `termote logs tmux-api` (native)
- The terminal WebSocket is `/api/mux/stream`, served by tmux-api itself — there is no separate terminal process to check

### Mobile keyboard issues

- Ensure viewport meta tag is present
- Test on real device, not emulator

### Native mode: process not starting

```bash
ps aux | grep tmux-api     # Check if tmux-api is running
lsof -i :7680              # Verify port is in use
termote logs tmux-api      # Or: termote logs follow
```

## Security Notes

- **Default: localhost only** - not exposed to LAN unless `--lan` flag used
- **Basic auth enabled by default** - use `--no-auth` to disable for local dev; an empty saved password no longer disables auth (1.0.0 generates a new one instead)
- **Host allowlist**: requests with an unrecognised `Host` header are rejected (DNS-rebinding protection); add trusted names with `--allow-host`/`-AllowHost`, there is no wildcard to turn the check off
- **Origin/CSRF guards**: state-changing `/api/mux/*` requests and the `/api/mux/stream` WebSocket reject cross-site `Sec-Fetch-Site`/`Origin` and require a same-origin, single-use stream token
- **Built-in brute-force protection** - rate limiting (5 attempts/min per IP)
- **Herdr backend**: exposes every Herdr workspace on the host, so `--mux herdr --no-auth` is refused unless `--allow-herdr-no-auth` is also given
- Use HTTPS (Tailscale) for production
- Restrict to trusted networks/VPN

See [`docs/upgrade-1.0.md`](docs/upgrade-1.0.md) if you are upgrading from a 0.x install.

## Other Projects

| Project                                                     | Description                                                                                                        |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| [GitHub Flex](https://github.com/lamngockhuong/github-flex) | A cross-browser extension (Chrome & Firefox) that enhances GitHub's interface with productivity features           |
| [TabRest](https://github.com/lamngockhuong/tabrest)         | Chrome extension that automatically unloads inactive tabs to free memory                                           |
| [Specpin](https://github.com/lamngockhuong/specpin)         | Pin living, Git-versioned business specs onto the elements of your running web UI (browser extension + Go sidecar) |

## License

MIT
