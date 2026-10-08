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
│   ├── files*.go           # Files/Changes views: pane root, tree, contents, git status/diff, images
│   ├── webui/              # Embeds the built PWA into the binary (build output, .gitkeep only in git)
│   ├── install_layout.go   # Versioned install layout (versions/<v>, current pointer, prune)
│   ├── release_tags.go     # Picks the newest published stable 1.x release
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
│   ├── fixtures/fake-codex.sh  # Stand-in Codex (--no-daemon) for the Chat view E2E (Linux)
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
termote start --user alice                 # native, log in as alice instead of admin
termote show-password                      # print the saved username and password
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
the current OS/arch, verify its `.sha256` (mandatory; `install.sh` also checks the release
signature from 1.10.0 with OpenSSL 3, and says so without it), lay it out under the versioned install
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
uninstall [--purge]  Remove the service, the command, the install and uploads (--purge: config, logs and the trash too)
logs [service]       View logs (server, all, follow, clean)
link / unlink        Create or remove the 'termote' command in ~/.local/bin
show-password        Show the saved username and password
version              Show version
serve                Run the server in the foreground (what the service runs)
(no command)         Interactive menu
```

There is no `install` command in 1.0 (it prints the replacement above).

`start` options (saved in the config; a flag not given keeps its saved value; a boolean is
turned off with `=false`): `--port <port>` (default 7680, Windows 7690), `--lan[=false]`,
`--tailscale <host[:port]>`, `--no-tailscale`, `--no-auth[=false]`, `--mux <tmux|herdr>`,
`--allow-host <name>` (repeatable), `--remove-host <name>` (repeatable),
`--allow-herdr-no-auth`, `--user <name>` (default `admin`, shared with the container like the
password), `--fresh`. `update` takes `--version <X.Y.Z>` and `--force`.
`container up` additionally takes `--workspace <dir>` and `--build`. `url` takes `--herdr` (ids from
the Herdr plugin context) or `--group/--tab/--pane`, `--view`, and `--open`/`--copy`/`--qr`; only
the link goes to stdout. There is no `--ttyd` flag
and no PowerShell `-Flag` variants in 1.0.

The `update` command:

- Fetches the newest published stable 1.x release from GitHub (the releases list, never the
  tags: a draft waiting for approval already has its tag), or uses `--version` to pin
- Downloads the archive + its checksum (mandatory) into `versions/<v>`, switches `current` atomically;
  from 1.10.0 (`firstSignedVersion`) the checksum must come from the release's `checksums.txt`,
  whose Ed25519 signature `checksums.txt.sig` verifies with `releasePublicKey`
  (`server/release_sign.go`, equal to the PEM in `install.sh`, a test checks)
- Restarts the service, waits until health reports the new version and keeps answering
- Otherwise switches `current` back to the previous version and restarts it (both kept)
- Preserves config and service registration; refuses in a git checkout or for a binary not
  installed by the installer, and when the registered service (systemd `ExecStart`, launchd
  `ProgramArguments`) runs another binary than this install's `current` one (a checkout's dev
  shim registered it); warns on downgrade, skips reinstall if already on target version

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
| `pwa/src/hooks/use-update-check.ts`               | Newest stable release on GitHub (rule of `termote update`)    |
| `pwa/src/utils/app-update.ts`                     | Server version vs this page, reload banner, SW skip waiting   |
| `pwa/src/components/updates-section.tsx`          | Settings > Updates: running/newest version, update command    |
| `pwa/src/hooks/use-gestures.ts`                   | Hammer.js gesture handling                                    |
| `pwa/src/components/terminal-view.tsx`            | xterm.js terminal component (stream, resize, reconnect)       |
| `pwa/src/utils/terminal-bridge.ts`                | Drives the xterm.js terminal (key mapping, clipboard paste)   |
| `pwa/src/components/chat-view.tsx`                | Chat view of a pane running Claude Code (lazy-loaded)         |
| `pwa/src/components/chat-composer.tsx`            | Chat view message box                                         |
| `pwa/src/components/chat-tool-card.tsx`           | Chat view tool call: IN/OUT, an edit's diff, shown capped     |
| `pwa/src/utils/line-diff.ts`                      | Line diff of an edit's old and new text, its summary          |
| `pwa/src/components/chat-attachments.tsx`         | Images attached to the next Chat message, above the box       |
| `pwa/src/chat-agents.ts`                          | Agents with a Chat view (claude, codex) and with input        |
| `pwa/src/components/start-agent-panel.tsx`        | Chat view of an idle pane: start Claude Code or Codex         |
| `pwa/src/hooks/use-start-agent.ts`                | Sends a start, follows it (`GET agent/start`), toasts         |
| `pwa/src/utils/agent-start.ts`                    | Whether an agent can be started in the pane on screen         |
| `pwa/src/components/read-only-bar.tsx`            | Bottom bar without input (View only, a read-only chat)        |
| `pwa/src/components/prompt-card.tsx`              | Claude Code dialog as a card (answer buttons or read-only)    |
| `pwa/src/hooks/use-agent-transcript.ts`           | Polls a pane's transcript, one store per pane                 |
| `pwa/src/hooks/use-agent-prompt.ts`               | Polls a pane's open dialog, one store per pane                |
| `pwa/src/components/files-view.tsx`               | Files view: the pane's directory as a tree, opens a file      |
| `pwa/src/components/changes-view.tsx`             | Changes view: git status grouped, a file's diff, edits it     |
| `pwa/src/components/file-editor.tsx`              | A file's text in a textarea, why a save failed                |
| `pwa/src/components/new-file-dialog.tsx`          | Files: asks for a new file's path, creates it, says why not   |
| `pwa/src/components/group-dialog.tsx`             | New tmux session / workspace: name, directory, why refused    |
| `pwa/src/components/file-search.tsx`              | Files: find a file by name under the root, results, switch    |
| `pwa/src/components/delete-file-dialog.tsx`       | Files: asks before a delete, second ask for a permanent one   |
| `pwa/src/components/markdown-preview.tsx`         | Markdown file rendered in Files/Changes (links, code blocks)  |
| `pwa/src/components/table-preview.tsx`            | CSV/TSV as a table: delimiter, header, filter, sort, Records  |
| `pwa/src/components/table-grid.tsx`               | Virtual grid of a table (sticky header and row numbers)       |
| `pwa/src/components/cell-sheet.tsx`               | One cell's whole value, unsafe characters shown, Copy         |
| `pwa/src/components/cell-edit-sheet.tsx`          | A cell being edited: its value, add/delete row, Apply         |
| `pwa/src/hooks/use-csv-table.ts`                  | Parses a table and its view, in a worker past 256 KiB         |
| `pwa/src/utils/csv-parse.ts`                      | RFC 4180 parser keeping each cell's range, delimiter sniffing |
| `pwa/src/utils/csv-patch.ts`                      | Edits of a CSV as patches of cell ranges (cell, row)          |
| `pwa/src/utils/csv-edits.ts`                      | Table edits as ops: undo/redo, reapplied by row values        |
| `pwa/src/utils/csv-parse-client.ts`               | The table's worker: timeouts, falls back to the main thread   |
| `pwa/src/utils/unsafe-chars.ts`                   | Control, bidi and zero-width spaces (strip or show)           |
| `pwa/src/components/image-preview.tsx`            | One image of Files/Changes (sizes, why it cannot be shown)    |
| `pwa/src/components/image-compare.tsx`            | Changes: an image's old and new versions side by side         |
| `pwa/src/hooks/use-image-blob.ts`                 | Reads `files/raw` into a `blob:` URL (SVG: `data:`), revokes  |
| `pwa/src/components/panel-toggles.tsx`            | Desktop header toggles of the side panel (Files, Changes)     |
| `pwa/src/hooks/use-files.ts`                      | File tree of a pane's root, one store per pane                |
| `pwa/src/hooks/use-git-changes.ts`                | Polls a pane's git status, one store per pane                 |
| `pwa/src/utils/highlight.ts`                      | Syntax highlighting through a Shiki worker, with a timeout    |
| `pwa/src/utils/upload-image.ts`                   | Uploads an image to the host, picks one, error messages       |
| `pwa/src/hooks/use-chat-attachments.ts`           | Images attached to a Chat view message (upload, ids, errors)  |
| `pwa/src/hooks/use-agent-commands.ts`             | A pane's custom slash commands, read once and cached          |
| `server/main.go`                                  | Entry point (`serve` runs the server, no args opens the menu) |
| `server/serve.go`                                 | Server (PWA static files, auth, guards)                       |
| `server/mux.go`                                   | `Mux` interface + `/api/mux/*` routes                         |
| `server/mux_tmux.go`                              | tmux/psmux backend                                            |
| `server/mux_groups.go`                            | `/api/mux/groups*`: create, rename, close a group; cwd check  |
| `server/mux_herdr.go`                             | Herdr backend                                                 |
| `server/stream.go`                                | Terminal WebSocket (`/api/mux/stream`)                        |
| `server/agent.go`                                 | `/api/mux/panes/{id}/agent/*` routes, transcript reads        |
| `server/agent_claude.go`                          | Claude Code transcript (JSONL) and session file               |
| `server/agent_claude_prompt.go`                   | Reads a Claude Code screen: input box, dialogs                |
| `server/agent_input.go`                           | Sends a message, answers a dialog (checks before each write)  |
| `server/agent_commands*.go`                       | `agent/commands`: custom commands, skills, plugin commands    |
| `server/agent_start.go`                           | `agent/start`: starts Claude Code/Codex in an idle Herdr pane |
| `server/agent_codex.go`                           | Codex rollout (JSONL): locate, parse, turn status             |
| `server/agent_codex_prompt.go`                    | Reads a Codex screen: composer, approval dialogs              |
| `server/agent_proc_codex.go`                      | Finds the Codex process holding a rollout (tmux, Herdr)       |
| `server/files.go`                                 | `/api/mux/panes/{id}/files/*` routes, tree and file contents  |
| `server/files_root.go`                            | Pane root (git toplevel), safe git runner                     |
| `server/files_git.go`                             | git status and diff for the Changes view                      |
| `server/files_sensitive.go`                       | Names of files that usually hold secrets                      |
| `server/files_raw.go`                             | `files/raw`: an image's bytes (worktree, or a git version)    |
| `server/files_write.go`                           | `PUT files/content`: saves a text file (baseHash, rename)     |
| `server/files_create.go`                          | `POST files/create`: an empty file, never replacing anything  |
| `server/files_find*.go`                           | `GET files/find`: file lists (git, walk), cache, ranking      |
| `server/files_delete.go`                          | `POST files/delete`/`restore`, `content?hash=1`               |
| `server/files_trash*.go`                          | Trash store, sweep, no-replace rename/rmdir by descriptor     |
| `server/agent_proc*.go`                           | Finds Claude Code (or Codex) under a tmux/psmux pane          |
| `server/guard.go`                                 | Host allowlist + Origin/Content-Type write guard              |
| `server/login.go`                                 | Sign-in form for browsers (iOS home-screen app has no prompt) |
| `server/uploads.go`                               | `/api/mux/uploads`: image store (naming, quota, retention)    |
| `server/security_headers.go`                      | Content-Security-Policy and other security headers            |
| `server/serve_config.go`                          | Server config from the saved config, else the environment     |
| `server/install_layout.go`                        | Versioned install layout (`versions/<v>`, `current`, prune)   |
| `server/tailscale.go`                             | `tailscale serve` mapping (apply/remove, never sudo)          |
| `server/release_tags.go`                          | Picks the newest published stable 1.x release                 |
| `server/cli_start.go`                             | `start`/`stop`/`restart`: options, service registration       |
| `server/cli_service*.go`                          | OS supervisor registration (systemd/launchd/Scheduled Task)   |
| `server/cli_container.go`                         | `container up/down/logs/status`                               |
| `server/cli_url.go`                               | `status --json`, `url` (deep link, open, copy, QR)            |
| `server/cli_panel.go`                             | `panel`: the Herdr plugin's popup                             |
| `server/listener_owner*.go`                       | Saved password sent only to the current user's listener       |
| `server/push_routes.go`                           | `/api/mux/push/key`, `/api/mux/push/subscribe`                |
| `server/push_store.go`                            | VAPID key + subscriptions (`<stateDir>/push`, allowlist)      |
| `server/push_watch.go`                            | Agent status transitions → Web Push (queue, back-off)         |
| `server/webpush.go`                               | aes128gcm + VAPID sender, hardened HTTP client                |
| `server/testdata/agent-transitions.json`          | Transition cases shared by the PWA and the server             |
| `pwa/src/utils/agent-notify.ts`                   | When an agent notifies, and the notification's text           |
| `pwa/src/hooks/use-agent-notifications.ts`        | Notifies from the open page (no confirmed push)               |
| `pwa/src/hooks/use-push-subscription.ts`          | This device's Web Push subscription, repaired                 |
| `pwa/public/notify-sw.js`                         | SW handlers: push, notification click, resubscribe            |
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
- **Logout** (`POST /api/mux/logout`, handled in `basicAuth`): a JSON write under `writeGuard`;
  removes the cookie's session from the store and expires the cookie (204), needs no
  credentials and counts as no failed login. The snapshot's `caps.auth` (set from the request
  `basicAuth` let through) tells the PWA to offer Log out. A cookie is never bound to a port:
  every service on the same host name receives it, so the docs tell users to give Termote a
  host name of its own (accepted risk; no `__Host-` prefix, which would not change that)
- Basic auth over HTTPS required for production
- **Sign-in form** (`/login`, `server/login.go`): a browser page load without a session gets
  a 401 with a plain HTML form (no script) and no `WWW-Authenticate`, since an iOS home-screen
  app never shows the Basic prompt and the prompt would otherwise sit on top of the form; only a
  client without `Sec-Fetch-Mode` (curl) is still challenged. The form POST must be urlencoded,
  at most 8 KB, not cross-site (`Sec-Fetch-Site`, or an `Origin` off the allowlist other than
  `null`, which the form itself sends under `no-referrer`), shares the Basic auth rate limiter and sets
  the same session cookie; `next` is kept only as a path on this server. The PWA opens `/login`
  when the snapshot or health read answers 401, and the service worker never serves its shell
  for `/login`
- termote binds to `127.0.0.1` by default; only `--lan` makes it listen on `0.0.0.0`
- **Host allowlist** (`hostGuard`): requests with an unrecognised `Host` header get a 403; the
  allowed set is loopback + (with `--lan`) the address the request arrived on, so it keeps
  working as the LAN IP changes + the Tailscale name + `--allow-host` entries, with no
  wildcard to disable the check
- **Write/CSRF guard** (`writeGuard`): state-changing `/api/mux/*` requests must be
  same-site (`Sec-Fetch-Site`/`Origin` on the allowlist) with `Content-Type: application/json`
- **Terminal stream** (`/api/mux/stream`): same Origin check plus a single-use, 30s-TTL token
  fetched via `/api/mux/stream-token`, consumed on WebSocket upgrade. Every paste into the
  terminal (native paste events are taken in capture phase, ahead of xterm) goes through
  `cleanPaste` in `terminal-view.tsx`: end-of-paste markers and control characters other than
  tab and line breaks removed, since xterm brackets a paste without removing a marker inside it
- **Herdr guard**: `--mux herdr --no-auth` is refused unless `--allow-herdr-no-auth` is also
  given, since Herdr exposes every workspace on the host
- **Pane processes** (`server/mux_process.go`): the snapshot carries each pane's foreground
  process `{name, cwd}`; tmux tabs also carry every pane's in `processes` (the snapshot holds
  only the window's active pane). The name is the first word of what the OS reports (cut at
  whitespace, `=` or `:`, then after the last `/`; a process can set its own title), at most 32
  bytes, control and format characters (zero-width, bidi) removed; argv and the environment never
  leave the server. tmux: one `list-panes -a`, read by `#{n:}` byte lengths keyed by session id and
  window index (a path can hold `\n` or `:`; psmux numbers panes per session), with `-u` on
  tmux. Herdr: `pane.process_info`, decoding only pids and names (never `argv`, `argv0`,
  `cmdline`), through a 5 s cache with one refresher, 4 calls at once within 1.5 s, never under
  `fetchMu` and never into the cached view; a name whose reads failed for 15 s, or any while an
  `invalid_request` turned the calls off for 5 minutes, is not served. macOS names are the kernel's short name. The
  snapshot is a same-site read (`crossSiteRejection`, `Sec-Fetch-Site: none` included). The PWA
  shows names in the sessions list and pane strip and adds "Running: …" to the close
  confirmations; the cwd is not shown
- **Groups** (`POST /api/mux/groups` `{name, cwd}` → `{ok, id}`, `PATCH /api/mux/groups/{id}`
  `{name}`, `DELETE /api/mux/groups/{id}`; `server/mux_groups.go`, `caps.groups`): auth,
  `hostGuard`, `writeGuard` (same-site JSON), 8 KB body, `requireWriteRole` first (a stub until
  #236, which must refuse all three), `muxTimeout`; creates, renames and closes run one at a time
  (one mutex), with no cap on the number of groups. Errors the handler or backend raises carry a
  `code` (`invalid_name`, `invalid_cwd`, `not_found`, `not_directory`, `not_allowed`, `busy`,
  `invalid_group_id`, 404 `unknown_group` also when the group vanishes between check and command,
  409 `exists`/`default_session`/`has_worktrees`, 501 `unsupported`), through the shared
  `codedError` (also the uploads' and `files/raw`'s); guard and JSON errors keep `{error}` without
  one. The name is 1–64 bytes, no control character, no trailing `;`; tmux also refuses `:` `.`
  `*` `?` `[` `\` (stored escaped) and a leading `=` or `-` in a new session's name. The `cwd` check is against
  mistakes, **not a security boundary** (the shell that opens can `cd` anywhere; signing in is
  the boundary): empty → the server user's home, absolute only, on Windows only `X:\…` (a UNC
  `\\host\share`, `\\?\` or `\\.\` would make the stat send the NTLM hash to that host),
  `EvalSymlinks` + `Stat` in a goroutine bounded by `muxTimeout` (a hung mount → 503 `busy`; a local symlink to a UNC path still reaches it, an accepted gap:
  only someone with the host can make one), and
  neither the path nor its resolved form under the files deny list (`files.deny`); the resolved
  path goes to the backend through argv/RPC, never a shell. tmux expands formats in
  `new-session -s`, `-c` and `rename-session`, running `#()` through `/bin/sh`: name and `cwd` go
  through `tmuxLiteral` (`#` doubled), and the new session's name and `session_path` are read back
  (anything else → `kill-session`, 500); psmux, unchecked, refuses `#` in both. A new session gets
  `terminalEnv()`, is checked to be free by exact name in `list-sessions`, and is addressed by its
  `$N` (`-P -F '#{session_id}'`); close and rename find it by exact id/name first. The default
  session cannot be renamed (409 `default_session`); closing it is allowed (the next snapshot
  makes it again, empty, and the PWA's confirmation says so). Herdr: `workspace.create`
  `{label, cwd, focus:false}`, `workspace.rename`, `workspace.close` without `close_group` (linked
  worktrees → 409 `has_worktrees`, closed in Herdr), `workspace_not_found` → 404 (Herdr answers a method it lacks with
  `invalid_request`, so an older Herdr gets a 500, not 501). A request that waited past
  `muxTimeout` for another group change gets 503 `busy`. Closing a group ends every process in it
- **tmux sessions**: every session on the tmux server is a group, the user's own ones made
  outside Termote included, so anyone signed in sees, switches to and types into them (as Herdr
  exposes every workspace; accepted). `TMUX_SESSION` (default `main`; no `:`, `.`, leading `=`
  or `$`) keeps group id = its name and bare tab ids (`0`), so links, saved selections and E2E
  keep working; any other session is tmux's own session id: group `$3`, tab/pane `$3:1`, which
  a rename keeps and a tmux server restart changes. A window name is never an id. Every command
  targets exactly: `$N:=i`, or `=<TMUX_SESSION>:=i` (each `=` turns off tmux's prefix and
  pattern matching, so `ma` never reaches `main` nor a missing index 9 a window named `9x`), and
  `new-window -t <session>:`; psmux (Windows, `tmuxIsPsmux`) has no `=` before an index and
  never matches a window name, so it gets `$N:i`/`=<TMUX_SESSION>:i`, `SelectTab` checks the
  window with `display-message` first (psmux's `select-window` exits 0 on a missing one), and
  the agent routes read and type into that window (`$N:i` from psmux's reply, so one window has
  one pane lock) instead of `%N` (psmux numbers panes per session, `-t %1` reaches the most
  recent one); the default session's existence is checked by exact
  name in the `list-windows -a` reply, and `ensureSession` uses `has-session -t =<name>`.
  `display-message` (agent routes, Files) asks for `#{session_id}`/`#{session_name}` with the
  window index and refuses a reply that is not the window asked for: tmux answers a missing
  target with another window or nothing. A stream runs `attach -E -t <$N|=name>`; the macOS
  reaper matches exactly that, plus `attach -t <TMUX_SESSION>` left by older releases, never a
  user's own `tmux attach`
- **Agent chat** (`/api/mux/panes/{id}/agent/*`): for Claude Code on tmux the server reads only
  the transcript in the Claude config dir of the process found in the pane (`CLAUDE_CONFIG_DIR`,
  else `~/.claude`; psmux: `%USERPROFILE%\.claude`), and only for a process whose start time
  matches its session file's `procStart`; Herdr reports the session id itself, read from the
  server user's config dir. The session id must be a UUID. Every write (Claude Code or Codex)
  takes a lock on the pane, re-checks the process, session and screen, and sends nothing unless
  the screen shows the expected state (an empty input box, the dialog the client saw with a
  single-use `promptId`). Claude Code writes its transcript only with the first message: until
  then `transcript` answers an empty conversation whose cursor names the session, so the Chat
  view can send it.
  `agent/message` may carry `images`: at most 5 upload ids, each resolved through the upload
  store (a path is never taken from the client; unknown ids → 400 with the bad ids, no store →
  503 `uploads_unavailable`). Each path is pasted alone and the draft must show that many
  `[Image #N]` tokens (11s wait each) before the next, then the text, then Enter, with the
  process and session re-checked between pastes. If a step fails after the first paste, the
  box is cleared with one `C-c` only when the same idle agent shows nothing but what this
  request pasted; otherwise 409 `partial_paste` and nothing is touched.
  Markdown images in the Chat view never load (shown as links), and raw HTML is not rendered.
  A tool call carries `detail` for its card: the model's description, a Bash/Codex command whole
  (8 KiB) and an Edit/MultiEdit/Write's old and new text (16 KiB per call); the edits of a file
  `isSensitive` names are left out (`hidden`), as its diff is in Changes.
  `agent/commands` (the composer's `/` suggestions) returns only names, descriptions, sources
  and kinds of `.claude/commands`/`.claude/skills` under the pane root and `commands`/`skills`
  in that config dir, read through `os.Root` (first 8 KB per file; a file that is a symlink, under
  a denied dir or with a sensitive name is never read), with the same
  `Sec-Fetch-Site`/`Origin` check as the files routes. A symlinked skill dir is followed only
  into that config dir, the pane root or `~/.agents/skills`. Plugin commands come from the
  plugins `installed_plugins.json` lists and `enabledPlugins` (user, project, local settings)
  turns on; an `installPath` is read only when it resolves inside `<config dir>/plugins/`
  (at most 50 plugins, JSON files capped at 1 MB)
- **Starting an agent** (`POST /api/mux/panes/{id}/agent/start` `{kind}`, `GET` of the same path,
  `server/agent_start.go`, `caps.agentStart`: Herdr ≥ 0.8.2 from the subscription's `ping`, never
  on Windows, whose idle check is unverified): `writeGuard` (same-site JSON), `requireWriteRole`
  (the view-only role, #236, must refuse it; a view-only client is kept from it only in the UI
  meanwhile), 8 KB body. Only `kind` is decoded (`claude` → no arguments, `codex` →
  `--no-daemon`, else 400 `invalid_kind`); arguments and the Herdr alias
  (`termote-<kind>-<8 hex>`, one retry on `agent_name_taken`) are the server's. The pane is
  resolved (`requirePane`) before the pane lock, the one message/answer take, so the locks map
  holds only existing panes (404 `not_found`). Under it: a start of this server still running
  there → 409 `starting`; the pane must be an idle shell (`paneIdleShell`: one foreground
  process, the shell, leading its group, a `knownShells` name, shared with the PWA through
  `server/testdata/known-shells.json`), read again every 250 ms for 1.5 s, else 409 `pane_busy`
  with nothing sent; `agent.get` on the pane id: Herdr holds a start pending until its deadline
  even when the command failed at once, and lets an expired one go only when it is read (this
  read does), so one still held → 409 `start_pending` with nothing sent; then `C-c` (clears half-typed text, a `PS2` line, a heredoc, a `read`),
  200 ms, the idle check again (409 `pane_busy`), then `agent.start` with `timeout_ms` 30000.
  Each Herdr call has its own `muxTimeout`; the whole start runs without the request's
  cancellation once begun. Herdr answers at once (`launch_pending`): 200 `{ok, state:
  "starting"}`; `agent.start` timing out → 504 `start_unknown`, followed as if typed. Herdr's
  `agent_pane_busy` → 409 `pane_busy`, `agent_pane_not_found`/`agent_pane_unavailable` → 404,
  `unsupported_agent_kind` and an older Herdr's `invalid_request` naming `agent.start` → 501
  `unsupported`, anything else 500 `start_failed` (logged, never Herdr's text). `GET` (same-site
  read) reads `agent.get` by the alias: `ready` (`interactive_ready`), `blocked`, `exited` (alias
  gone, another agent, `launch_pending` false, or no agent seen and the pane an idle shell again
  4 s after the start: the command failed), `timeout` 35 s after the start, or 404 `no_start`; a final state is kept 60 s, and a refused start leaves it. Accepted gaps: stream input from another client is not
  under the pane lock and can land between `C-c` and the command; a refusal decided by Herdr
  comes after the `C-c`. The PWA offers it in the Chat view of an idle pane and polls the `GET`
  every 2 s; Codex writes no rollout before its first message, so after a Codex start the Chat
  view asks for that message in the terminal
- **Codex chat**: a rollout is read only when a process whose executable is named
  `codex`, without `app-server` in its argv, holds it open for writing as a regular
  `rollout-*-<uuid>.jsonl` inside its own `CODEX_HOME/sessions` (resolved), with exactly one
  such rollout of a user thread; its dev:inode is checked again after opening. Herdr's session id
  is trusted only when such a process holds that rollout. So only `codex --no-daemon` has a Chat
  view (the shared daemon writes every pane's rollout), `/new` gives 404 on tmux until Codex
  restarts, and Windows has none. `message` and `answer` write under the Claude Code rules: the
  pane lock (keyed by the pane address alone), then the process, session, rollout (path and
  dev:inode) and screen read again right before each write. A message is pasted (bracketed)
  only onto an empty composer with no working line and status idle/done, and must show in the
  composer (`[Pasted Content N chars]` over 1000 characters) before Enter. An approval dialog
  (run a command, make edits) is answerable only on Herdr, where Herdr reports the agent
  blocked: the option goes as its digit, Cancel as Escape. On tmux the rollout records no
  approval request, so `prompt` answers `unsupported` with no options or `promptId`
  (`AgentSession.DialogsReadOnly`), as it does for any other Codex dialog. The screen reader
  (`server/agent_codex_prompt.go`) never takes text the model printed above the composer for a
  dialog, and reads a card as read only when two approval titles sit in its stretch. `commands`
  is empty
- **Files/Changes** (`/api/mux/panes/{id}/files/*`): GETs that also check
  `Sec-Fetch-Site`/`Origin` (and one write, `PUT files/content`, below); every path is opened through `os.Root` under the pane's root (its
  git toplevel when a `.git` sits at it, else its directory); termote's config/state dirs, the
  upload store and the trash (a pane in the home dir would otherwise serve a deleted `.env` under
  its random name),
  `/proc`, `/sys`, `/dev`, `.git` and the repo's git dir (`--separate-git-dir`) are never served
  (on Linux a path differing only in case is denied when its directory is the same one: WSL
  `/mnt/c`, casefold, vfat);
  sensitive names (`.env`, keys, ...) return contents or a diff only with `reveal=1`. git runs
  without a shell, with `GIT_*`/`TERMOTE_*` stripped, hooks (`core.hooksPath` to the null
  device), index refresh on diff, fsmonitor, filter drivers, external diff and textconv off,
  submodules ignored, 10s timeout, 2 at a time.
  `files/raw` serves an image's bytes (Files: the worktree file, streamed from the open handle;
  Changes: `side=old|new` of an entry git status lists, picked like `diff`, never a client rev):
  the index is always `:0:<path>` (git reads `:1:a.png` as stage 1), `HEAD:<orig‖path>` for the
  staged old side, read by one `git cat-file --batch` (no filters, not `heavy`: no status/diff
  slot, no backoff; a name with `\r` or `\n` → 400, missing → 404 `no_version`, time out → 503). The type
  comes from the first bytes through `imageTypeOf` (shared with uploads: PNG/JPEG/GIF/WebP), plus
  SVG only for a `.svg` path whose first element is `<svg`; 10 MiB (413 `too_large`), 40 MP
  (PNG/JPEG header, a GIF's largest frame with its offset, a WebP's first chunk; 413
  `too_many_pixels`), else 415 `not_image`, a Git LFS pointer 415
  `lfs_pointer`, a sensitive name without `reveal=1` 403 `sensitive`. 4 at a time server-wide
  (429 `busy`), 2-minute write deadline, `Cross-Origin-Resource-Policy: same-origin`,
  `Cache-Control: no-store`; an SVG also gets a second CSP
  (`sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:`) and
  `Content-Disposition: attachment`
- **Saving a file** (`PUT files/content?root=`, `server/files_write.go`): replaces the whole text
  of an existing file (a new one comes from `POST files/create`, see Creating a file). `writeGuard` (same-site JSON) plus the handler's own cross-site check and
  `requireWriteRole`; the `root` query is required (400, 409 once it moved). Body
  `{path, baseHash, text, reveal}`: bytes on disk other than `baseHash` (GET `content`'s `hash`,
  sha256) → 409 `changed`, unless they already equal the text (200: a repeated save is no
  conflict); never an overwrite. The read's path checks plus a write-only deny list (the
  install's data dir, the upload store); a sensitive name needs `reveal: true` (403
  `sensitive`). No component of the path may be a symlink; the parent is opened once through
  `os.Root` and used for every step. The file must be regular, one link, owned by the server user
  (Unix), owner-writable, UTF-8 without NUL, line breaks all `\n` or all `\r\n` (422
  `not_editable` + `reason`, or 403 `permission`; writing the new text on a read-only mount → 403
  `read_only`, on a full disk or quota → 507 `storage_full`, as a create); GET `content` reports the same check as
  `editable`/`notEditable`. Text arrives with `\n` (a `\r\n` file gets them back), NUL or a lone
  `\r` → 422 `not_text`, at most 1 MiB (413 `too_large`); body limit 6 MiB + 64 KiB, 2 saves at a
  time (429 `busy`), read deadline 5 minutes once authenticated with a slot. Written to
  `.termote-edit-<random>` in the same directory (`O_EXCL`, mode set on the handle, `fsync`),
  the file read again, then renamed over it; the temporary file goes on any failure, ones older
  than 10 minutes are swept (only names of that exact form), every `.termote-edit-*` name is
  sensitive, and a save drops the root's cached git status. Saves of one file are serialised; an agent writing between the last read and the rename still loses its change (no
  compare-and-swap), and the rename drops ACLs/xattrs. A view-only client is kept from editing in
  the UI only while `requireWriteRole` is a stub. The draft stays in the PWA's memory, never in
  browser storage
- **Creating a file** (`POST files/create?root=`, `server/files_create.go`): an empty file and
  the directories missing above it (0666/0777 under the umask; directories made before a later
  failure stay, as with `mkdir -p`); the text then goes through `PUT files/content`. Same guards
  as a save (`writeGuard`, the handler's cross-site check, `requireWriteRole`, `root` required:
  400, 409 once it moved); the body (`{path, reveal}`, 8 KB) is read first, and its read deadline
  stays 60s; 201 `{root, path}`. The name is checked
  before the disk is touched (400 `invalid_name`): no empty component, at most 32 components and
  1024 bytes, 255 a component, none ending in a dot or a space, no control character, no
  `<>:"|?*` on Windows, not a
  `.termote-edit-<16 hex>` name, then `cleanRelPath`. Deny dirs, `.git`/the git dir and the
  write-only deny list → 403 `not_allowed`; a sensitive name needs `reveal: true` (403
  `sensitive`; the PWA asks once, then opens the editor without a Show). One lock per root, taken
  before one of the 2 write slots shared with saves (429 `busy`), so a create waiting on another
  holds no slot a save could use; each
  directory is opened from the one before (`Lstat`, `Mkdir` when missing, `OpenRoot`, then
  `SameFile` with what was checked): a symlink, a Windows junction (Go reports it irregular) or a
  directory swapped in → 403 `symlink`, a
  parent that is a file → 409 `not_directory`, EACCES → 403 `permission`, EROFS (Windows
  `ERROR_WRITE_PROTECT`) → 403 `read_only`, ENOSPC/EDQUOT (Windows disk full or quota) → 507
  `storage_full` (as uploads); each directory is
  checked against the deny lists again once it exists, before anything is made inside it (an 8.3
  name or a junction is only caught there). The file is opened `O_CREATE|O_EXCL` on its parent's
  handle: anything there, a dangling symlink included → 409 `exists` with the cleaned `path`
  (`/`-separated; Open it opens that), never replaced. A reply after the box was closed opens
  nothing, the tree is only read again. A create
  drops the root's cached git status. Accepted risk: a new file can be one another tool trusts
  or runs (`.claude/settings.local.json`, `.claude/commands/*.md`, `.vscode/tasks.json`,
  `.github/workflows/*`, a systemd/launchd unit when the root is the home dir); a signed-in user
  has a shell anyway, and the view-only role (#236) must refuse creates as well as saves. A
  view-only client gets no New file button only in the UI while `requireWriteRole` is a stub.
  The root's lock is keyed `root + "\x01create"`: `"\x00create"` was the key of a file named
  `create` at the root, and a delete takes both
- **Finding a file** (`GET files/find?q=&root=&ignored=1&exclude=…&fresh=1`,
  `server/files_find.go`): the GET guards of the other files routes; only names are sent, as
  the tree does. `q` is trimmed, 1–256 bytes; `exclude` (repeated) is at most 50 directory
  names of at most 255 bytes, never `.`/`..` nor holding `/ \` NUL `* ? [` (400
  `invalid_exclude`), compared without case on Windows/macOS. In a repo the list is
  `git ls-files -co --exclude-standard --deduplicate -z` less `ls-files -d` (files gone from the
  disk) and less what git lists as a directory (a nested repo, a submodule); tracked files are
  never filtered by `exclude`. `ignored=1` adds `git ls-files -o -i --exclude-standard
  --directory -z`, read and cached apart: a path with an excluded component is dropped unread,
  a directory git names whole is walked through `os.Root` without entering an excluded name at
  any depth. Outside a repo the root is walked the same way. A walk never enters a symlinked
  directory or a junction (irregular), lists a symlink only when `os.Root` stats it as a file,
  and is bounded per list: 200 000 paths, 32 levels, 5 s, git output 16 MiB → `incomplete`.
  Building a list drops `.git` components and paths under a deny dir or the git dir by name;
  the ranked results then pass `f.denied` (through symlinks) and an `Lstat` (gone or a directory
  → dropped) until 200 are kept (`truncated` past that). git runs as `heavy` with `noBackoff`: a
  timeout answers 503 but never makes Changes back off. Lists are built under
  `context.WithoutCancel` (the PWA aborts the previous request at each key), cached 30 s per
  root + `SafeDir` + kind (+ the sorted excludes; a failure is not kept), dropped by `forgetRoot` on a save, a create, a
  delete and a restore, and by `fresh=1` (the PWA's refresh)
- **Deleting a file** (`POST files/delete?root=`, `POST files/restore?root=`,
  `server/files_delete.go`, `server/files_trash*.go`): the guards of a create (`writeGuard`, the
  handler's cross-site check, `requireWriteRole`, `root` required), body read first (8 KB);
  then the root's lock, the file's lock (shared with saves) and a write slot without waiting
  (429 `busy`), then the trash's mutex: a save takes its slot before the file's lock, but a
  delete never waits on a slot, so they never wait on each other. Delete body
  `{path, kind: file|dir, baseHash, reveal, permanent}`: `.`/`""` → 400 `invalid_path`, the
  create's deny lists → 403 `not_allowed`, a sensitive name without `reveal` → 403 `sensitive`;
  the parents are opened one at a time without making any (a symlink, a junction or a swapped
  directory → 403 `symlink`, a missing one 404). A file must be regular (409 `not_file`), the
  one opened (`SameFile`), one link (409 `hardlink`), the server user's (403 `permission`), and
  its sha256 (streamed, at most 512 MiB, else 413 `too_large`) must equal `baseHash` (409
  `changed`). A record `<32 hex>.json` (`{root, path, kind, deletedAt, size, mode}`, `.part`
  0600 `O_EXCL` then rename) is written, then the file is renamed into
  `os.UserCacheDir()/termote/trash/<32 hex>` (0700, refused when a symlink or another user's →
  503 `trash_unavailable`, `Caps.trash` false) by directory descriptors (`renameat2`
  `RENAME_NOREPLACE`, `renameatx_np` `RENAME_EXCL`, else `linkat` + `unlinkat`; Windows
  `MoveFileEx` without `MOVEFILE_REPLACE_EXISTING` on paths checked first, an accepted gap: a
  local writer of the root has a shell anyway); what landed must be the file checked, or it
  goes back (never replacing) and 409 `changed` (with `trashId` when its name was taken again
  meanwhile). `EXDEV`/`ERROR_NOT_SAME_DEVICE` (WSL `/mnt/c`, a volume, the container's
  `/workspace` bind mount): 409 `cross_device`, nothing deleted, unless `permanent: true` (the
  PWA asks a second time): then the file is checked again (`SameFile`) and unlinked by
  descriptor, 200 `{permanent: true}`; `permanent` never skips a trash that works. An empty
  directory is removed by `unlinkat(AT_REMOVEDIR)`/`RemoveDirectory` (a file swapped in →
  409 `changed`; entries → 409 `not_empty`) after its record; the root never. Never
  `os.Root.Remove`, which unlinks before trying rmdir. Restore `{trashId, reveal}`: a 32-hex id
  (400), its record (404 `not_in_trash`), the record's root (409 with the root), its path
  checked as a create's but not its name (`a.` must come back), parents made, then renamed back
  never replacing (409 `exists` with `path`; `cross_device`); the trash's mutex is held from
  reading the record again to removing it. The sweep (at start and before every delete) ages an
  entry by `deletedAt` only, never the mtime a rename keeps: 7 days, then the oldest past 1 GiB,
  never one younger than an hour; names left half done (a payload or a record alone, a `.part`)
  go 10 minutes after the sweep first sees them; a payload that is the restored file itself (a
  `linkat` restore that died) is only unlinked; only `^[0-9a-f]{32}(\.json(\.part)?)?$` names
  are removed, never through a directory or a symlink. `GET files/content?hash=1` answers
  `{root, path, size, hash}` with no text for any regular file (no `hash` past 512 MiB), even a
  sensitive one not revealed, so deleting a `.env` never sends its secret to the browser
  (accepted risk: a short secret's hash can be guessed by a signed-in user, who has a shell);
  it takes one of the 4 `files/raw` slots (429 `busy`). `termote uninstall` keeps the trash
  (the user's files) and says where; `--purge` removes it. The view-only role (#236) must refuse
  deletes and restores; a view-only client gets no Delete only in the UI meanwhile
- **Image uploads** (`POST /api/mux/uploads`): the PWA sends an image so an agent can read it by
  path (the host clipboard is empty when the image sits on a phone). Same auth, Host allowlist,
  `Sec-Fetch-Site`/`Origin` check and `requireWriteRole` as every write; the body is a raw
  `image/png|jpeg|gif|webp` (`writeGuard` takes these types on this path only: `image/*` is not
  CORS-safelisted, so another site still needs the preflight; multipart stays 415, since a form
  posts it without one). At most 10 MB (a larger `Content-Length` is refused unread); once
  authenticated and given a slot its read deadline grows to 5 minutes; the type is read
  from the first bytes and must equal the declared one; the name is random (`<32 hex>.<ext>`,
  the client's name is never read), written to a `.part` (0600, `O_EXCL`) then renamed, in
  `os.UserCacheDir()/termote/uploads` (`serveConfig.UploadDir`, set by `serve`): created 0700,
  refused when a symlink or (Unix) owned by another user, and then uploads answer 503
  `uploads_unavailable`. 2 uploads at a time (429 `busy`); 10 MB is reserved against a 200 MB
  quota before writing (507 `storage_full`); files older than 7 days go, then the oldest when
  over quota, never one younger than an hour; only the store's own names are ever deleted.
  Errors carry a JSON `code`. The Chat view sends the returned ids in `agent/message` (see
  Agent chat). `Caps.uploads` tells the PWA (snapshot); a view-only client
  offers no upload, enforced in the UI only while `requireWriteRole` is a stub. The container
  creates `/home/termote/.cache` and `/home/termote/.config` mode 1777 so the host uid can
  create its upload dir and the generated password's file (kept out of the log). The store is
  never served by the Files view, even when a pane's root holds it
- **Notifications / Web Push** (`/api/mux/push/*`, `caps.push`): the setting "Notify when an
  agent needs me" notifies when an agent becomes `blocked` or ends a turn (`working` →
  `done`/`idle`; a missing or `unknown` status keeps the last known one, a pane without an
  agent forgets it (tmux answers a slow lookup with the last agents found, not none), a first
  sighting never notifies; the PWA and `server/push_watch.go` share `server/testdata/agent-transitions.json`).
  `GET push/key` (auth, `hostGuard`) returns only the public key; `POST`/`DELETE push/subscribe`
  go through `writeGuard` (same-site JSON), `requireWriteRole` (the view-only role, #236, must
  refuse them) and the 8 KB body limit, answer 200 `{ok}` (400 `invalid_endpoint`/`invalid_keys`,
  503 `push_unavailable`), and no route lists or echoes a subscription. Endpoints must be HTTPS
  on 443 at `fcm.googleapis.com`, `updates.push.services.mozilla.com`, `web.push.apple.com`,
  `*.push.apple.com` or `*.notify.windows.com` (no IP literal, no userinfo, 2048 bytes), checked
  at subscribe, at load and before each send; the dialled address must be public (`Dialer.Control`
  after DNS: no loopback, private, link-local, CGNAT, ULA, unspecified, multicast or IPv4-mapped),
  no proxy, no redirects. The payload is ids only (`{groupId, tabId, paneId, kind}`, aes128gcm,
  VAPID ES256 with `sub` `https://termote.ohnice.app` and 12 h tokens, stdlib only); `Topic` is an
  HMAC of pane and kind under a random key and `Urgency` is `high` for both kinds, so the push
  service learns neither. The service worker reads the names from the snapshot (3 s) and strips
  C0/C1, bidi and zero-width space characters (64 characters max); `Pane.Title` is never used; every push shows a
  notification (Safari revokes silent ones). State: `<stateDir>/push` (0700; `vapid.json` and
  `subscriptions.json` 0600, owner-only ACL on Windows, `%LOCALAPPDATA%` so it does not roam, no
  DPAPI), already on the Files deny list; at most 20 subscriptions, the least recently subscribed
  evicted; each bound to `gen` = HMAC(bindKey, user + password), so `start --fresh` or a new
  password drops every device until it signs in again (its page re-subscribes). Only 404/410
  drop a subscription; 401/403 are logged and kept ("check the server clock" when all fail);
  429 and timeouts back the push service off (`Retry-After`, at most 1 h). The watcher runs only
  from `runServer`, every 5 s and only with a subscription, reading tmux through `peekSnapshot`,
  which reads the sessions there and never recreates the default one; the service worker names a
  push from `snapshot?peek=1`, which reads the same way. The PWA subscribes only while the active
  worker answers version 2 (`notify-sw.js` has the push handler), and repeats the subscribe POST
  on load, every 10 minutes while shown and when shown again. Log out deletes this device's subscription first.
  The CSP is unchanged: the server, not the page, talks to push services. The container opens
  `/home/termote/.local/state` 1777 like `.cache`/`.config`
- Exclude sensitive dirs (.ssh, .gnupg, .aws, .config/gcloud) from container volume mounts
  (warned at `container up`)
- Serve mode uses constant-time comparison for password verification
- **Brute-force protection**: built-in rate limiter (5 failed attempts/min per IP → 429, and
  20/min per IPv6 /64 so a host cannot take a new address for each try); the check and the
  count are one step, so a concurrent burst gets no more than 5 tries. Failed logins and
  blocked clients are logged with the client address (never the credentials), at most one
  line per 10s each
- **Server hardening**: ReadHeaderTimeout (Slowloris protection), a 60s read deadline on every
  request, the terminal stream's handshake included (a body sent a byte at a time; hijacking the
  connection for the WebSocket clears it); an authenticated image upload
  extends it to 5 minutes (a slow mobile link), at most 256 sessions (the
  least recently used is dropped), request
  body size limits (8KB on `/api/mux/*`, 64KB on `agent/message`)
- **CLI and the saved password**: `status`, `url`, `panel`, `container status` and the health
  wait of `start`/`restart`/`update` send the saved password to `127.0.0.1:<port>` only when
  every socket listening on it runs as the current user or root/SYSTEM (`server/listener_owner*.go`:
  `/proc/net/tcp*` on Linux, `lsof` on macOS, the TCP table and process SID on Windows), checked
  once the connection is made and before the request is written on it; on Linux the server end
  of that connection (its uid in `/proc/net/tcp*`) must be trusted too; otherwise
  the status reads "untrusted listener" (another user's socket seen) or "unverified listener"
  (the port answers but no listener is seen: a runtime forwarding it without a proxy process,
  macOS without `lsof`)
- **Error sanitization**: internal errors logged server-side only, generic messages returned to clients
- **Content-Security-Policy** (`server/security_headers.go`): on every response, `script-src 'self'`
  plus the `sha256` of the inline theme script in the served `index.html` (hashed at startup,
  so a changed `TERMOTE_PWA_DIR` page needs a restart), `style-src 'self' 'unsafe-inline'`,
  `img-src 'self' data: blob:` (`blob:`: images the PWA read from `files/raw`; an SVG is shown as a `data:` URL, never a `blob:` one, which opened in a tab would be a document of this origin), `connect-src 'self'` + `ws://`/`wss://` of the request's `Host` (a
  name or IPv4) + `https://api.github.com`, `worker-src`/`manifest-src 'self'`,
  `object-src 'none'`, `base-uri`/`form-action 'self'`, `frame-ancestors 'none'`; plus
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`.
  Every E2E spec imports `test` from `pwa/e2e/fixtures.ts`, which fails a test on any CSP
  violation
- **Release integrity**: `release.yml`'s release job runs in the `release` environment (the
  maintainer approves each release; it holds `RELEASE_SIGNING_KEY`), writes `image-digest.txt`
  (the pushed image by digest) into `checksums.txt`, signs it with `openssl pkeyutl` and checks
  the signature with the key `install.sh` pins. `update` and `install.sh` (OpenSSL 3) refuse a
  1.10.0+ release whose signature does not verify; `container up` runs the image by that digest.
  Immutable releases are on for the repo, so assets and tags cannot change after publishing.
  `release-please.yml` starts `release.yml` with `workflow_dispatch` on the tag, never as a
  called workflow: a `workflow_call` job does not get the environment's secret (actions/runner#1490)
- **Tailscale mapping**: `serve` removes its `tailscale serve` mapping when it stops (only while
  it still proxies to its port), so the name never leads to a free port another user could take;
  `start --lan` warns when lingering is off (the port is free while the user is logged out)
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
