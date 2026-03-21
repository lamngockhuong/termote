# CLAUDE.md

Instructions for Claude Code when working with this repository.

## Project Overview

**Termote** = Terminal + Remote

A PWA for remotely controlling CLI tools (Claude Code, GitHub Copilot, any terminal) from mobile/desktop.

## Tech Stack

| Layer           | Technology                                 |
| --------------- | ------------------------------------------ |
| Frontend        | React 18 + TypeScript + Vite + TailwindCSS |
| PWA             | vite-plugin-pwa + Workbox                  |
| Terminal        | ttyd (WebSocket terminal)                  |
| Proxy           | nginx (reverse proxy + basic auth)         |
| Sessions        | tmux (persistent sessions)                 |
| API             | Go (tmux-api)                              |
| Package Manager | pnpm                                       |

## Project Structure

```
termote/
├── Dockerfile              # All-in-one (nginx+ttyd+tmux-api)
├── Dockerfile.hybrid       # Hybrid (nginx+tmux-api)
├── docker-compose.yml
├── pwa/                    # React PWA frontend
│   ├── src/
│   │   ├── components/     # React components
│   │   ├── hooks/          # Custom React hooks
│   │   ├── types/          # TypeScript types
│   │   └── utils/          # Utility functions
│   ├── package.json
│   └── vite.config.ts
├── nginx/                  # Nginx configurations
│   ├── nginx-docker.conf   # For docker mode
│   ├── nginx-hybrid.conf   # For hybrid mode
│   └── nginx-local.conf    # For native mode
├── tmux-api/               # Go API server
│   └── main.go
├── scripts/                # Shell scripts
│   ├── deploy.sh
│   ├── uninstall.sh
│   └── health-check.sh
├── tests/                  # Test suite
│   ├── test-deploy.sh
│   └── test-uninstall.sh
├── systemd/                # Systemd service files
└── Makefile                # Build/test/deploy commands
```

## Deployment Modes

| Mode       | Description                                             | Use Case                   | Platform     |
| ---------- | ------------------------------------------------------- | -------------------------- | ------------ |
| `--docker` | All-in-one container                                    | Simple deployment          | macOS, Linux |
| `--hybrid` | Container + ttyd (Linux) or Native serve (macOS+podman) | Access host binaries       | macOS, Linux |
| `--native` | All native (auto-detects OS)                            | No Docker/Podman available | macOS, Linux |

```bash
./scripts/deploy.sh --docker                    # localhost only (with basic auth)
./scripts/deploy.sh --docker --no-auth          # localhost without auth
./scripts/deploy.sh --docker --lan              # LAN accessible
./scripts/deploy.sh --docker --tailscale host   # Tailscale HTTPS
./scripts/deploy.sh --docker --tailscale host --lan  # Both
```

## Development Commands

```bash
# Using Makefile (recommended)
make build          # Build PWA + tmux-api
make test           # Run all tests (24 tests)
make deploy-docker  # Deploy docker mode
make health         # Check services

# Manual commands
cd pwa && pnpm install && pnpm dev     # Dev server
cd pwa && pnpm tsc --noEmit            # Type check
cd tmux-api && go build -o tmux-api .  # Build API (native binary)
```

### Cross-Compilation (macOS for Linux Container)

When building Docker images on macOS, tmux-api is cross-compiled to Linux:

```bash
# Automatic (deploy.sh handles this)
cd tmux-api && GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o tmux-api .

# For ARM64 (Apple Silicon):
cd tmux-api && GOOS=linux GOARCH=arm64 go build -ldflags="-s -w" -o tmux-api .
```

API-only vs. Serve Mode:

```bash
# API-only (backward compatible, port 7682)
./tmux-api

# Full serve mode (port 7680, PWA + proxy + auth)
TERMOTE_SERVE=true ./tmux-api --serve
# Or: ./tmux-api --serve
```

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│ Docker mode (all-in-one)                                │
│   nginx:7680 → ttyd:7681 → tmux                         │
│             → tmux-api:7682                             │
│   Container Runtime: auto-detect podman or docker       │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│ Hybrid mode - Linux                                     │
│   [Container] nginx:7680 → host.docker.internal:7681    │
│               tmux-api:7682 → host tmux socket          │
│   [Native]    ttyd:7681 → tmux                          │
│   Container Runtime: auto-detect podman or docker       │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│ Hybrid mode - macOS                                     │
│   tmux-api --serve:7680 (built-in proxy)                │
│   ├→ static PWA files                                   │
│   ├→ WebSocket proxy to ttyd:7681                       │
│   └→ tmux API endpoints                                 │
│   [Native]    ttyd:7681 → tmux                          │
│   Auto-native on podman, fully native (no container)    │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│ Native mode - Linux                                     │
│   nginx:7680 → ttyd:7681 → tmux                         │
│             → tmux-api:7682                             │
│   Requires systemd                                       │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│ Native mode - macOS                                     │
│   tmux-api --serve:7680 (built-in proxy)                │
│   ├→ static PWA files                                   │
│   ├→ WebSocket proxy to ttyd:7681                       │
│   └→ tmux API endpoints                                 │
│   [Native]    ttyd:7681 → tmux                          │
│   No container, no systemd needed                        │
└─────────────────────────────────────────────────────────┘
```

## Code Conventions

- **File naming**: kebab-case for all files (e.g., `keyboard-toolbar.tsx`)
- **Components**: Function components with TypeScript
- **Hooks**: Prefix with `use-` (e.g., `use-session.ts`)
- **State**: React hooks (useState, useCallback, useMemo)
- **Styling**: TailwindCSS utility classes

### Shell Scripts (Cross-Platform)

- Use `grep -oE` (extended regex) instead of `grep -oP` (Perl regex, Linux-only)
- Use `ipconfig getifaddr en0` fallback for `hostname -I` on macOS
- Wrap `systemctl` calls with `command -v systemctl` checks (macOS has no systemd)
- Use `$(uname)` to detect Darwin (macOS) vs Linux
- Use `$(uname -m)` for architecture detection (x86_64, aarch64)

## Key Files

| File                                      | Purpose                                   |
| ----------------------------------------- | ----------------------------------------- |
| `pwa/src/App.tsx`                         | Main app with gestures, toolbar, sessions |
| `pwa/src/components/keyboard-toolbar.tsx` | Virtual keyboard for mobile               |
| `pwa/src/hooks/use-gestures.ts`           | Hammer.js gesture handling                |
| `tmux-api/main.go`                        | Entry point (API-only or serve mode)      |
| `tmux-api/tmux.go`                        | tmux window handlers (shared)             |
| `tmux-api/serve.go`                       | Full server mode (PWA, proxy, auth)       |
| `Dockerfile`                              | All-in-one container                      |
| `Dockerfile.hybrid`                       | Hybrid mode container (nginx + api)       |
| `nginx/nginx-docker.conf`                 | Reverse proxy for docker mode             |
| `nginx/nginx-hybrid.conf`                 | Reverse proxy for hybrid mode             |

## Container Runtime Support

Scripts auto-detect container runtime in this priority:

1. **podman** (preferred, lighter-weight)
2. **docker** (fallback)

Both Docker Desktop and Podman work on all platforms (macOS, Linux).

### macOS + Podman Special Behavior

When podman is detected on macOS with hybrid mode:

### macOS + Podman Special Behavior

When podman is detected on macOS with hybrid mode:

- Automatically switches to fully native deployment (no container)
- tmux-api runs in `--serve` mode (replaces nginx)
- ttyd runs natively
- Provides native access to system binaries and development tools

## Security Notes

- Basic auth enabled by default (use `--no-auth` to disable for local dev)
- Basic auth over HTTPS required for production
- Same-origin iframe setup via nginx proxy or tmux-api serve proxy
- PostMessage uses explicit origin (not wildcard)
- Exclude sensitive dirs (.ssh, .gnupg) from volume mounts
- Serve mode uses constant-time comparison for password verification

## Testing

```bash
make test             # Run all tests (24 tests)
make test-deploy      # Test deploy.sh only
make test-uninstall   # Test uninstall.sh only

# Manual checks
cd pwa && pnpm tsc --noEmit   # Type check
curl http://localhost:7682/windows  # Test tmux-api

# E2E tests (requires running server)
./scripts/deploy.sh --docker  # Start server first
cd pwa && pnpm test:e2e       # Run Playwright tests
cd pwa && pnpm test:e2e:ui    # Run with UI debugger
```
