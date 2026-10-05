# Codebase Summary

## Directory Structure

Directories and file families only. Each source file opens with a comment that says what it
does; list a family with `ls` (for example `ls server/agent_*.go`) rather than relying on a copy
here.

```bash
termote/
├── Dockerfile, entrypoint.sh   # Container image (termote + tmux + herdr) and its entrypoint
├── docker-compose.yml          # Development-only container run from a checkout
├── pwa/                        # React PWA (pnpm workspace package `termote`)
│   ├── src/
│   │   ├── App.tsx, main.tsx   # Root component and entry point
│   │   ├── app-views.ts        # Registry of a pane's views (terminal, chat, files, changes)
│   │   ├── ui-style.ts, index.css # Interface styles and design tokens (--tm-*)
│   │   ├── components/         # One component per file; chat-*, files-*/file-*, changes-*/diff-*,
│   │   │   │                   #   session-*, settings-*, keyboard-toolbar, prompt-card, ...
│   │   │   └── ui/             # Shared primitives (Button, Sheet, Menu, Switch, ConfirmDialog, ...)
│   │   ├── hooks/              # use-* hooks: settings, sessions, mux API, stream, per-pane stores
│   │   ├── contexts/           # Theme provider
│   │   ├── types/              # Group/Tab/Pane/AgentStatus types
│   │   └── utils/              # Pure helpers: terminal bridge, highlighting, Markdown, uploads, deep links
│   └── e2e/                    # Playwright specs; every spec imports `test` from fixtures.ts (CSP check)
├── server/                     # Go server + CLI, one binary, flat `package main`
│   ├── main.go                 # Entry point (`serve` runs the server, no args opens the menu)
│   ├── serve*.go, guard.go, security_headers.go # HTTP server, auth, Host/Origin guards, CSP
│   ├── mux*.go, stream*.go, pty_*.go # Mux interface + tmux/Herdr backends, terminal WebSocket, PTY/ConPTY
│   ├── herdr_*.go              # Herdr JSON-RPC client, socket/pipe, observer lifetime
│   ├── agent*.go               # Chat view: Claude Code and Codex sessions, transcripts, dialogs, input
│   ├── files*.go               # Files/Changes views: pane root, tree, contents, git status/diff, images
│   ├── uploads*.go             # `/api/mux/uploads` image store
│   ├── cli*.go                 # CLI subcommands (start/stop, service, container, update, url, panel, ...)
│   ├── listener_owner*.go      # CLI sends the saved password only to the current user's listener
│   ├── install_layout.go, release_tags.go, tailscale.go # Install layout, release tags, tailscale serve
│   ├── testdata/               # Recorded agent screens and transcript fixtures
│   └── webui/                  # Embeds the built PWA into the binary
├── herdr-plugin/               # Herdr plugin manifest (every command runs `termote ...`)
├── scripts/                    # Release installers (install.sh/.ps1) and checkout-only dev shims (termote.sh/.ps1)
├── tests/                      # Shell/PowerShell tests (dev shim, installers, entrypoints, Herdr plugin)
│   └── fixtures/               # Stand-in Claude Code and Codex for the Chat view E2E (Linux)
├── website/                    # Documentation site (Astro Starlight, EN + VI)
├── .github/workflows/          # CI, Release Please, release, website deploy (see CI/CD Workflows)
└── docs/                       # Documentation
```

## Where to Start

Entry points by concern. Behavior lives in the code and its tests; routes, limits and guards are
described in [`system-architecture.md`](system-architecture.md), conventions in
[`code-standards.md`](code-standards.md).

| Concern                                      | Start at                                                                                            |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| App shell: layout, header, menus, deep links | `pwa/src/App.tsx`, `components/app-header.tsx`, `utils/deep-link.ts`                                |
| Terminal stream and keys                     | `components/terminal-view.tsx`, `hooks/use-term-socket.ts`, `utils/terminal-bridge.ts`              |
| Sessions (group → tab → pane)                | `hooks/use-local-sessions.ts`, `hooks/use-mux-api.ts`, `components/session-*.tsx`, `pane-strip.tsx` |
| Mobile input                                 | `components/keyboard-toolbar.tsx`, `quick-actions-menu.tsx`, `hooks/use-gestures.ts`                |
| Settings                                     | `hooks/use-settings.ts` (keys and defaults), `components/settings-modal.tsx`                        |
| Pane views (terminal, chat, files, changes)  | `pwa/src/app-views.ts`, then `components/chat-*`, `files-view.tsx`, `changes-view.tsx`              |
| Images in Files and Changes                  | `components/image-preview.tsx`, `image-compare.tsx`, `hooks/use-image-blob.ts`                      |
| Server entry, auth, guards                   | `server/main.go`, `serve.go`, `guard.go`, `security_headers.go`                                     |
| Mux backends                                 | `server/mux.go` (interface + routes), `mux_tmux.go`, `mux_herdr.go`                                 |
| Chat view (server)                           | `server/agent.go`, then `agent_claude*.go` / `agent_codex*.go`, `agent_input.go`                    |
| Files and Changes (server)                   | `server/files.go`, `files_root.go`, `files_git.go`, `files_raw.go`                                  |
| CLI                                          | `server/cli.go` (dispatch), then the `cli_<command>.go` file (see [CLI](#cli-go-servercligo))       |

Two things the code does not explain on its own:

- Selecting a tab on Herdr changes only which pane this client streams (`caps.clientSideSelect`);
  Herdr itself is not told, so its own focus stays where it was.
- A tab has more than one pane only on Herdr (split panes); tmux tabs always have one, so the pane
  strip appears only there.

## Data Flow

```bash
User Input
    ↓
Gesture/Toolbar → sendKeyToTerminal()
    ↓
WebSocket binary frame → /api/mux/stream
    ↓
termote → PTY/ConPTY → tmux/psmux or Herdr pane
    ↓
Terminal output → WebSocket binary frame → xterm.js → display
```

## CLI (Go, `server/cli*.go`)

The CLI is a set of subcommands compiled into the `termote` binary. Run `termote help` for the
current command and flag list — it is generated from the same code that parses them, so it
never drifts from behavior.

**Commands:** `start [options]`, `stop`, `restart`, `status`/`health`, `container <cmd>`
(`up`/`down`/`logs`/`status`), `update [--version X.Y.Z] [--force]`, `uninstall`,
`logs [server|all|follow|clean]`, `link`, `unlink`, `show-password`, `version`, `serve`,
`menu` (no arguments). There is no `install` command in 1.0 (it prints the replacement above).

**Config persistence:** Unix `~/.config/termote/config` (`KEY="value"`, chmod 600, password
AES-256-CBC with an HMAC keyed by a random per-install `secret` file, 0600); Windows
`%APPDATA%\termote\config.json` (password DPAPI-encrypted). See `cli_config.go`.

**Versioned install layout:** `versions/<v>/bin/termote`, a `current` pointer switched
atomically by `update`, and only the current and previous version kept on disk (see
`install_layout.go`).

**Safe self-replacement:** `update` restarts the service to run the new `current` version;
nothing re-execs the running process.

### Release installers (`scripts/install.sh` / `install.ps1`)

Downloads the newest stable 1.x release (or `TERMOTE_VERSION`) for the OS/arch, verifies its
`.sha256` (mandatory), lays it out under the versioned install root, and prints `termote
start` — they never start the server or touch any saved config.

## External Dependencies

| Package          | Purpose              |
| ---------------- | -------------------- |
| react            | UI framework (v19)   |
| @xterm/xterm     | Terminal emulator    |
| @xterm/addon-fit | Terminal auto-resize |
| hammerjs         | Touch gestures       |
| lucide-react     | Icons                |
| react-markdown   | Chat view markdown   |
| remark-gfm       | GFM tables, lists    |
| vite-plugin-pwa  | PWA generation       |
| tailwindcss      | Styling              |

## API Endpoints

See [`system-architecture.md`](system-architecture.md#communication-protocols) for the full
`/api/mux/*` shape and the terminal WebSocket protocol. All endpoints validate inputs and
enforce HTTP methods; invalid requests return 400/404/405/413 JSON errors.

## CI/CD Workflows

| Workflow             | Trigger                                 | Purpose                                                                                                   |
| -------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `ci.yml`             | Push/PR                                 | Build, lint, type check, PWA test, `go test` (Ubuntu/macOS/Windows), Playwright E2E, website build        |
| `release-please.yml` | Push to `main` / Manual                 | Create/update the release PR (draft release), then call `deploy-website.yml` after a stable one publishes |
| `release.yml`        | Tag push / Manual / Release Please      | Build assets, create a draft GitHub Release, upload assets, publish, push Docker images                   |
| `deploy-website.yml` | Called by `release-please.yml` / Manual | Build + deploy the docs site to GitHub Pages (only after a stable release, not on every push to `main`)   |

### Release Flow

```bash
Commits pushed to main
       ↓
release-please.yml opens/updates the "chore: release x.y.z" PR (CHANGELOG)
       ↓
Merge PR → tag created → release.yml builds assets, drafts the release,
           uploads assets, then publishes it (never public before assets land)
       ↓
Stable release published → release-please.yml calls deploy-website.yml
```

### Manual Release

```bash
make release VERSION=1.0.0      # Local: create + push tag
# Or: GitHub Actions UI → Run workflow → enter version
```

See [release-guide.md](release-guide.md) for full details.
