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
└── systemd/                # Systemd service files
```

## Deployment Modes

| Mode       | Description          | Use Case             |
| ---------- | -------------------- | -------------------- |
| `--docker` | All-in-one container | Simple deployment    |
| `--hybrid` | Docker + native ttyd | Access host binaries |
| `--native` | All native           | No Docker            |

```bash
./scripts/deploy.sh --docker              # All-in-one
./scripts/deploy.sh --hybrid              # Docker + native ttyd
./scripts/deploy.sh --native              # All native
./scripts/deploy.sh --docker --tailscale myhost.ts.net  # With HTTPS
```

## Development Commands

```bash
# Install dependencies
cd pwa && pnpm install

# Development server
pnpm dev

# Type check
pnpm tsc --noEmit

# Build for production
pnpm build

# Build tmux-api
cd tmux-api && CGO_ENABLED=0 go build -ldflags="-s -w" -o tmux-api .
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
# Type check
cd pwa && pnpm tsc --noEmit

# Build verification
pnpm build

# Test tmux-api
curl http://localhost:7682/windows
```
