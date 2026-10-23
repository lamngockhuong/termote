# Key files

Where the main features live. Each source file opens with a comment saying what it holds; directories
and file families: [`codebase-summary.md`](codebase-summary.md).

| File                                              | Purpose                                                       |
| ------------------------------------------------- | ------------------------------------------------------------- |
| `pwa/src/App.tsx`                                 | Main app with gestures, toolbar, settings, sessions           |
| `pwa/src/components/keyboard-toolbar.tsx`         | Virtual keyboard for mobile                                   |
| `pwa/src/components/settings-modal.tsx`           | Settings dialog (IME, paste source, toolbar, etc.)            |
| `pwa/src/components/gesture-hints-overlay.tsx`    | First-time gesture tutorial overlay (mobile)                  |
| `pwa/src/components/session-tabs.tsx`             | Session tab bar for window switching                          |
| `pwa/src/components/connection-indicator.tsx`     | Connection status indicator with retry                        |
| `pwa/src/components/command-history-dropdown.tsx` | Command search/recall UI                                      |
| `pwa/src/components/quick-actions-menu.tsx`       | Quick actions (Actions row of the expanded toolbar, mobile)   |
| `pwa/src/hooks/use-scroll-edges.ts`               | Which ends of a scroller hide content, the fading mask        |
| `pwa/src/components/select-text-sheet.tsx`        | Select text: the pane's text to select and copy (phone)       |
| `pwa/src/hooks/use-pane-text.ts`                  | Pane text for the sheet: server history, else xterm buffer    |
| `pwa/src/utils/copy-text.ts`                      | Clipboard write, `execCommand('copy')` fallback over HTTP     |
| `pwa/src/components/app-header.tsx`               | Header: session chip / tabs, More menu                        |
| `pwa/src/components/brand-mark.tsx`               | Prompt Owl symbol inline (sidebar, header when collapsed)     |
| `pwa/src/components/session-switcher-chip.tsx`    | Mobile header chip that opens the sessions sheet              |
| `pwa/src/utils/reorder.ts`                        | Move up/down and drop indexes, groups that can move           |
| `pwa/src/utils/session-search.ts`                 | Search terms; which sessions and agent cards a search matches |
| `pwa/src/components/session-search-field.tsx`     | Search box and magnifier (sidebar, sessions sheet, overview)  |
| `pwa/src/utils/pane-remap.ts`                     | Tab keys: state by pane id follows a shifted tmux id          |
| `pwa/src/utils/chat-draft.ts`                     | Chat view drafts per pane (sessionStorage), remapped          |
| `pwa/src/utils/pane-view.ts`                      | View and side panel each pane was left on, kept on the device |
| `pwa/src/utils/files-persist.ts`                  | Files/Changes tabs, drafts, pane views kept on the device     |
| `pwa/src/utils/persisted-tabs.ts`                 | Which tab fields are kept, checked when read back             |
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
| `pwa/src/components/overview-screen.tsx`          | Agent overview: every agent's card, own filter, by status     |
| `pwa/src/components/agent-card.tsx`               | One agent: status age, last text, branch, changes, tokens     |
| `pwa/src/components/needs-me-queue.tsx`           | Overview: dialogs waiting on the user, answered one at a time |
| `pwa/src/utils/needs-me-queue.ts`                 | The queue's rules: card on top pinned, answers never move on  |
| `pwa/src/utils/agent-stuck.ts`                    | A working agent quiet past the setting (stuck hint)           |
| `pwa/src/hooks/use-agent-overview.ts`             | Polls `/api/mux/overview` while the overview shows            |
| `pwa/src/hooks/use-pane-overview.ts`              | Header chip: polls `/api/mux/overview?pane=` for one pane     |
| `pwa/src/components/account-usage-strip.tsx`      | Overview: each Codex account's rate limit windows             |
| `pwa/src/components/usage-meter.tsx`              | Thin usage bar (`role="meter"`), coloured by level            |
| `pwa/src/components/usage-chip.tsx`               | Header chip: the open pane's context share and Codex limit    |
| `pwa/src/utils/usage-format.ts`                   | Usage labels: level, `~72%`, `5h`/`7d`, "resets 14:30"        |
| `pwa/src/utils/overview-order.ts`                 | Overview order: blocked, working, done, idle; oldest first    |
| `pwa/src/components/status-timeline.tsx`          | A card's last hour by status, from the activity log           |
| `pwa/src/utils/timeline-segments.ts`              | Cuts a pane's events (by key) into the strip's segments       |
| `pwa/src/components/subagent-tree.tsx`            | A Claude card's subagents: status, type, last tool, time      |
| `pwa/src/hooks/use-subagents.ts`                  | Polls a pane's subagent tree while its card is open (3 s)     |
| `pwa/src/components/activity-log.tsx`             | Overview: every status change, newest first, opens its pane   |
| `pwa/src/hooks/use-activity-log.ts`               | Polls `/api/mux/activity` for new events while shown          |
| `pwa/src/hooks/use-agent-transcript.ts`           | Polls a pane's transcript, one store per pane                 |
| `pwa/src/hooks/use-agent-prompt.ts`               | Polls a pane's open dialog, one store per pane                |
| `pwa/src/components/files-view.tsx`               | Files view: the pane's directory as a tree, opens a file      |
| `pwa/src/utils/file-tabs.ts`                      | Open files as tabs: preview tab, pin, close, cap of 10 (LRU)  |
| `pwa/src/components/file-tab-bar.tsx`             | Desktop tab bar of the open files (keys, middle click, pin)   |
| `pwa/src/components/open-files-sheet.tsx`         | Phone: "Open files (N)" button and the sheet listing them     |
| `pwa/src/components/tab-close-dialogs.tsx`        | Files/Changes: Discard a tab's changes, close on a root move  |
| `pwa/src/hooks/use-long-press.ts`                 | Long press of a finger (a Markdown link opens a new tab)      |
| `pwa/src/components/changes-view.tsx`             | Changes view: git status grouped, diffs as tabs, edits a file |
| `pwa/src/components/file-editor.tsx`              | A file's text in a textarea, why a save failed                |
| `pwa/src/components/new-file-dialog.tsx`          | Files: asks for a new file's path, creates it, says why not   |
| `pwa/src/components/group-dialog.tsx`             | New tmux session / workspace: name, directory, why refused    |
| `pwa/src/components/worktree-dialog.tsx`          | New/Open worktree, the Remove confirmations, why refused      |
| `pwa/src/utils/git-ref.ts`                        | Branch names the server accepts (validBranchName)             |
| `pwa/src/components/file-search.tsx`              | Files: find a file by name under the root, results, switch    |
| `pwa/src/components/delete-file-dialog.tsx`       | Files: asks before a delete, second ask for a permanent one   |
| `pwa/src/components/rename-file-dialog.tsx`       | Files: a file's new path, renames/moves it, says why not      |
| `pwa/src/utils/file-name.ts`                      | Name checks of New file and Rename, the base name selected    |
| `pwa/src/utils/download-file.ts`                  | Download: preflight, refusal messages, iOS share sheet        |
| `pwa/src/components/markdown-preview.tsx`         | Markdown file rendered in Files/Changes (links, code blocks)  |
| `pwa/src/components/mermaid-block.tsx`            | A mermaid block: the diagram image, Show source, fallback     |
| `pwa/src/utils/mermaid-render.ts`                 | Diagram → `data:` SVG image: worker queue, timeouts, cache    |
| `pwa/src/utils/mermaid-worker.ts`                 | Module worker drawing a diagram with Pele, fixed options      |
| `pwa/src/components/image-viewer.tsx`             | Full-screen image viewer: zoom, pan, keys, Back closes it     |
| `pwa/src/hooks/use-zoom-pan.ts`                   | Pinch, drag, double tap, wheel zoom (Pointer Events)          |
| `pwa/src/utils/zoom-pan.ts`                       | Fit, zoom around a point, pan limits of the viewer            |
| `pwa/src/hooks/use-history-close.ts`              | Viewer's history entry: Back closes, close pops it            |
| `pwa/src/hooks/use-image-viewer.tsx`              | Opens the viewer from an image, closes it on a new URL        |
| `pwa/src/components/table-preview.tsx`            | CSV/TSV as a table: delimiter, header, filter, sort, Records  |
| `pwa/src/components/table-grid.tsx`               | Virtual grid of a table (sticky header and row numbers)       |
| `pwa/src/components/inline-cell-editor.tsx`       | A table cell edited in place (fine pointer): Enter, Esc, Tab  |
| `pwa/src/utils/table-columns.ts`                  | Column widths (fit, clamp) and row heights while wrapping     |
| `pwa/src/components/cell-sheet.tsx`               | One cell's whole value, unsafe characters shown, Copy         |
| `pwa/src/components/cell-edit-sheet.tsx`          | A cell being edited: its value, add/delete row, Apply         |
| `pwa/src/hooks/use-csv-table.ts`                  | Parses a table and its view, in a worker past 256 KiB         |
| `pwa/src/utils/csv-parse.ts`                      | RFC 4180 parser keeping each cell's range, delimiter sniffing |
| `pwa/src/utils/csv-patch.ts`                      | Edits of a CSV as patches of cell ranges (cell, row)          |
| `pwa/src/utils/csv-edits.ts`                      | Table edits as ops: undo/redo, reapplied by row values        |
| `pwa/src/utils/csv-parse-client.ts`               | The table's worker: timeouts, falls back to the main thread   |
| `pwa/src/components/table-find-bar.tsx`           | Find in a table: query, options, `3 of 17`, Enter and Escape  |
| `pwa/src/hooks/use-csv-find.ts`                   | Cells that match, here or in the search worker                |
| `pwa/src/utils/csv-find.ts`                       | Match case, whole cell, regex; matches in the order shown     |
| `pwa/src/utils/csv-find-client.ts`                | The search worker: ended on a timeout, never the main thread  |
| `pwa/src/utils/unsafe-chars.ts`                   | Control, bidi and zero-width spaces (strip or show)           |
| `pwa/src/components/image-preview.tsx`            | One image of Files/Changes (sizes, why it cannot be shown)    |
| `pwa/src/components/image-compare.tsx`            | Changes: an image's old and new versions side by side         |
| `pwa/src/hooks/use-image-blob.ts`                 | Reads `files/raw` into a `blob:` URL (SVG: `data:`), revokes  |
| `pwa/src/components/panel-toggles.tsx`            | Desktop header toggles of the side panel (Files, Changes)     |
| `pwa/src/hooks/use-files.ts`                      | File tree of a pane's root, one store per pane                |
| `pwa/src/hooks/use-git-changes.ts`                | Polls a pane's git status, the Changes tabs, one store a pane |
| `pwa/src/utils/highlight.ts`                      | Syntax highlighting through a Shiki worker, with a timeout    |
| `pwa/src/utils/upload-image.ts`                   | Uploads an image to the host, picks one, error messages       |
| `pwa/src/hooks/use-chat-attachments.ts`           | Images attached to a Chat view message (upload, ids, errors)  |
| `pwa/src/hooks/use-agent-commands.ts`             | A pane's custom slash commands, read once and cached          |
| `server/main.go`                                  | Entry point (`serve` runs the server, no args opens the menu) |
| `server/serve.go`                                 | Server (PWA static files, auth, guards)                       |
| `server/mux.go`                                   | `Mux` interface + `/api/mux/*` routes                         |
| `server/mux_tmux.go`                              | tmux/psmux backend                                            |
| `server/mux_groups.go`                            | `/api/mux/groups*`: create, rename, close a group; cwd check  |
| `server/mux_reorder.go`                           | `tabs/{id}/move`, `groups/{id}/move`: one slot, coded errors  |
| `server/mux_herdr.go`                             | Herdr backend                                                 |
| `server/herdr_autostart.go`                       | Starts `herdr server` from a full client's snapshot           |
| `server/herdr_autostart_{unix,windows}.go`        | Per-OS detach flags and not-listening check                   |
| `server/mux_zellij.go`                            | Zellij backend: snapshot, tabs, sessions, input, text, attach |
| `server/mux_zellij_cmd.go`                        | zellij runner (gate, retries), ids, names, version, sockets   |
| `server/mux_zellij_agent.go`                      | Zellij Chat view and Files (pane dir, capture, paste, keys)   |
| `server/zellij_client.go`                         | Termote's Zellij clients: placed on a pane, input, stream     |
| `server/zellij_view.go`                           | Zellij view-only stream: `subscribe` renders, size frames     |
| `server/zellij_pane_pid*.go`                      | A pane's shell: socket owner (sock_diag / lsof), PANE_ID      |
| `server/mux_worktrees.go`                         | `/api/mux/worktrees*`: list, create, open, remove; name check |
| `server/herdr_worktree_branches.go`               | Each worktree workspace's branch, read in the background      |
| `server/stream.go`                                | Terminal WebSocket (`/api/mux/stream`)                        |
| `server/mux_pane_text.go`                         | `GET panes/{id}/text`: pane history as plain text, capped     |
| `server/agent.go`                                 | `/api/mux/panes/{id}/agent/*` routes, transcript reads        |
| `server/agent_activity.go`                        | Status since and change log of every agent (`/activity`)      |
| `server/agent_overview.go`                        | `/overview`: each agent's last text, context, git changes     |
| `server/agent_context_window.go`                  | Window of a model id, context share, Codex account key        |
| `server/agent_claude_model.go`                    | Last model a Claude Code transcript names                     |
| `server/agent_subagents.go`                       | `agent/subagents`: a Claude session's subagent tree           |
| `server/agent_claude.go`                          | Claude Code transcript (JSONL) and session file               |
| `server/agent_claude_prompt.go`                   | Reads a Claude Code screen: input box, dialogs                |
| `server/agent_input.go`                           | Sends a message, answers a dialog (checks before each write)  |
| `server/agent_commands*.go`                       | `agent/commands`: custom commands, skills (Codex: `$` skills) |
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
| `server/files_rename.go`                          | `POST files/rename`: a file moved, never replacing anything   |
| `server/files_download.go`                        | `GET files/download`: a file as an attachment, `check=1`      |
| `server/files_trash*.go`                          | Trash store, sweep, no-replace rename/rmdir by descriptor     |
| `server/agent_proc*.go`                           | Finds Claude Code (or Codex) under a tmux/psmux pane          |
| `server/agent_proc_handles_windows.go`            | Windows: write handles of every process (handle table, 1 s)   |
| `server/agent_proc_files_windows.go`              | Windows: a process's open rollouts, checked again live        |
| `server/agent_proc_identity_windows.go`           | Windows: drive-letter paths only, volume + file index         |
| `server/auth_role.go`                             | Roles (full/view), `authInfo`, default refusal of view writes |
| `server/device_store.go`                          | Paired-device store (`<stateDir>/devices`), tokens, `gen`     |
| `server/device_pairing.go`                        | Pairing codes (in memory, TTL, one use)                       |
| `server/device_routes.go`                         | `/api/mux/devices*` routes, device cookie, revoke             |
| `server/pair_page.go`                             | `/pair`: the form a new device types its code into            |
| `server/cli_devices.go`                           | `pair`, `devices`, `devices revoke`                           |
| `server/audit_log.go`                             | `audit:` lines of pairing, revoke, expiry and form sign-in    |
| `pwa/src/components/devices-section.tsx`          | Settings > Devices: list, revoke, Pair a device               |
| `pwa/src/components/pair-device-sheet.tsx`        | Pair a device: role, name, the code and its QR                |
| `pwa/src/hooks/use-devices.ts`                    | Paired devices list, pair and revoke calls                    |
| `server/guard.go`                                 | Host allowlist + Origin/Content-Type write guard              |
| `server/login.go`                                 | Sign-in form for browsers (iOS home-screen app has no prompt) |
| `server/brand.go`                                 | Inline owl mark and favicon of the `/login` and `/pair` pages |
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
| `server/peer_user_listener.go`                    | Refuses connections from other local OS users (`peer_user_*`) |
| `server/local_socket*.go`                         | CLI ↔ native server over a Unix socket / named pipe           |
| `server/sessions.go`                              | Password sessions: metadata, list, revoke, `sessionAlive`     |
| `server/signin_routes.go`                         | `/api/mux/signins*`: list, revoke one or all others           |
| `server/cli_signins.go`                           | `signins`, `signins revoke <id>\|--all`                       |
| `server/login_link.go`                            | `/api/mux/login-links`, `/login/link`: CLI sign-in link       |
| `server/cli_login_link.go`                        | `url --open`: token into a 0600 file that posts it            |
| `pwa/src/components/signins-section.tsx`          | Settings > Signed-in browsers: list, sign out                 |
| `pwa/src/hooks/use-signins.ts`                    | Signed-in browsers list and revoke calls                      |
| `server/push_routes.go`                           | `/api/mux/push/key`, `/api/mux/push/subscribe`                |
| `server/push_store.go`                            | VAPID key + subscriptions (`<stateDir>/push`, allowlist)      |
| `server/instance_id.go`                           | The snapshot's `instanceId` (`<stateDir>/instance-id`)        |
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
