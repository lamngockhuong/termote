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
| Sessions        | tmux/psmux, Herdr workspaces or Zellij sessions (native or container)    |
| Package Manager | pnpm                                                                     |

## Project Structure

pnpm workspace: `pwa/` (React PWA), `server/` (Go server + CLI, one binary embedding the built PWA from
`server/webui/`), `website/` (Astro Starlight docs, EN + VI), `video/` (Remotion), `scripts/` (release
installers, dev shims, hooks), `tests/` (shell/PowerShell tests), `herdr-plugin/`. Directory map:
[`docs/codebase-summary.md`](docs/codebase-summary.md); where each feature lives:
[`docs/key-files.md`](docs/key-files.md).

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
termote start --mux zellij                 # native, Zellij backend (Linux, macOS)
termote start --allow-host box.local       # native, add a Host allowlist entry
termote start --allow-path ~/notes         # native, offer a folder as a Place in Files
termote container up                       # container mode (podman/docker)
termote container up --lan --port 7681     # container, LAN + custom port
termote container up --mux herdr           # container, Herdr inside it instead of tmux
termote container up --mux zellij          # container, Zellij inside it (any host)
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

This is a **pnpm workspace** (`pnpm-workspace.yaml` at repo root). `pwa` (`termote`),
`website` (`@termote/website`) and `video` (`@termote/video`, dev dependencies only, see
`video/README.md`) share a single root `pnpm-lock.yaml`. Install once from the
root — no need to `cd` into each package.

```bash
# Using Makefile (recommended)
make build          # Build PWA + termote
make test           # Run all tests
make start          # Start the server as a native service (through the dev shim)
make container-up   # Run the server in a container (podman/docker, through the dev shim)
make health         # Check service health
make brand-assets   # Regenerate icons/favicons/social images from assets/branding

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

termote is the single server in every mode (PWA + terminal stream + API + auth). It opens the terminal itself
(PTY on Unix, ConPTY on Windows) and streams it to xterm.js over `/api/mux/stream`; there is no ttyd or proxy.
Default port 7680 (Windows 7690). Mux backend: tmux (psmux on Windows), Herdr (`--mux herdr`; a named pipe on
Windows) or Zellij (`--mux zellij`; Linux and macOS natively, any host in the container). Container mode auto-detects podman, then docker. Full model, including the Host allowlist, Origin and
stream-token checks: [`docs/system-architecture.md`](docs/system-architecture.md).

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
pair [options]       Make a one-time code (5 min) that signs a new device in; --role <view|full> (default view), --name <name>, --expires <12h|7d|2w|never> (default 30d)
devices              List the paired devices; `devices revoke <id>` signs one out with every device it paired
signins              List the browsers signed in with the password; `signins revoke <id>|--all` signs them out
version              Show version
serve                Run the server in the foreground (what the service runs)
(no command)         Interactive menu
```

There is no `install` command in 1.0 (it prints the replacement above).

`start` options (saved in the config; a flag not given keeps its saved value; a boolean is
turned off with `=false`): `--port <port>` (default 7680, Windows 7690), `--lan[=false]`,
`--tailscale <host[:port]>`, `--no-tailscale`, `--no-auth[=false]`, `--mux <tmux|herdr|zellij>` (zellij refused natively on Windows),
`--allow-host <name>` (repeatable), `--remove-host <name>` (repeatable),
`--allow-local-user <name>`/`--remove-local-user <name>` (repeatable; native Linux and Windows),
`--allow-path <dir>`/`--remove-path <dir>` (repeatable; a Place in Files, refused at or above home,
`~/.ssh`, `~/.gnupg`, termote's dirs or a git dir; `container up` keeps its own list and mounts it),
`--allow-herdr-no-auth`, `--user <name>` (default `admin`, shared with the container like the
password), `--fresh`. `update` takes `--version <X.Y.Z>` and `--force`.
`container up` additionally takes `--workspace <dir>` and `--build`. `url` prints `http://127.0.0.1:<port>` for this machine (never `localhost`, whose `::1` another
user could hold), and takes `--herdr` (ids from
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

## Container Runtime Support

`termote container up` auto-detects the container runtime in this priority:

1. **podman** (preferred, lighter-weight)
2. **docker** (fallback)

Both Docker Desktop and Podman work on all platforms (macOS, Linux).

## Security Rules

Before changing a route, guard, CLI command or file operation, read its entry in
[`docs/security-invariants.md`](docs/security-invariants.md), keep every invariant listed there, and update
that entry in the same change. A new feature with a security surface gets an entry there, not here.

- Every state-changing `/api/mux/*` route: `writeGuard` (same-site JSON; only `uploads` and `files/image` take a
  raw image body instead, and `files/upload` a raw `application/octet-stream` one), `requireWriteRole` first, a
  body limit, errors as `codedError` codes; same-site reads
  use `crossSiteRejection`
- Never take a filesystem path from the client: open through `os.Root` under the pane root, with the files
  deny lists and the sensitive-name `reveal` check
- tmux/psmux/Herdr: argv or RPC only, never a shell; exact targets (`$N:=i`, `=name`); names and paths into
  tmux formats go through `tmuxLiteral`; psmux differs (no `=` before an index, no `#{n:}`)
- git only through the files routes' `gitRunner` (hooks, filters, fsmonitor off; `GIT_*`/`TERMOTE_*` stripped)
- Internal errors are logged only; never return OS, git or Herdr text to a client
- The password never goes into argv, a service unit/plist/task, a log or an `audit:` line; never `sudo`
- `serve` ignores `TERMOTE_*` when a saved config exists and strips them from its environment
- Every E2E spec imports `test` from `pwa/e2e/fixtures.ts` (fails a test on any CSP violation)

## Pre-commit Checks

**IMPORTANT:** Always run lint/format checks locally before committing to avoid CI failures.

`pnpm install` installs git hooks (lefthook, [`lefthook.yml`](lefthook.yml); they skip on a branch whose
hook files differ from `origin/HEAD`, else `main`, see `scripts/install-git-hooks.mjs`) that run most of them
for you, checking only and never rewriting a file: `pre-commit` runs biome (`pwa/src`), `gofmt -l`
(`server/`) and dprint (markdown/mdx) on the staged files; `pre-push` runs `tsc --noEmit` when
`pwa/**` changed and `go vet ./...` for linux, windows and darwin when `server/**` changed. They never
run `go test` or the E2E suite. Skip them once with `LEFTHOOK=0 git commit ...` or `--no-verify`. CI
installs no hooks (`CI` is set).

```bash
# PWA (required before commit)
pnpm --filter termote lint

# server (Go)
cd server && go build . && go vet ./...

# Formatting (markdown/mdx via dprint)
make fmt-check
```

## Testing

```bash
make test             # Run all tests (Go + dev shim + install.sh + entrypoints)
make test-go          # go test ./... in server/
make test-cli         # Test the termote.sh dev shim
make test-install     # Test install.sh (fake curl)
make test-entrypoints # Test Docker entrypoints
make test-git-hooks   # Test the git hooks installer (prepare)

# Manual checks
pnpm --filter termote exec tsc --noEmit     # Type check
curl http://127.0.0.1:7680/api/mux/health   # Test API

# E2E tests (requires running server)
make start                      # or: ./scripts/termote.sh start
pnpm --filter termote test:e2e              # Run Playwright tests
pnpm --filter termote test:e2e:ui           # Run with UI debugger
```

`pwa/e2e/worktrees.spec.ts` skips unless `TERMOTE_E2E_HERDR=1` (with `TERMOTE_E2E_REPO`): CI's
`e2e-herdr` job runs it against a headless Herdr 0.9.3 (sha256 pinned) on its own socket,
`HOME` and XDG dirs, a throwaway repo with a branch `e2e-base` and a workspace `e2e-repo`. Never
point it at your own Herdr.

Windows equivalents: `tests/test-termote.ps1`, `tests/test-install.ps1`.
