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
│   ├── nginx-local.conf    # For native mode
│   └── nginx-tailscale.conf
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

| Mode       | Description          | Use Case             |
| ---------- | -------------------- | -------------------- |
| `--docker` | All-in-one container | Simple deployment    |
| `--hybrid` | Docker + native ttyd | Access host binaries |
| `--native` | All native           | No Docker            |

```bash
./scripts/deploy.sh --docker                    # localhost only
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
cd tmux-api && go build -o tmux-api .  # Build API
```

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│ Docker mode (all-in-one)                                │
│   nginx:8080 → ttyd:7681 → tmux                         │
│             → tmux-api:7682                             │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│ Hybrid mode                                             │
│   [Container] nginx:8080 → host.docker.internal:7681    │
│               tmux-api:7682 → host tmux socket          │
│   [Native]    ttyd:7681 → tmux                          │
└─────────────────────────────────────────────────────────┘
```

## Code Conventions

- **File naming**: kebab-case for all files (e.g., `keyboard-toolbar.tsx`)
- **Components**: Function components with TypeScript
- **Hooks**: Prefix with `use-` (e.g., `use-session.ts`)
- **State**: React hooks (useState, useCallback, useMemo)
- **Styling**: TailwindCSS utility classes

## Key Files

| File                                      | Purpose                                   |
| ----------------------------------------- | ----------------------------------------- |
| `pwa/src/App.tsx`                         | Main app with gestures, toolbar, sessions |
| `pwa/src/components/keyboard-toolbar.tsx` | Virtual keyboard for mobile               |
| `pwa/src/hooks/use-gestures.ts`           | Hammer.js gesture handling                |
| `tmux-api/main.go`                        | tmux REST API (Go)                        |
| `Dockerfile`                              | All-in-one container                      |
| `Dockerfile.hybrid`                       | Hybrid mode container                     |

## Security Notes

- Basic auth over HTTPS required for production
- Same-origin iframe setup via nginx proxy
- PostMessage uses explicit origin (not wildcard)
- Exclude sensitive dirs (.ssh, .gnupg) from volume mounts

## Testing

```bash
make test             # Run all tests (24 tests)
make test-deploy      # Test deploy.sh only
make test-uninstall   # Test uninstall.sh only

# Manual checks
cd pwa && pnpm tsc --noEmit   # Type check
curl http://localhost:7682/windows  # Test tmux-api
```
