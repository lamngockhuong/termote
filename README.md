<p align="center">
  <img src="pwa/public/banner-readme.svg" alt="Termote" width="600" />
</p>

Remote control CLI tools (Claude Code, GitHub Copilot, any terminal) from mobile/desktop via PWA.

> **Termote** = Terminal + Remote

## Features

- **Session switching**: Claude, Copilot, Shell terminals
- **Mobile-friendly**: Virtual keyboard toolbar (Tab/Ctrl/Esc/arrows)
- **Gesture support**: Swipe for Ctrl+C, Tab, history navigation
- **PWA**: Installable to homescreen, offline-capable
- **Persistent sessions**: tmux keeps sessions alive

## Quick Start

```bash
make deploy-docker    # All-in-one container
make test             # Run tests
make health           # Check services
```

## Installation

### One-liner (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/lamngockhuong/termote/main/scripts/get.sh | bash
```

With options:

```bash
curl -fsSL .../get.sh | bash -s -- --docker --lan
curl -fsSL .../get.sh | bash -s -- --hybrid
```

### Docker

```bash
# All-in-one (simplest)
docker run -d --name termote -p 7680:7680 ghcr.io/lamngockhuong/termote:latest

# With volume for persistence
docker run -d --name termote \
  -p 7680:7680 \
  -v termote-data:/home/termote \
  ghcr.io/lamngockhuong/termote:latest
```

### From Release

```bash
# Download latest release
VERSION=$(curl -s https://api.github.com/repos/lamngockhuong/termote/releases/latest | grep tag_name | cut -d '"' -f4)
wget https://github.com/lamngockhuong/termote/releases/download/${VERSION}/termote-${VERSION}.tar.gz
tar xzf termote-${VERSION}.tar.gz
cd termote-${VERSION#v}

# Install
./scripts/install.sh --docker
```

### From Source

```bash
git clone https://github.com/lamngockhuong/termote.git
cd termote
make deploy-docker
```

## Deployment Modes

| Mode       | Description          | Containers              | Native |
| ---------- | -------------------- | ----------------------- | ------ |
| `--docker` | All-in-one container | 1 (nginx+ttyd+tmux-api) | -      |
| `--hybrid` | Docker + native ttyd | 1 (nginx+tmux-api)      | ttyd   |
| `--native` | All native           | -                       | all    |

### Options

| Flag                        | Description                             |
| --------------------------- | --------------------------------------- |
| `--lan`                     | Expose to LAN (default: localhost only) |
| `--tailscale <host[:port]>` | Enable Tailscale HTTPS                  |
| `--no-auth`                 | Disable basic authentication            |
| `--port <port>`             | Host port (default: 7680)               |

### Docker (recommended for simplicity)

```bash
./scripts/deploy.sh --docker             # localhost with basic auth
./scripts/deploy.sh --docker --no-auth   # localhost without auth
./scripts/deploy.sh --docker --lan       # LAN accessible
# Access: http://localhost:7680
```

### Hybrid (recommended for host binary access)

Use when you need ttyd to access host binaries (claude, git, etc):

```bash
# Install ttyd first
sudo apt install ttyd tmux  # Ubuntu/Debian
# Or: brew install ttyd tmux  # macOS

./scripts/deploy.sh --hybrid
# Access: http://localhost:7680
```

### Native (no Docker)

```bash
sudo apt install ttyd tmux nginx
./scripts/deploy.sh --native
# Access: http://localhost:7680
```

### With Tailscale HTTPS (all modes)

Uses `tailscale serve` for automatic HTTPS (no manual cert management):

```bash
# Tailscale only (default port 443)
./scripts/deploy.sh --docker --tailscale myhost.ts.net

# Custom port
./scripts/deploy.sh --hybrid --tailscale myhost.ts.net:8765

# Tailscale + LAN accessible
./scripts/deploy.sh --docker --tailscale myhost.ts.net --lan

# Access: https://myhost.ts.net (or :8765 for custom port)
```

### Uninstall

```bash
./scripts/uninstall.sh --docker   # Docker mode
./scripts/uninstall.sh --hybrid   # Hybrid mode
./scripts/uninstall.sh --native   # Native mode
./scripts/uninstall.sh --all      # Everything
```

## Platform Support

| Platform | Docker   | Hybrid | Native |
| -------- | -------- | ------ | ------ |
| Linux    | ✓        | ✓      | ✓      |
| macOS    | ✓        | ✓      | ✓      |
| Windows  | ✓ (WSL2) | -      | -      |

## Mobile Usage

| Action           | Gesture             |
| ---------------- | ------------------- |
| Cancel/interrupt | Swipe left (Ctrl+C) |
| Tab completion   | Swipe right         |
| History up       | Swipe up            |
| History down     | Swipe down          |
| Paste            | Long press          |
| Font size        | Pinch in/out        |

Virtual toolbar provides: Tab, Esc, Ctrl, Arrow keys, and common Ctrl combos.

## Project Structure

```
termote/
├── Makefile                # Build/test/deploy commands
├── Dockerfile              # All-in-one (nginx+ttyd+tmux-api)
├── Dockerfile.hybrid       # Hybrid (nginx+tmux-api)
├── docker-compose.yml
├── nginx/
│   ├── nginx-docker.conf   # For docker mode
│   ├── nginx-hybrid.conf   # For hybrid mode
│   └── nginx-local.conf    # For native mode
├── pwa/                    # React PWA
│   └── src/
│       ├── components/
│       ├── hooks/
│       └── utils/
├── tmux-api/               # Go API server
│   └── main.go
├── scripts/
│   ├── deploy.sh
│   ├── uninstall.sh
│   └── health-check.sh
├── tests/                  # Test suite
│   ├── test-deploy.sh
│   └── test-uninstall.sh
└── systemd/
    ├── termote.service
    └── tmux-api.service
```

## Development

```bash
make build          # Build PWA and tmux-api
make test           # Run all tests (24 tests)
make health         # Check service health
make clean          # Stop containers

# E2E tests (requires running server)
./scripts/deploy.sh --docker  # Start server first
cd pwa && pnpm test:e2e       # Run Playwright tests
cd pwa && pnpm test:e2e:ui    # Run with UI debugger
```

## Troubleshooting

### Session not persisting

- Check tmux: `tmux ls`
- Verify ttyd uses `-A` flag (attach-or-create)

### WebSocket errors

- Check nginx `proxy_read_timeout`
- Verify WebSocket upgrade headers

### Mobile keyboard issues

- Ensure viewport meta tag is present
- Test on real device, not emulator

### Hybrid mode: tmux-api can't find session

- Verify tmux socket: `ls -la /tmp/tmux-$(id -u)/`
- Check TMUX_SOCKET env in container

## Security Notes

- **Default: localhost only** - not exposed to LAN unless `--lan` flag used
- **Basic auth enabled by default** - use `--no-auth` to disable for local dev
- Use HTTPS (Tailscale) for production
- Consider fail2ban for brute-force protection
- Restrict to trusted networks/VPN

## License

MIT
