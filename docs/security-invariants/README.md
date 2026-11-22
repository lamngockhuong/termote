# Security invariants

What each server route, guard and CLI command must keep true, for maintainers changing them. Read the
entry of the code you touch before changing it, and update the entry in the same change. What this
protects for a user, and what it does not: [`security-model.md`](../security-model.md). How the pieces fit:
[`system-architecture.md`](../system-architecture.md).

Each area has its own file. A new entry goes into the file of its area, and its name goes into the
list under that file below, in the same change.

## [Access](access.md)

Covers who gets in and as what: config, sign-in, cookies, guards, devices, roles, local connections. Code: `server/serve.go`, `server/guard.go`, `server/login.go`, `server/auth_role.go`, `server/device_*.go`, `server/pair_page.go`, `server/stream.go`, `server/signin*.go`, `server/local_*.go`, `server/peer*.go`, `server/listener*.go`, `server/security_headers.go`, `server/tailscale*.go`, the Cloudflare options.

- Service reads the saved config, ignoring the environment
- Logout
- Sign-in form
- Host allowlist
- Write/CSRF guard
- Terminal stream
- Paired devices
- View-only role
- Brute-force protection
- Server hardening
- Connections from other local users
- CLI local socket
- Signed-in browsers
- Sign-in link
- CLI and the saved password
- Error sanitization
- Content-Security-Policy
- Cloudflare hostname
- Tailscale mapping
- Config persistence

## [Mux backends and panes](mux.md)

Covers tmux, psmux, Herdr, Zellij and herdr-core, panes, groups and worktrees. Code: `server/mux*.go`, `server/psmux*.go`, `server/herdr_*.go`, `server/zellij_*.go`, `server/hc_*.go`, `server/git_worktree*.go`, `server/system*.go`, `server/recent*.go`.

- Herdr guard
- Herdr autostart
- Zellij sessions
- herdr-core
- Pane processes
- Host stats
- Pane text
- Pane layout
- Pane names and Herdr metadata
- Groups
- Reordering
- Worktrees
- tmux sessions
- tmux panes
- Recent groups

## [Agent chat](agent-chat.md)

Covers the Chat view of Claude Code, Codex and OpenCode. Code: `server/agent_*.go` behind the Chat routes, the Codex and OpenCode readers and the OpenCode service client.

- Agent chat
- Codex chat
- OpenCode service client
- OpenCode chat

## [Agents](agents.md)

Covers agent status, overview, subagents, starting and resuming agents, usage, prompt templates, tasks and review comments. Code: `server/agent_*.go` outside Chat, `server/template*.go`, `server/task*.go`, `server/tasks*.go`.

- Agent activity
- Agent overview
- Agent subagents
- Starting an agent
- Agent session history and resume
- Agent usage and cost
- Files a session touched
- Prompt templates
- Tasks
- Review comments
- Agents CLI

## [Files: reading and previews](files-read.md)

Covers Files/Changes, Places, previews, the editor, state kept on the device, downloads and opening files on Windows. Code: `server/files*.go` that read, `server/git_*.go`, the previews and editor in `pwa/src`.

- Files/Changes
- Places
- A file the agent named
- `<details>` in a previewed Markdown file
- Tags in a table cell of a previewed Markdown file
- Tables in a previewed Markdown file
- Mermaid diagrams
- Full-screen image viewer
- Saving a file
- Desktop editor
- Files/Changes state kept on the device
- Downloading a file
- Opening a file in Windows
- Reading a document to preview
- Office and PDF previews

## [Files: changes](files-write.md)

Covers creating, saving pasted images, uploading, finding, searching, deleting, staging, renaming, image uploads, and the palette and windows that open files. Code: `server/files*.go` that write, `server/uploads*.go`, the Files menus and command palette in `pwa/src`.

- Command palette and app shortcuts
- Focus windows and file links
- Creating a file
- Files menus
- Pasting an image into Markdown
- Uploading a file
- Finding a file
- Searching file contents
- Deleting a file
- Staging and discarding a change
- Renaming a file
- Image uploads

## [PWA](pwa.md)

Covers notifications, settings proposals and the interactive demo. Code: `server/push*.go`, `server/webpush*.go`, `server/settings*.go`, the service worker and demo in `pwa/src`.

- Notifications / Web Push
- Settings proposals
- Interactive demo

## [Machines](machines.md)

Covers other termote servers reached over SSH. Code: `server/machine*.go`, `server/bridge*.go`, `server/cli_machine*.go`.

- Machine bridge
- Machines CLI
- Machine transport
- Machine proxy
- Machines list

## [Release and install](release.md)

Covers Homebrew, release integrity, the website build, git hooks and the agent guide. Code: `server/release*.go`, `server/cli_update*.go`, `scripts/install.*`, `scripts/release-*.sh`, `.github/workflows/`, `scripts/install-git-hooks.mjs`, `lefthook.yml`, `server/agent-guide.md`.

- Homebrew install
- Release integrity
- Git hooks
- Agent guide
- Orchestrator skill
