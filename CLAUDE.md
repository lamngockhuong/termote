# CLAUDE.md

Instructions for Claude Code when working with this repository.

## Project Overview

**Termote** = Terminal + Remote

A PWA for remotely controlling CLI tools (Claude Code, GitHub Copilot, any terminal) from mobile/desktop.

## Tech Stack

| Layer           | Technology                                                               |
| --------------- | ------------------------------------------------------------------------ |
| Frontend        | React 19 + TypeScript + Vite + TailwindCSS                               |
| PWA             | vite-plugin-pwa + Workbox                                                |
| Terminal        | xterm.js over WebSocket (termote streams the PTY/ConPTY itself, no ttyd) |
| Server          | Go (termote serve mode)                                                  |
| Sessions        | tmux/psmux, or Herdr workspaces (native or in the container)             |
| Package Manager | pnpm                                                                     |

## Project Structure

```
termote/
├── Dockerfile              # Docker mode (termote + tmux + herdr, no ttyd)
├── docker-compose.yml      # Development-only container run (a checkout, not the release image)
├── pwa/                    # React PWA frontend
│   ├── src/
│   │   ├── components/     # React components
│   │   ├── hooks/          # Custom React hooks
│   │   ├── types/          # TypeScript types
│   │   └── utils/          # Utility functions
│   ├── package.json
│   └── vite.config.ts
├── server/                 # Go server + CLI, single binary (PWA + API + auth)
│   ├── main.go             # Entry point: `serve` runs the server, no args opens the menu
│   ├── serve.go            # Server (static files, auth, guards)
│   ├── serve_config.go     # Builds the server's config from the saved config or the environment
│   ├── mux.go              # Mux interface + /api/mux/* routes
│   ├── mux_tmux.go         # tmux/psmux backend
│   ├── mux_herdr.go        # Herdr backend
│   ├── herdr_socket_*.go   # Herdr socket path + dial (Unix socket / Windows named pipe)
│   ├── herdr_observer_*.go # Stops `observe`/`control` (process group / Windows Job Object)
│   ├── stream.go           # Terminal WebSocket (xterm.js stream)
│   ├── agent*.go           # Chat view: Claude Code session, transcript, messages, dialogs
│   ├── files*.go           # Files/Changes views: pane root, tree, contents, git status/diff
│   ├── webui/              # Embeds the built PWA into the binary (build output, .gitkeep only in git)
│   ├── install_layout.go   # Versioned install layout (versions/<v>, current pointer, prune)
│   ├── release_tags.go     # Picks the newest stable 1.x GitHub tag
│   ├── tailscale.go        # `tailscale serve` mapping (apply/remove, never sudo)
│   ├── cli_start.go        # `start`/`stop`/`restart`: saves options, registers and runs the service
│   ├── cli_service*.go     # OS supervisor registration (systemd/launchd/Scheduled Task)
│   ├── cli_container.go    # `container up|down|logs|status` (podman/docker)
│   └── cli*.go             # Remaining CLI subcommands (update, logs, link, show-password, ...)
├── herdr-plugin/           # Herdr plugin manifest (every command runs `termote ...`)
├── scripts/
│   ├── install.sh          # Unix release installer (curl | sh): downloads, verifies, lays out
│   ├── install.ps1         # Windows release installer (irm | iex), same job
│   ├── termote.sh          # Checkout-only dev shim: builds/runs server/termote-dev
│   └── termote.ps1         # Checkout-only dev shim (Windows), same job
├── tests/                  # Test suite
│   ├── fixtures/fake-claude.sh # Stand-in Claude Code for the Chat view E2E (Linux)
│   ├── test-termote.sh     # Unix dev shim tests
│   ├── test-termote.ps1    # Windows dev shim tests
│   ├── test-install.sh     # install.sh tests (fake curl)
│   ├── test-install.ps1    # install.ps1 tests
│   └── test-entrypoints.sh # Docker entrypoint tests
├── website/                # Documentation site (Astro Starlight)
│   └── src/content/docs/   # MDX docs (EN + VI)
└── Makefile                # Build/test/deploy commands
```

## Deployment Modes

Termote 1.0 has a single install path: two commands, then `termote start` (native) or
`termote container up` (container, podman/docker). See
[`docs/getting-started.md`](docs/getting-started.md) and
[`docs/deployment-guide.md`](docs/deployment-guide.md) for the full flag/config reference.

```bash
# Linux, macOS
curl -fsSL https://termote.ohnice.app/install.sh | sh
termote start                              # native: host tools (Claude Code, git, ...)
termote start --lan                        # native, LAN accessible
termote start --no-auth                    # native, without auth (local dev only)
termote start --tailscale host             # native, Tailscale HTTPS
termote start --fresh                      # native, force a new password
termote start --mux herdr                  # native, Herdr backend instead of tmux
termote start --allow-host box.local       # native, add a Host allowlist entry
termote container up                       # container mode (podman/docker)
termote container up --lan --port 7681     # container, LAN + custom port
termote container up --mux herdr           # container, Herdr inside it instead of tmux
termote show-password                      # print the saved admin password
termote link / unlink                      # create/remove the 'termote' global command
termote update                             # update to the latest release
termote update --version 1.0.0 --force     # pin/reinstall a specific version
```

```powershell
# Windows (PowerShell) — same commands, same flag syntax (no `-Flag` mapping in 1.0)
irm https://termote.ohnice.app/install.ps1 | iex
termote start
termote start --lan
termote start --mux herdr
termote logs follow                        # Tail all logs live (Ctrl+C to stop)
termote logs clean                         # Delete log files
termote update --version 1.0.0
```

There is no `install` command in 1.0 (it prints the replacement above), and the online
installer scripts (`scripts/install.sh`/`install.ps1`) only download, verify and lay out the
binary, then print `termote start` — they never start anything themselves.

## Development Commands

This is a **pnpm workspace** (`pnpm-workspace.yaml` at repo root). `pwa` (`termote`) and
`website` (`@termote/website`) share a single root `pnpm-lock.yaml`. Install once from the
root — no need to `cd` into each package.

```bash
# Using Makefile (recommended)
make build          # Build PWA + termote
make test           # Run all tests
make start          # Start the server as a native service (through the dev shim)
make container-up   # Run the server in a container (podman/docker, through the dev shim)
make health         # Check service health

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
cd server && go build -o termote-dev . # Build server (checkout binary name)
```

### Cross-Compilation (macOS for Linux Container)

`termote container up --build` (from a checkout) cross-compiles `server/termote-linux-<arch>`
itself before building the image — the `Dockerfile` only copies a pre-built Linux binary in, it
never runs `go build`:

```bash
# What --build runs, equivalent to:
cd server && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o termote-linux-amd64 .
cd server && CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -ldflags="-s -w" -o termote-linux-arm64 .
```

## Architecture

Both modes use termote as the unified server (PWA + terminal stream + API + auth). termote
opens the terminal itself (PTY on Unix, ConPTY on Windows) and streams it to xterm.js in the
PWA over `/api/mux/stream` — there is no separate terminal process or proxy:

```
┌─────────────────────────────────────────────────────────┐
│ Container mode (all-in-one container)                   │
│   termote:7680 (PWA + terminal stream + API + auth)      │
│   ├→ static PWA files                                   │
│   ├→ terminal WebSocket (/api/mux/stream)               │
│   └→ mux API endpoints (/api/mux/*)                     │
│   Mux backend: tmux, or Herdr inside (--mux herdr)      │
│   Container Runtime: auto-detect podman or docker       │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│ Native mode (macOS & Linux)                             │
│   termote:7680 (PWA + terminal stream + API + auth)      │
│   ├→ static PWA files                                   │
│   ├→ terminal WebSocket (/api/mux/stream)               │
│   └→ mux API endpoints                                  │
│   Mux backend: tmux, or Herdr (--mux herdr)              │
│   No container required                                 │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│ Native mode (Windows with psmux or Herdr)               │
│   termote.exe:7690 (PWA + stream + API + auth)          │
│   ├→ static PWA files                                   │
│   ├→ terminal WebSocket (/api/mux/stream, ConPTY)       │
│   └→ mux API endpoints → psmux, or Herdr (named pipe)   │
│   Mux backend: tmux (psmux), or Herdr (--mux herdr)     │
│   Requires: winget install psmux, or a running Herdr    │
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

### Shell Scripts

`scripts/install.sh`/`install.ps1` are the release installers: they download the archive for
the current OS/arch, verify its `.sha256` (mandatory), lay it out under the versioned install
root and print `termote start` — they never start anything and hold no CLI logic themselves.
`scripts/termote.sh`/`termote.ps1` are a separate, checkout-only dev shim: they build the PWA
if missing, rebuild `server/termote-dev` when a Go source or the PWA build is newer, then run
it with the same arguments; they never run an installed release. Flags use the same Go syntax
on every OS in 1.0 (`--lan`, not `-Lan`), so neither script needs to map flag names.

All `start`/`stop`/`update`/`container`/`logs`/allowlist logic is Go in `server/cli*.go` — see
[`docs/code-standards.md`](docs/code-standards.md) for Go CLI conventions.

### CLI Commands

Subcommands of the `termote` binary (run directly after `link`, or via `./scripts/termote.sh`
from a checkout):

```
start [options]      Save the options, register the service and start it
stop                 Stop the server (it starts again at the next login)
restart              Stop and start with the saved options
status [--json]      Show what the running server reports (alias: health)
url [options]        Print the link to open, or a deep link to one session
panel                Status, links and a QR code, with keys to open, copy, start, stop
container <cmd>      Run the server in a container: up, down, logs [-f], status
update               Update to the latest release
uninstall            Remove the service, the command and the install (config and logs stay)
logs [service]       View logs (server, all, follow, clean)
link / unlink        Create or remove the 'termote' command in ~/.local/bin
show-password        Show the saved admin password
version              Show version
serve                Run the server in the foreground (what the service runs)
(no command)         Interactive menu
```

There is no `install` command in 1.0 (it prints the replacement above).

`start` options (saved in the config; a flag not given keeps its saved value; a boolean is
turned off with `=false`): `--port <port>` (default 7680, Windows 7690), `--lan[=false]`,
`--tailscale <host[:port]>`, `--no-tailscale`, `--no-auth[=false]`, `--mux <tmux|herdr>`,
`--allow-host <name>` (repeatable), `--remove-host <name>` (repeatable),
`--allow-herdr-no-auth`, `--fresh`. `update` takes `--version <X.Y.Z>` and `--force`.
`container up` additionally takes `--workspace <dir>` and `--build`. `url` takes `--herdr` (ids from
the Herdr plugin context) or `--group/--tab/--pane`, `--view`, and `--open`/`--copy`/`--qr`; only
the link goes to stdout. There is no `--ttyd` flag
and no PowerShell `-Flag` variants in 1.0.

The `update` command:

- Fetches the newest stable 1.x release tag from GitHub (or uses `--version` to pin)
- Downloads the archive + `.sha256` (mandatory) into `versions/<v>`, switches `current` atomically
- Restarts the service, waits until health reports the new version and keeps answering
- Otherwise switches `current` back to the previous version and restarts it (both kept)
- Preserves config and service registration; refuses in a git checkout or for a binary not
  installed by the installer; warns on downgrade, skips reinstall if already on target version

## Key Files

| File                                              | Purpose                                                       |
| ------------------------------------------------- | ------------------------------------------------------------- |
| `pwa/src/App.tsx`                                 | Main app with gestures, toolbar, settings, sessions           |
| `pwa/src/components/keyboard-toolbar.tsx`         | Virtual keyboard for mobile                                   |
| `pwa/src/components/settings-modal.tsx`           | Settings dialog (IME, paste source, toolbar, etc.)            |
| `pwa/src/components/gesture-hints-overlay.tsx`    | First-time gesture tutorial overlay (mobile)                  |
| `pwa/src/components/session-tabs.tsx`             | Session tab bar for window switching                          |
| `pwa/src/components/connection-indicator.tsx`     | Connection status indicator with retry                        |
| `pwa/src/components/command-history-dropdown.tsx` | Command search/recall UI                                      |
| `pwa/src/components/quick-actions-menu.tsx`       | Quick actions sheet (opened from a toolbar key on mobile)     |
| `pwa/src/components/app-header.tsx`               | Header: session chip / tabs, More menu                        |
| `pwa/src/components/session-switcher-chip.tsx`    | Mobile header chip that opens the sessions sheet              |
| `pwa/src/components/ui/`                          | Shared UI primitives (Button, Sheet, Menu, Switch, ...)       |
| `pwa/src/app-views.ts`                            | Views of a pane (terminal, chat, files, changes)              |
| `pwa/src/ui-style.ts`                             | Interface styles (neutral, terminal, native)                  |
| `pwa/src/components/toast.tsx`                    | Toast notification component                                  |
| `pwa/src/hooks/use-settings.ts`                   | Settings state with localStorage persistence                  |
| `pwa/src/hooks/use-command-history.ts`            | Command history storage and management                        |
| `pwa/src/hooks/use-update-check.ts`               | GitHub release checker with caching                           |
| `pwa/src/hooks/use-gestures.ts`                   | Hammer.js gesture handling                                    |
| `pwa/src/components/terminal-view.tsx`            | xterm.js terminal component (stream, resize, reconnect)       |
| `pwa/src/utils/terminal-bridge.ts`                | Drives the xterm.js terminal (key mapping, clipboard paste)   |
| `pwa/src/components/chat-view.tsx`                | Chat view of a pane running Claude Code (lazy-loaded)         |
| `pwa/src/components/chat-composer.tsx`            | Chat view message box                                         |
| `pwa/src/components/prompt-card.tsx`              | Claude Code dialog as a card (answer buttons or read-only)    |
| `pwa/src/hooks/use-agent-transcript.ts`           | Polls a pane's transcript, one store per pane                 |
| `pwa/src/hooks/use-agent-prompt.ts`               | Polls a pane's open dialog, one store per pane                |
| `pwa/src/components/files-view.tsx`               | Files view: the pane's directory as a tree, opens a file      |
| `pwa/src/components/changes-view.tsx`             | Changes view: git status grouped, opens a file's diff         |
| `pwa/src/components/markdown-preview.tsx`         | Markdown file rendered in Files/Changes (links, code blocks)  |
| `pwa/src/components/panel-toggles.tsx`            | Desktop header toggles of the side panel (Files, Changes)     |
| `pwa/src/hooks/use-files.ts`                      | File tree of a pane's root, one store per pane                |
| `pwa/src/hooks/use-git-changes.ts`                | Polls a pane's git status, one store per pane                 |
| `pwa/src/utils/highlight.ts`                      | Syntax highlighting through a Shiki worker, with a timeout    |
| `server/main.go`                                  | Entry point (`serve` runs the server, no args opens the menu) |
| `server/serve.go`                                 | Server (PWA static files, auth, guards)                       |
| `server/mux.go`                                   | `Mux` interface + `/api/mux/*` routes                         |
| `server/mux_tmux.go`                              | tmux/psmux backend                                            |
| `server/mux_herdr.go`                             | Herdr backend                                                 |
| `server/stream.go`                                | Terminal WebSocket (`/api/mux/stream`)                        |
| `server/agent.go`                                 | `/api/mux/panes/{id}/agent/*` routes, transcript reads        |
| `server/agent_claude.go`                          | Claude Code transcript (JSONL) and session file               |
| `server/agent_claude_prompt.go`                   | Reads a Claude Code screen: input box, dialogs                |
| `server/agent_input.go`                           | Sends a message, answers a dialog (checks before each write)  |
| `server/files.go`                                 | `/api/mux/panes/{id}/files/*` routes, tree and file contents  |
| `server/files_root.go`                            | Pane root (git toplevel), safe git runner                     |
| `server/files_git.go`                             | git status and diff for the Changes view                      |
| `server/files_sensitive.go`                       | Names of files that usually hold secrets                      |
| `server/agent_proc*.go`                           | Finds Claude Code under a tmux/psmux pane                     |
| `server/guard.go`                                 | Host allowlist + Origin/Content-Type write guard              |
| `server/serve_config.go`                          | Server config from the saved config, else the environment     |
| `server/install_layout.go`                        | Versioned install layout (`versions/<v>`, `current`, prune)   |
| `server/tailscale.go`                             | `tailscale serve` mapping (apply/remove, never sudo)          |
| `server/release_tags.go`                          | Picks the newest stable 1.x GitHub tag                        |
| `server/cli_start.go`                             | `start`/`stop`/`restart`: options, service registration       |
| `server/cli_service*.go`                          | OS supervisor registration (systemd/launchd/Scheduled Task)   |
| `server/cli_container.go`                         | `container up/down/logs/status`                               |
| `server/cli_url.go`                               | `status --json`, `url` (deep link, open, copy, QR)            |
| `server/cli_panel.go`                             | `panel`: the Herdr plugin's popup                             |
| `herdr-plugin/herdr-plugin.toml`                  | Herdr plugin manifest (actions + `panel` popup)               |
| `Dockerfile`                                      | Docker mode container                                         |
| `entrypoint.sh`                                   | Container entrypoint                                          |

## Container Runtime Support

`termote container up` auto-detects the container runtime in this priority:

1. **podman** (preferred, lighter-weight)
2. **docker** (fallback)

Both Docker Desktop and Podman work on all platforms (macOS, Linux).

## Security Notes

- **Service reads the saved config, ignoring the environment**: when `~/.config/termote/config`
  exists, `termote serve` reads it and ignores every `TERMOTE_*` variable; only without a saved
  config (the container, a manual `go run`/`termote-dev serve`) do `TERMOTE_*` variables
  configure it. `serve` also strips every `TERMOTE_*` variable from its own environment, so no
  terminal it opens inherits one.
- Basic auth enabled by default (use `--no-auth` to disable for local dev); an empty saved
  password no longer disables auth — `start` generates and saves a new one instead
- Basic auth over HTTPS required for production
- termote binds to `127.0.0.1` by default; only `--lan` makes it listen on `0.0.0.0`
- **Host allowlist** (`hostGuard`): requests with an unrecognised `Host` header get a 403; the
  allowed set is loopback + (with `--lan`) the address the request arrived on, so it keeps
  working as the LAN IP changes + the Tailscale name + `--allow-host` entries, with no
  wildcard to disable the check
- **Write/CSRF guard** (`writeGuard`): state-changing `/api/mux/*` requests must be
  same-site (`Sec-Fetch-Site`/`Origin` on the allowlist) with `Content-Type: application/json`
- **Terminal stream** (`/api/mux/stream`): same Origin check plus a single-use, 30s-TTL token
  fetched via `/api/mux/stream-token`, consumed on WebSocket upgrade
- **Herdr guard**: `--mux herdr --no-auth` is refused unless `--allow-herdr-no-auth` is also
  given, since Herdr exposes every workspace on the host
- **Agent chat** (`/api/mux/panes/{id}/agent/*`): on tmux the server reads only the transcript
  in the Claude config dir of the process found in the pane (`CLAUDE_CONFIG_DIR`, else
  `~/.claude`; psmux: `%USERPROFILE%\.claude`), and only for a process whose start time matches
  its session file's `procStart`; Herdr reports the session id itself, read from the server
  user's config dir. The session id must be a UUID. Every write takes a lock on the pane,
  re-checks the process, session and screen, and sends nothing unless the screen shows the
  expected state (an empty input box, the dialog the client saw with a single-use `promptId`).
  Markdown images in the Chat view never load (shown as links), and raw HTML is not rendered.
  `agent/commands` (the composer's `/` suggestions) returns only names, descriptions, sources
  and kinds of `.claude/commands`/`.claude/skills` under the pane root and `commands`/`skills`
  in that config dir, read through `os.Root` (first 8 KB per file; a file that is a symlink, under
  a denied dir or with a sensitive name is never read), with the same
  `Sec-Fetch-Site`/`Origin` check as the files routes. A symlinked skill dir is followed only
  into that config dir, the pane root or `~/.agents/skills`. Plugin commands come from the
  plugins `installed_plugins.json` lists and `enabledPlugins` (user, project, local settings)
  turns on; an `installPath` is read only when it resolves inside `<config dir>/plugins/`
  (at most 50 plugins, JSON files capped at 1 MB)
- **Files/Changes** (`/api/mux/panes/{id}/files/*`): read-only GETs that also check
  `Sec-Fetch-Site`/`Origin`; every path is opened through `os.Root` under the pane's root (its
  git toplevel, else its directory); termote's config/state dirs, `/proc`, `/sys`, `/dev` and
  `.git` are never served; sensitive names (`.env`, keys, ...) return contents or a diff only
  with `reveal=1`. git runs without a shell, with `GIT_*`/`TERMOTE_*` stripped, fsmonitor,
  filter drivers, external diff and textconv off, submodules ignored, 10s timeout, 2 at a time
- Exclude sensitive dirs (.ssh, .gnupg, .aws, .config/gcloud) from container volume mounts
  (warned at `container up`)
- Serve mode uses constant-time comparison for password verification
- **Brute-force protection**: built-in rate limiter (5 failed attempts/min per IP → 429)
- **Server hardening**: ReadHeaderTimeout (Slowloris protection), request body size limits (8KB on `/api/mux/*`, 64KB on `agent/message`)
- **Error sanitization**: internal errors logged server-side only, generic messages returned to clients
- **Config persistence**: the saved password is AES-256-CBC with an HMAC, keyed by a random
  per-install `secret` file (0600) on Unix, DPAPI on Windows; the config file is also chmod
  600. The password is never written to the systemd unit, launchd plist, Scheduled Task or any
  process command line; print it again with `termote show-password`.

## Pre-commit Checks

**IMPORTANT:** Always run lint/format checks locally before committing to avoid CI failures.

```bash
# PWA (required before commit)
pnpm --filter termote lint

# server (Go)
cd server && go build . && go vet ./...

# Formatting (markdown, JSON, YAML via dprint)
make fmt-check
```

## Testing

```bash
make test             # Run all tests (Go + dev shim + install.sh + entrypoints)
make test-go          # go test ./... in server/
make test-cli         # Test the termote.sh dev shim
make test-install     # Test install.sh (fake curl)
make test-entrypoints # Test Docker entrypoints

# Manual checks
pnpm --filter termote exec tsc --noEmit     # Type check
curl http://localhost:7680/api/mux/health   # Test API

# E2E tests (requires running server)
make start                      # or: ./scripts/termote.sh start
pnpm --filter termote test:e2e              # Run Playwright tests
pnpm --filter termote test:e2e:ui           # Run with UI debugger
```

Windows equivalents: `tests/test-termote.ps1`, `tests/test-install.ps1`.
