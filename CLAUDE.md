# CLAUDE.md

Instructions for Claude Code when working with this repository.

## Project Overview

**Termote** = Terminal + Remote

A PWA for remotely controlling CLI tools (Claude Code, GitHub Copilot, any terminal) from mobile/desktop.

## Tech Stack

| Layer           | Technology                                                                |
| --------------- | ------------------------------------------------------------------------- |
| Frontend        | React 19 + TypeScript + Vite + TailwindCSS                                |
| PWA             | vite-plugin-pwa + Workbox                                                 |
| Terminal        | xterm.js over WebSocket (tmux-api streams the PTY/ConPTY itself, no ttyd) |
| Server          | Go (tmux-api serve mode)                                                  |
| Sessions        | tmux/psmux, or Herdr workspaces (native only)                             |
| Package Manager | pnpm                                                                      |

## Project Structure

```
termote/
├── Dockerfile              # Docker mode (tmux-api + tmux, no ttyd)
├── docker-compose.yml
├── pwa/                    # React PWA frontend
│   ├── src/
│   │   ├── components/     # React components
│   │   ├── hooks/          # Custom React hooks
│   │   ├── types/          # TypeScript types
│   │   └── utils/          # Utility functions
│   ├── package.json
│   └── vite.config.ts
├── tmux-api/               # Go server + CLI, single binary (PWA + API + auth)
│   ├── main.go             # Entry point: no args/`serve` = server, else CLI
│   ├── serve.go            # Server (static files, auth, guards)
│   ├── mux.go              # Mux interface + /api/mux/* routes
│   ├── mux_tmux.go         # tmux/psmux backend
│   ├── mux_herdr.go        # Herdr backend (native only)
│   ├── stream.go           # Terminal WebSocket (xterm.js stream)
│   └── cli*.go             # CLI subcommands (install, update, health, ...)
├── scripts/                # Thin CLI shims over the tmux-api binary
│   ├── termote.sh          # Unix shim (resolves/builds the binary, execs it)
│   ├── termote.ps1         # Windows PowerShell shim (same, maps -Flag to --flag)
│   ├── get.sh              # Unix online installer (curl | bash)
│   └── get.ps1             # Windows online installer (irm | iex)
├── tests/                  # Test suite
│   ├── test-termote.sh     # Unix shim tests
│   ├── test-termote.ps1    # Windows shim tests
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
./scripts/termote.sh install native --mux herdr        # Herdr backend (native only)
./scripts/termote.sh install container --allow-host box.local  # Add a Host allowlist entry
./scripts/termote.sh show-password                     # Print the saved admin password
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
.\scripts\termote.ps1 install native                   # Native mode (psmux, no ttyd)
.\scripts\termote.ps1 install container -Lan           # LAN accessible
.\scripts\termote.ps1 install native -NoAuth           # Without auth
.\scripts\termote.ps1 install native -Tailscale host   # Tailscale HTTPS
.\scripts\termote.ps1 install native -Fresh            # Force new password (ignore saved)
.\scripts\termote.ps1 install native -Mux herdr        # Herdr backend (native only)
.\scripts\termote.ps1 install native -AllowHost box.local  # Add a Host allowlist entry
.\scripts\termote.ps1 show-password                    # Print the saved admin password
.\scripts\termote.ps1 update                           # Self-update to latest release
.\scripts\termote.ps1 update -Version 0.1.5            # Update to specific version
.\scripts\termote.ps1 update -Force                    # Force reinstall current version
.\scripts\termote.ps1 logs follow                      # Tail all logs live (Ctrl+C to stop)
.\scripts\termote.ps1 logs clean                       # Delete log files
.\scripts\termote.ps1 link                             # Create 'termote' global command
.\scripts\termote.ps1 unlink                           # Remove global command
irm https://... | iex                                  # Online installer
$env:TERMOTE_UPDATE="true"; irm ... | iex              # Auto-update with saved config
```

## Development Commands

This is a **pnpm workspace** (`pnpm-workspace.yaml` at repo root). `pwa` (`termote`) and
`website` (`@termote/website`) share a single root `pnpm-lock.yaml`. Install once from the
root — no need to `cd` into each package.

```bash
# Using Makefile (recommended)
make build          # Build PWA + tmux-api
make test           # Run all tests
make deploy-container  # Deploy container (docker/podman)
make health         # Check services

# Workspace commands (run from repo root)
pnpm install                          # Install ALL packages (single lockfile)
pnpm --filter termote dev             # PWA dev server
pnpm --filter @termote/website dev    # Website dev server
pnpm --filter termote build           # Build PWA only
pnpm -r build                         # Build every package
# Scope an install to one package + its deps (used by CI):
pnpm install --frozen-lockfile --filter termote...

# Manual commands
cd pwa && pnpm dev                     # Dev server (still works — pnpm is workspace-aware)
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

Both modes use tmux-api as the unified server (PWA + terminal stream + API + auth). tmux-api
opens the terminal itself (PTY on Unix, ConPTY on Windows) and streams it to xterm.js in the
PWA over `/api/mux/stream` — there is no separate terminal process or proxy:

```
┌─────────────────────────────────────────────────────────┐
│ Container mode (all-in-one container)                   │
│   tmux-api:7680 (PWA + terminal stream + API + auth)     │
│   ├→ static PWA files                                   │
│   ├→ terminal WebSocket (/api/mux/stream)               │
│   └→ mux API endpoints (/api/mux/*)                     │
│   Mux backend: tmux → tmux session                      │
│   Container Runtime: auto-detect podman or docker       │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│ Native mode (macOS & Linux)                             │
│   tmux-api:7680 (PWA + terminal stream + API + auth)     │
│   ├→ static PWA files                                   │
│   ├→ terminal WebSocket (/api/mux/stream)               │
│   └→ mux API endpoints                                  │
│   Mux backend: tmux, or Herdr (--mux herdr)              │
│   No container required                                 │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│ Native mode (Windows with psmux)                        │
│   tmux-api.exe:7690 (PWA + terminal stream + API + auth) │
│   ├→ static PWA files                                   │
│   ├→ terminal WebSocket (/api/mux/stream, ConPTY)       │
│   └→ mux API endpoints → psmux                          │
│   Mux backend: tmux (psmux)                              │
│   Requires: winget install psmux                        │
└─────────────────────────────────────────────────────────┘
```

Every request also passes a Host allowlist and, for state-changing `/api/mux/*` calls and the
stream WebSocket, an Origin/`Sec-Fetch-Site` and single-use-token check — see
[`docs/system-architecture.md`](docs/system-architecture.md).

## Code Conventions

- **File naming**: kebab-case for all files (e.g., `keyboard-toolbar.tsx`)
- **Components**: Function components with TypeScript
- **Hooks**: Prefix with `use-` (e.g., `use-session.ts`)
- **State**: React hooks (useState, useCallback, useMemo)
- **Styling**: TailwindCSS utility classes

### Shell Scripts (shims only)

`scripts/termote.sh` and `scripts/termote.ps1` only resolve/build the `tmux-api` binary and
`exec` it with the same arguments (mapping `-Flag` to `--flag` on Windows); they hold no
install/update logic. What cross-platform behavior remains there:

- Use `$(uname)` to detect Darwin (macOS) vs Linux, `$(uname -m)` for architecture
- Use `CDPATH= cd` to resolve symlinks without depending on `readlink -f`
- Windows: map every 0.x parameter to a Go flag so a 0.x `update` can still relaunch this script

All install/update/health/logs/allowlist logic is Go in `tmux-api/cli*.go` — see
[`docs/code-standards.md`](docs/code-standards.md) for Go CLI conventions.

### CLI Commands

Subcommands of the `tmux-api` binary (run via the shims above, or `termote` after `link`):

- `install [container|native] [flags]` — deploy mode with optional flags
- `uninstall [container|native|all]` — remove an installation
- `update [--version X.Y.Z] [--force]` — self-update to latest (or a pinned) release
- `health` — check service health
- `logs [tmux-api|all|follow|clean]` — service logs
- `link` / `unlink` — create/remove the `termote` global command
- `show-password` — print the saved admin password
- `version` — show installed version
- `menu` (no arguments) — interactive numbered menu, no `gum` dependency

Flags: `--port`, `--lan`, `--tailscale <host[:port]>`, `--no-auth`, `--mux <tmux|herdr>`
(`-Mux` on Windows, native only), `--allow-host <name>` (`-AllowHost`, repeatable, no
wildcard), `--allow-herdr-no-auth` (`-AllowHerdrNoAuth`), `--fresh`, `--version <X.Y.Z>`,
`--force`. `--ttyd`/`-Ttyd` is still accepted (0.x's own `update` passes it) but is ignored
with a warning.

The `update` command:

- Fetches latest release from GitHub (or uses `--version` to pin)
- Downloads + verifies checksum
- Extracts tarball, preserves config
- Stops running services (native + container)
- Re-installs with saved configuration (mode, LAN, auth, port, mux, allowlist, Tailscale)
- Re-links symlink if it existed
- Uses `exec`/self-replace to hand off to the new binary (safe self-replacement)
- Guards: refuses to run from git repo (dev mode only)
- Warns on downgrade, skips reinstall if already on target version

## Key Files

| File                                              | Purpose                                                      |
| ------------------------------------------------- | ------------------------------------------------------------ |
| `pwa/src/App.tsx`                                 | Main app with gestures, toolbar, settings, sessions          |
| `pwa/src/components/keyboard-toolbar.tsx`         | Virtual keyboard for mobile                                  |
| `pwa/src/components/settings-modal.tsx`           | Settings dialog (IME, paste source, toolbar, etc.)           |
| `pwa/src/components/gesture-hints-overlay.tsx`    | First-time gesture tutorial overlay (mobile)                 |
| `pwa/src/components/session-tabs.tsx`             | Session tab bar for window switching                         |
| `pwa/src/components/connection-indicator.tsx`     | Connection status indicator with retry                       |
| `pwa/src/components/command-history-dropdown.tsx` | Command search/recall UI                                     |
| `pwa/src/components/quick-actions-menu.tsx`       | Quick action FAB menu                                        |
| `pwa/src/components/toast.tsx`                    | Toast notification component                                 |
| `pwa/src/hooks/use-settings.ts`                   | Settings state with localStorage persistence                 |
| `pwa/src/hooks/use-command-history.ts`            | Command history storage and management                       |
| `pwa/src/hooks/use-update-check.ts`               | GitHub release checker with caching                          |
| `pwa/src/hooks/use-gestures.ts`                   | Hammer.js gesture handling                                   |
| `pwa/src/components/terminal-view.tsx`            | xterm.js terminal component (stream, resize, reconnect)      |
| `pwa/src/utils/terminal-bridge.ts`                | Drives the xterm.js terminal (key mapping, clipboard paste)  |
| `tmux-api/main.go`                                | Entry point (no args/`serve` = server, else CLI)             |
| `tmux-api/serve.go`                               | Server (PWA static files, auth, guards)                      |
| `tmux-api/mux.go`                                 | `Mux` interface + `/api/mux/*` routes                        |
| `tmux-api/mux_tmux.go`                            | tmux/psmux backend                                           |
| `tmux-api/mux_herdr.go`                           | Herdr backend (native only)                                  |
| `tmux-api/stream.go`                              | Terminal WebSocket (`/api/mux/stream`)                       |
| `tmux-api/guard.go`                               | Host allowlist + Origin/Content-Type write guard             |
| `tmux-api/cli_install.go`                         | `install`/`uninstall`: native, container, allowlist, migrate |
| `Dockerfile`                                      | Docker mode container                                        |
| `entrypoint.sh`                                   | Container entrypoint                                         |

## Container Runtime Support

Scripts auto-detect container runtime in this priority:

1. **podman** (preferred, lighter-weight)
2. **docker** (fallback)

Both Docker Desktop and Podman work on all platforms (macOS, Linux).

## Security Notes

- Basic auth enabled by default (use `--no-auth` to disable for local dev); an empty saved
  password no longer disables auth — `install` generates and saves a new one instead
- Basic auth over HTTPS required for production
- **Host allowlist** (`hostGuard`): requests with an unrecognised `Host` header get a 403;
  the allowed set is loopback + LAN IP (`--lan`) + Tailscale name + `--allow-host`/`-AllowHost`
  entries, with no wildcard to disable the check
- **Write/CSRF guard** (`writeGuard`): state-changing `/api/mux/*` requests must be
  same-site (`Sec-Fetch-Site`/`Origin` on the allowlist) with `Content-Type: application/json`
- **Terminal stream** (`/api/mux/stream`): same Origin check plus a single-use, 30s-TTL token
  fetched via `/api/mux/stream-token`, consumed on WebSocket upgrade
- **Herdr guard**: `--mux herdr --no-auth` is refused unless `--allow-herdr-no-auth` is also
  given, since Herdr exposes every workspace on the host
- tmux-api binds to localhost by default, use `--lan` to expose to network
- Exclude sensitive dirs (.ssh, .gnupg, .aws, .config/gcloud) from volume mounts (warned at install)
- Serve mode uses constant-time comparison for password verification
- **Brute-force protection**: built-in rate limiter (5 failed attempts/min per IP → 429)
- **Server hardening**: ReadHeaderTimeout (Slowloris protection), request body size limits (8KB on `/api/mux/*`)
- **Error sanitization**: internal errors logged server-side only, generic messages returned to clients
- **Config persistence**: saved password encrypted with AES-256-CBC + PBKDF2 (machine-derived key) on Unix, DPAPI on Windows; config file chmod 600, password hidden on subsequent runs (`show-password` to view again)

## Pre-commit Checks

**IMPORTANT:** Always run lint/format checks locally before committing to avoid CI failures.

```bash
# PWA (required before commit)
pnpm --filter termote lint

# tmux-api
cd tmux-api && go build . && go vet ./...

# Formatting (markdown, JSON, YAML via dprint)
make fmt-check
```

## Testing

```bash
make test             # Run all tests (Go + shim + installer + entrypoints)
make test-cli         # Test the termote.sh shim
make test-get         # Test online installer
make test-entrypoints # Test Docker entrypoints

# Manual checks
pnpm --filter termote exec tsc --noEmit     # Type check
curl http://localhost:7680/api/mux/health   # Test API

# E2E tests (requires running server)
./scripts/termote.sh install container  # Start server first
pnpm --filter termote test:e2e              # Run Playwright tests
pnpm --filter termote test:e2e:ui           # Run with UI debugger
```
