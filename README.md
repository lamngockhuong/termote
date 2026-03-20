# Termote

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

### Docker (recommended for simplicity)

```bash
./scripts/deploy.sh --docker           # localhost only
./scripts/deploy.sh --docker --lan     # LAN accessible
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

```bash
# Tailscale only (private network)
./scripts/deploy.sh --docker --tailscale myhost.ts.net

# Tailscale + LAN accessible
./scripts/deploy.sh --docker --tailscale myhost.ts.net --lan

# Custom port
./scripts/deploy.sh --hybrid --tailscale myhost.ts.net:443

# Access: https://myhost.ts.net:7680 (or custom port)
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
│   ├── nginx-local.conf    # For native mode
│   └── nginx-tailscale.conf
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
- Basic auth over HTTPS (or Tailscale)
- Consider fail2ban for brute-force protection
- Restrict to trusted networks/VPN

## License

MIT
