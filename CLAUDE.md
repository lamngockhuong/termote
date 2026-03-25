# CLAUDE.md

Instructions for Claude Code when working with this repository.

## Project Overview

**Termote** = Terminal + Remote

A PWA for remotely controlling CLI tools (Claude Code, GitHub Copilot, any terminal) from mobile/desktop.

## Tech Stack

| Layer           | Technology                                 |
| --------------- | ------------------------------------------ |
| Frontend        | React 19 + TypeScript + Vite + TailwindCSS |
| PWA             | vite-plugin-pwa + Workbox                  |
| Terminal        | ttyd (WebSocket terminal)                  |
| Server          | Go (tmux-api serve mode)                   |
| Sessions        | tmux (persistent sessions)                 |
| Package Manager | pnpm                                       |

## Project Structure

```
termote/
├── Dockerfile              # Docker mode (tmux-api + ttyd)
├── docker-compose.yml
├── pwa/                    # React PWA frontend
│   ├── src/
│   │   ├── components/     # React components
│   │   ├── hooks/          # Custom React hooks
│   │   ├── types/          # TypeScript types
│   │   └── utils/          # Utility functions
│   ├── package.json
│   └── vite.config.ts
├── tmux-api/               # Go server (PWA + proxy + API)
│   ├── main.go             # Entry point
│   ├── serve.go            # Server (static files, proxy, auth)
│   └── tmux.go             # tmux API handlers
├── scripts/                # Shell scripts
│   ├── termote.sh          # Unified CLI (install/uninstall/health)
│   └── get.sh              # Online installer (curl-able)
├── tests/                  # Test suite
│   ├── test-termote.sh     # CLI tests
│   ├── test-get.sh         # Online installer tests
│   └── test-entrypoints.sh # Docker entrypoint tests
├── website/                # Documentation site (Astro Starlight)
│   └── src/content/docs/   # MDX docs (EN + VI)
└── Makefile                # Build/test/deploy commands
```

## Deployment Modes

| Mode          | Description               | Use Case                        | Platform     |
| ------------- | ------------------------- | ------------------------------- | ------------ |
| `--container` | Container mode            | Simple deployment, isolated env | macOS, Linux |
| `--native`    | All native (no container) | Host tool access (Claude Code)  | macOS, Linux |

```bash
./scripts/termote.sh                                   # Interactive menu
./scripts/termote.sh install container                 # Container mode (saves config)
./scripts/termote.sh install container --lan           # LAN accessible
./scripts/termote.sh install native                    # Native mode (host tools)
./scripts/termote.sh install container --no-auth       # Without auth
./scripts/termote.sh install container --tailscale host  # Tailscale HTTPS
./scripts/termote.sh install container --fresh         # Force new password (ignore saved)
curl -fsSL https://... | bash -s -- --update           # Auto-update with saved config
```

## Development Commands

```bash
# Using Makefile (recommended)
make build          # Build PWA + tmux-api
make test           # Run all tests
make deploy-container  # Deploy container (docker/podman)
make health         # Check services

# Manual commands
cd pwa && pnpm install && pnpm dev     # Dev server
cd pwa && pnpm tsc --noEmit            # Type check
cd tmux-api && go build -o tmux-api .  # Build server
```

### Cross-Compilation (macOS for Linux Container)

When building Docker images on macOS, tmux-api is cross-compiled to Linux:

```bash
# Automatic (termote.sh handles this)
cd tmux-api && GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o tmux-api .

# For ARM64 (Apple Silicon):
cd tmux-api && GOOS=linux GOARCH=arm64 go build -ldflags="-s -w" -o tmux-api .
```

## Architecture

Both modes use tmux-api as the unified server (PWA + WebSocket proxy + API + auth):

```
┌─────────────────────────────────────────────────────────┐
│ Container mode (all-in-one container)                   │
│   tmux-api:7680 (PWA + proxy + API + auth)              │
│   ├→ static PWA files                                   │
│   ├→ WebSocket proxy to ttyd:7681                       │
│   └→ tmux API endpoints (/api/tmux/*)                   │
│   ttyd:7681 → tmux                                      │
│   Container Runtime: auto-detect podman or docker       │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│ Native mode (macOS & Linux)                             │
│   tmux-api:7680 (PWA + proxy + API + auth)              │
│   ├→ static PWA files                                   │
│   ├→ WebSocket proxy to ttyd:7681                       │
│   └→ tmux API endpoints                                 │
│   ttyd:7681 → tmux                                      │
│   No container required                                 │
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
- Use `$(uname)` to detect Darwin (macOS) vs Linux
- Use `$(uname -m)` for architecture detection (x86_64, aarch64)

## Key Files

| File                                      | Purpose                                   |
| ----------------------------------------- | ----------------------------------------- |
| `pwa/src/App.tsx`                         | Main app with gestures, toolbar, sessions |
| `pwa/src/components/keyboard-toolbar.tsx` | Virtual keyboard for mobile               |
| `pwa/src/hooks/use-gestures.ts`           | Hammer.js gesture handling                |
| `tmux-api/main.go`                        | Entry point                               |
| `tmux-api/serve.go`                       | Server (PWA, WebSocket proxy, auth)       |
| `tmux-api/tmux.go`                        | tmux API handlers                         |
| `Dockerfile`                              | Docker mode container                     |
| `entrypoint.sh`                           | Container entrypoint                      |

## Container Runtime Support

Scripts auto-detect container runtime in this priority:

1. **podman** (preferred, lighter-weight)
2. **docker** (fallback)

Both Docker Desktop and Podman work on all platforms (macOS, Linux).

## Security Notes

- Basic auth enabled by default (use `--no-auth` to disable for local dev)
- Basic auth over HTTPS required for production
- **ttyd binds to localhost only** - external access via tmux-api proxy (handles auth)
- **`/terminal/` endpoint**: 3-layer protection — basic auth + Sec-Fetch-Dest check (blocks direct navigation & non-browser clients) + single-use token (30s TTL, consumed on iframe load)
- tmux-api binds to localhost by default, use `--lan` to expose to network
- Same-origin iframe setup via tmux-api proxy
- PostMessage uses explicit origin (not wildcard)
- Exclude sensitive dirs (.ssh, .gnupg) from volume mounts
- Serve mode uses constant-time comparison for password verification
- **Brute-force protection**: built-in rate limiter (5 failed attempts/min per IP → 429)
- **Server hardening**: ReadHeaderTimeout (Slowloris protection), request body size limits (8KB on send-keys)
- **Error sanitization**: internal errors logged server-side only, generic messages returned to clients

## Testing

```bash
make test             # Run all tests
make test-cli         # Test termote.sh CLI
make test-get         # Test online installer
make test-entrypoints # Test Docker entrypoints

# Manual checks
cd pwa && pnpm tsc --noEmit          # Type check
curl http://localhost:7680/api/tmux/health  # Test API

# E2E tests (requires running server)
./scripts/termote.sh install container  # Start server first
cd pwa && pnpm test:e2e              # Run Playwright tests
cd pwa && pnpm test:e2e:ui           # Run with UI debugger
```
