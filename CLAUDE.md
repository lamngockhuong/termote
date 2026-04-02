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
├── scripts/                # CLI scripts
│   ├── termote.sh          # Unix CLI (install/uninstall/health/link)
│   ├── termote.ps1         # Windows PowerShell CLI
│   ├── get.sh              # Unix online installer (curl | bash)
│   └── get.ps1             # Windows online installer (irm | iex)
├── tests/                  # Test suite
│   ├── test-termote.sh     # Unix CLI tests
│   ├── test-termote.ps1    # Windows CLI tests
│   ├── test-get.sh         # Online installer tests
│   └── test-entrypoints.sh # Docker entrypoint tests
├── website/                # Documentation site (Astro Starlight)
│   └── src/content/docs/   # MDX docs (EN + VI)
└── Makefile                # Build/test/deploy commands
```

## Deployment Modes

| Mode          | Description               | Use Case                        | Platform              |
| ------------- | ------------------------- | ------------------------------- | --------------------- |
| `--container` | Container mode            | Simple deployment, isolated env | macOS, Linux, Windows |
| `--native`    | All native (no container) | Host tool access (Claude Code)  | macOS, Linux, Windows |

```bash
# Unix (macOS/Linux)
./scripts/termote.sh                                   # Interactive menu
./scripts/termote.sh install container                 # Container mode (saves config)
./scripts/termote.sh install container --lan           # LAN accessible
./scripts/termote.sh install native                    # Native mode (host tools)
./scripts/termote.sh install container --no-auth       # Without auth
./scripts/termote.sh install container --tailscale host  # Tailscale HTTPS
./scripts/termote.sh install container --fresh         # Force new password (ignore saved)
./scripts/termote.sh link                              # Create 'termote' global command
./scripts/termote.sh unlink                            # Remove global command
./scripts/termote.sh update                            # Update to latest release
./scripts/termote.sh update --version 0.1.5            # Update to specific version
./scripts/termote.sh update --force                    # Force reinstall current version
curl -fsSL https://... | bash -s -- --update           # Auto-update with saved config
```

```powershell
# Windows (PowerShell)
.\scripts\termote.ps1                                  # Interactive menu
.\scripts\termote.ps1 install container                # Container mode (saves config)
.\scripts\termote.ps1 install native                   # Native mode (psmux + ttyd)
.\scripts\termote.ps1 install container -Lan           # LAN accessible
.\scripts\termote.ps1 install native -NoAuth           # Without auth
.\scripts\termote.ps1 install native -Tailscale host   # Tailscale HTTPS
.\scripts\termote.ps1 install native -Fresh            # Force new password (ignore saved)
.\scripts\termote.ps1 link                             # Create 'termote' global command
.\scripts\termote.ps1 unlink                           # Remove global command
irm https://... | iex                                  # Online installer
$env:TERMOTE_UPDATE="true"; irm ... | iex              # Auto-update with saved config
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

┌─────────────────────────────────────────────────────────┐
│ Native mode (Windows with psmux)                        │
│   tmux-api.exe:7690 (PWA + proxy + API + auth)          │
│   ├→ static PWA files                                   │
│   ├→ WebSocket proxy to ttyd:7681                       │
│   └→ tmux API endpoints → psmux                         │
│   ttyd.exe:7681 → psmux (tmux-compatible)               │
│   Requires: winget install psmux                        │
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

### CLI Commands

Available commands in `termote.sh`:

- `termote install [container|native]` — deploy mode with optional flags
- `termote health` — check service health
- `termote link` — create `/usr/local/bin/termote` symlink
- `termote unlink` — remove symlink
- `termote update` — self-update to latest release
- `termote update --version X.Y.Z` — pin to specific version
- `termote update --force` — reinstall current version

The `update` command:

- Fetches latest release from GitHub (or uses `--version` to pin)
- Downloads + verifies checksum
- Extracts tarball, preserves config
- Stops running services (native + container)
- Re-installs with saved configuration (mode, LAN, auth, port, Tailscale)
- Re-links symlink if it existed
- Uses `exec` to replace process with new script (safe self-replacement)
- Guards: refuses to run from git repo (dev mode only)
- Warns on downgrade, skips reinstall if already on target version

## Key Files

| File                                      | Purpose                                             |
| ----------------------------------------- | --------------------------------------------------- |
| `pwa/src/App.tsx`                         | Main app with gestures, toolbar, settings, sessions |
| `pwa/src/components/keyboard-toolbar.tsx` | Virtual keyboard for mobile                         |
| `pwa/src/components/settings-modal.tsx`   | Settings dialog (IME send behavior, toolbar expand) |
| `pwa/src/hooks/use-settings.ts`           | Settings state with localStorage persistence        |
| `pwa/src/hooks/use-gestures.ts`           | Hammer.js gesture handling                          |
| `tmux-api/main.go`                        | Entry point                                         |
| `tmux-api/serve.go`                       | Server (PWA, WebSocket proxy, auth)                 |
| `tmux-api/tmux.go`                        | tmux API handlers                                   |
| `Dockerfile`                              | Docker mode container                               |
| `entrypoint.sh`                           | Container entrypoint                                |

## Container Runtime Support

Scripts auto-detect container runtime in this priority:

1. **podman** (preferred, lighter-weight)
2. **docker** (fallback)

Both Docker Desktop and Podman work on all platforms (macOS, Linux).

## Security Notes

- Basic auth enabled by default (use `--no-auth` to disable for local dev)
- Basic auth over HTTPS required for production
- **ttyd binds to localhost only** - external access via tmux-api proxy (handles auth)
- **`/terminal/` endpoint**: 3-layer protection — basic auth + Sec-Fetch-Dest check (blocks direct navigation) + single-use token (30s TTL, consumed on iframe load)
- tmux-api binds to localhost by default, use `--lan` to expose to network
- Same-origin iframe setup via tmux-api proxy
- PostMessage uses explicit origin (not wildcard)
- Exclude sensitive dirs (.ssh, .gnupg) from volume mounts
- Serve mode uses constant-time comparison for password verification
- **Brute-force protection**: built-in rate limiter (5 failed attempts/min per IP → 429)
- **Server hardening**: ReadHeaderTimeout (Slowloris protection), request body size limits (8KB on send-keys)
- **Error sanitization**: internal errors logged server-side only, generic messages returned to clients
- **Config persistence**: saved password encrypted with AES-256-CBC + PBKDF2 (machine-derived key), config file chmod 600, password hidden on subsequent runs

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
