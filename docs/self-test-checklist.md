# Self-Test Checklist

Manual testing checklist for Termote features before release.

## Prerequisites

- [ ] tmux installed (macOS/Linux)
- [ ] psmux installed (Windows)
- [ ] herdr installed (only for Herdr backend testing, native; the container image has its own)
- [ ] Go 1.26.9+ (for native build; an older Go downloads it when `GOTOOLCHAIN` is `auto`)
- [ ] Node.js 22.22+ or 24.15+ & pnpm (for PWA build)
- [ ] Docker or Podman (for container mode)
- [ ] Mobile device or emulator (for gesture testing)

---

## Installation

### Installer

- [ ] `curl -fsSL https://termote.ohnice.app/install.sh | sh` completes without error (Linux/macOS)
- [ ] `irm https://termote.ohnice.app/install.ps1 | iex` completes without error (Windows)
- [ ] Needs only curl/tar/sha256sum (or PowerShell on Windows); no sudo/admin prompt
- [ ] Verifies the archive's `.sha256`; a corrupted download is refused, not installed
- [ ] Picks the newest published stable 1.x release (never a 0.x, a pre-release, or a draft whose tag release-please already pushed)
- [ ] `TERMOTE_VERSION=X.Y.Z` (or `-rc.N`) pins/rescues a specific version
- [ ] Re-running the installer on an existing install prints `termote update` and changes nothing
- [ ] Installer never starts the server itself; it only prints `termote start`

### Native Mode (macOS/Linux)

- [ ] `termote start` completes without error
- [ ] Service registered (systemd user unit on Linux with a user systemd, detached
      process + PID file on WSL2 without one, launchd agent on macOS)
- [ ] Process running: `pgrep -f "termote serve"`
- [ ] PWA accessible at <http://localhost:7680>
- [ ] `termote stop` then a login (or `loginctl enable-linger`/reboot) starts it again

### Native Mode (Windows)

- [ ] `termote start` completes without error
- [ ] Scheduled Task `Termote` registered, running hidden through wscript (no admin prompt)
- [ ] psmux + termote running
- [ ] PWA accessible at <http://localhost:7690>

### Native Mode + Herdr (Linux)

- [ ] `termote start --mux herdr` completes without error (herdr on `PATH`)
- [ ] `curl localhost:7680/api/mux/health` reports `"backend":"herdr"`
- [ ] `--mux herdr --no-auth` is refused unless `--allow-herdr-no-auth` is also given
- [ ] PWA lists the same workspaces/tabs/panes as `herdr pane list`
- [ ] Selecting a tab/pane on the PWA does not change the Herdr desktop's focused tab
- [ ] Agent status badge changes within one `pollInterval` after `herdr` reports a status change
- [ ] Typing from the PWA lands in the correct order in the Herdr pane (no interleaving)
- [ ] Font buttons, fit switch off: 14 shows as before; each step up makes the text 1px larger,
      and a pane larger than the screen can be dragged both ways on a phone
- [ ] Settings → Terminal → **Fit herdr pane to this device** on (test workspace only):
      `stty size` in the pane reports the PWA's size at the chosen font, and changes with it;
      typing on the desktop still works
- [ ] Hiding the PWA tab returns the desktop to its size within a second; showing it again
      takes the size back
- [ ] Opening the Chat view returns the desktop to its size; a tall Claude Code dialog (a
      multiSelect question with descriptions) shows as one steady card; back in the terminal the
      PWA takes the size again
- [ ] Resizing the pane on the desktop while the PWA drives it, then hiding the PWA: the PWA
      shows the desktop's new size
- [ ] Two browsers with the switch on: the one shown last takes the size, the other shows a
      toast and keeps showing the pane
- [ ] Turning the phone's network off while it drives: the desktop gets its size back within
      about 30 seconds
- [ ] `kill -9` of the server while the PWA drives: the desktop gets its size back

### Native Mode + Herdr (Windows)

- [ ] `termote start --mux herdr` completes without error (`herdr.exe` on `PATH`)
- [ ] `curl localhost:7690/api/mux/health` reports `"backend":"herdr"` (named pipe of `%APPDATA%\herdr\herdr.sock`)
- [ ] With psmux and Herdr both present, the first `termote start` detects Herdr and asks (or picks psmux without a terminal)
- [ ] Stream, typing, paste, scroll and agent status badge work as on Linux
- [ ] Resizing the pane in Herdr (split, zoom) restarts `observe` at the new size
- [ ] No console window opens when `observe` starts from the Scheduled Task
- [ ] After `termote stop`, and after `Stop-Process -Force` on the server,
      `Get-CimInstance Win32_Process -Filter "Name='herdr.exe'"` lists no `terminal session observe`
      or `terminal session control`
- [ ] Stopping a stream that drives the pane size returns the desktop to its size

### Container Mode

- [ ] `termote container up` completes without error
- [ ] Container running: `docker ps | grep termote` (or `podman ps`)
- [ ] PWA accessible at <http://localhost:7680>
- [ ] First `container up` without `--mux`: asks tmux/herdr in a terminal, uses tmux without one
- [ ] `container up --mux herdr`: PWA shows workspace `main`; typing, resize, create/rename/close tab work
- [ ] `container up` without a flag keeps the saved backend; `--mux tmux` switches back
- [ ] `container up --mux herdr --no-auth` is refused unless `--allow-herdr-no-auth` is also given
- [ ] Claude Code running in a container pane changes its agent status badge
- [ ] Password and Host allowlist reach the container as `-e` values from the CLI's own
      environment (`docker inspect termote` shows no `--env-file`/mounted secret file)
- [ ] Rootless podman runs with `--userns=keep-id`; rootless Docker runs without `--user`
- [ ] `--workspace <dir>` mounts the given directory at `/workspace` with `--mount`
- [ ] `container up --build` (from a checkout) builds `termote:local` instead of pulling
- [ ] A native server already on the port makes `container up` refuse with a hint
- [ ] `container down` / `container logs [-f]` / `container status` work
- [ ] Setting a new password with `--fresh` on either side updates the other's saved password too
- [ ] `--no-auth` keeps the previously saved shared password (does not clear it)

### Options (`start` and `container up`)

- [ ] `--lan` flag exposes to LAN (test from another device); the address the request arrived
      on is accepted even as the LAN IP changes
- [ ] `--no-auth` disables basic auth
- [ ] `--port <port>` changes port correctly
- [ ] `--tailscale <host[:port]>` configures Tailscale HTTPS and adds the name to the Host
      allowlist, applied without `sudo`
- [ ] An HTTPS port already serving something else (e.g. the other mode) is refused
- [ ] `--fresh` forces a new password (ignores the saved one)
- [ ] `--allow-host <name>` adds a name to the Host allowlist (persisted); a request with an
      unlisted `Host` header gets 403 with that exact flag suggested
- [ ] `--remove-host <name>` removes a previously allowed name
- [ ] A request from an unrecognised LAN hostname/IP is rejected (403) until added with
      `--allow-host`
- [ ] There is no `--ttyd` flag and no PowerShell `-Flag` parameter names in 1.0

### Config Persistence

- [ ] Password: AES-256-CBC with an HMAC keyed by the random per-install `secret` file, 0600 (Unix)
- [ ] Password encrypted with DPAPI (Windows)
- [ ] Config file chmod 600 (Unix)
- [ ] Saved config reused on restart (port, LAN, auth, mux, allowlist, Tailscale, workspace)
- [ ] `show-password` prints the saved password

### Uninstall

- [ ] `termote uninstall` stops the service, removes the registration, the `termote` command,
      the install root and the uploaded images, but keeps the saved config and logs (prints both paths)
- [ ] `termote uninstall --purge` also removes the config and the logs; the menu's Uninstall asks
- [ ] Windows: after `termote uninstall` exits, `%LOCALAPPDATA%\termote` holds only `state\`
      (nothing with `--purge`), and no "The system cannot find the path specified." is printed

### Link/Unlink

- [ ] `termote link` creates the command in `~/.local/bin` (added to PATH by the installer)
- [ ] `termote help` works after linking
- [ ] `termote unlink` removes the command

### Update

- [ ] `termote update` updates to the latest stable 1.x release
- [ ] `termote update --version X.Y.Z` pins to a specific version
- [ ] `termote update --force` reinstalls the current version
- [ ] Update preserves saved configuration (port, LAN, auth, mux, allowlist, Tailscale)
- [ ] A health check on the new version passing keeps it; a failing one switches `current` back
      to the previous version and restarts it
- [ ] Refuses to run from a git checkout, and for a binary not installed by the installer
- [ ] Warns on downgrade, skips reinstall if already on target version
- [ ] Only the current and previous version are kept under `versions/`
- [ ] `termote update` typed inside a Termote pane still completes (it does not kill its own pane)

### Other CLI Commands

- [ ] `termote status` (alias `health`) reports what the running server answers
- [ ] `termote logs` shows service logs
- [ ] `termote version` shows the installed version

---

## PWA Features

### Basic

- [ ] PWA loads without console errors
- [ ] Terminal connects via the `/api/mux/stream` WebSocket
- [ ] Terminal renders correctly
- [ ] Typing sends input to terminal
- [ ] Output displays in terminal
- [ ] Terminal colors match dark mode theme
- [ ] Terminal colors match light mode theme
- [ ] Theme switching does not reconnect the terminal
- [ ] Correct terminal theme applied after page reload (F5)
- [ ] Resizing the window/panel resizes the PTY (`stty size` inside the terminal matches)
- [ ] Killing the shell inside the terminal shows an exit frame and a way to reconnect
- [ ] Reconnect after a network drop resumes the same pane without losing scrollback that the
      backend still has buffered
- [ ] Desktop: Icon list displays correctly (no layout issues)
- [ ] About page looks good in dark mode
- [ ] "More" (⋯) menu opens from the header on mobile and desktop
- [ ] "Clear cache & reload" in the More menu works (unregisters SW, clears caches, ends the session on the server, reloads)
- [ ] With sign-in on, "Log out" in the More menu opens the sign-in page, and the old session no longer works after it (reload asks to sign in again); without sign-in (`--no-auth`) the item is not shown

### Connection Indicator

- [ ] Shows "connecting" state (yellow pulsing dot) on initial load
- [ ] Shows "connected" state (green dot, Wifi icon) when active
- [ ] Shows "disconnected" state (red dot, WifiOff icon) when server unreachable
- [ ] Clickable when disconnected — triggers a reconnect

### Toast Notifications

- [ ] Toast appears for clipboard errors, paste failures, update availability
- [ ] Auto-dismisses after ~4 seconds
- [ ] Appears near the top (never covers the toolbar), coloured by status (info, success, warning, danger)

### Settings

- [ ] Settings opens from the More (⋯) menu: full-screen sheet on phone, two-column dialog with a group rail on desktop
- [ ] Groups present: Appearance, Keyboard, Terminal, Sessions, Data & help
- [ ] Interface style (Neutral, Terminal, Native) applies at once and persists after reload
- [ ] Escape closes Settings, Help & gestures and About
- [ ] IME send behavior toggle works (Send text only / Send + Enter)
- [ ] Paste source toggle works (System clipboard / "tmux buffer" on tmux, "Session buffer" otherwise)
- [ ] Toolbar default expanded toggle works
- [ ] Context menu disable toggle works
- [ ] Session tabs visibility toggle works (desktop)
- [ ] Poll interval selector works (3s to 5m)
- [ ] Update checker button works
- [ ] Gesture hints viewer available (mobile)
- [ ] Clear history button works
- [ ] Preferences persist after page reload

### Theme

- [ ] Light mode theme (GitHub-style light palette)
- [ ] Dark mode theme (Monokai-style dark palette)
- [ ] System mode (follows OS preference)
- [ ] Theme (Light / Dark / System) accessible in the More menu
- [ ] Each theme works with each interface style
- [ ] With reduced motion enabled in the OS, animations are off
- [ ] Theme persists after reload

### Install/Offline

- [ ] PWA installable to homescreen (mobile/desktop)
- [ ] Service worker registered
- [ ] Offline mode shows cached shell

### Help & Documentation

- [ ] Help modal opens with 3 tabs: Gestures, Toolbar, tmux
- [ ] Gestures tab shows swipe/pinch/long-press actions
- [ ] Toolbar tab shows all keyboard buttons and combos
- [ ] tmux tab shows window/pane/copy-mode commands

### About

- [ ] Version, author, license displayed
- [ ] GitHub, changelog, issues links work
- [ ] Sponsor links (MoMo, GitHub Sponsors, Buy Me a Coffee)

---

## Session Management (3 levels: group → tab → pane)

### Session Sidebar (groups)

- [ ] Desktop: sidebar shown; mobile: the header session chip ("Open sessions menu") opens the sessions list as a bottom sheet with "New session"
- [ ] Sidebar scrollable when many groups exist
- [ ] Sidebar collapse/expand toggle works (desktop)
- [ ] Collapsed sidebar shows icons only with tooltips (desktop)
- [ ] Create new session (tab) works
- [ ] Edit session name works
- [ ] Edit session icon via icon picker (emoji)
- [ ] Edit session description works
- [ ] Delete session works
- [ ] Clicking session switches terminal
- [ ] Active session highlighted in sidebar
- [ ] Sessions persist after page refresh
- [ ] Double-click to edit session (desktop)
- [ ] With `caps.groups`: every group has a header with a ⋯ menu, a single tmux session included
- [ ] "New tmux session" (tmux) / "New workspace" (Herdr) opens a dialog; a name and an absolute
      directory create it there (`tmux ls`, `herdr workspace list`), and its first tab shows
- [ ] The dialog says why it refused (relative or missing directory, a file, a name taken) and keeps
      what was typed; an empty directory starts in the home directory
- [ ] A name with `#(…)` or `#{…}` shows as typed in `tmux ls` and runs nothing
- [ ] Rename in the ⋯ menu edits the name in place; tmux's default session has no Rename
- [ ] Close asks first with the number of tabs; for tmux's default session it says a new, empty one
      starts and other devices are disconnected, and they reconnect to it
- [ ] Closing the group on screen shows the first group left
- [ ] Herdr: closing a workspace with worktrees shows "remove them first, or close it in Herdr"
- [ ] tmux: a session started outside Termote (`tmux new -s x`) shows as a group and can be closed

### Reordering (tmux 3.2+, Herdr 0.8.0+ on Linux/macOS)

Run Herdr on a throwaway socket and `HOME`, never your live Herdr.

- [ ] Desktop: drag a tab row above or below another of its group; a 2 px line shows where it
      lands; `tmux list-windows` (or Herdr's tab bar) shows the new order; a click still selects
- [ ] Desktop: Alt+↑/Alt+↓ on a focused tab row moves it; focus stays on the same row
- [ ] Phone (390×844): ↑/↓ on the "Current session" row move the tab on screen, disabled at the
      ends of its group; swipe still reveals Edit/Delete
- [ ] Herdr: Move up/Move down in a workspace's ⋯ menu (disabled at the ends) and dragging its
      header move it; Herdr's sidebar agrees
- [ ] Herdr: a tab reordered in Herdr itself shows in the same order in Termote
- [ ] Herdr worktree group: the repository's workspace moves with its worktrees; a linked worktree
      has no Move and its route answers 409 `linked_worktree`
- [ ] Herdr restarted: the order is kept
- [ ] No reorder control while the agent filter or "blocked first" is on, nor on tmux older than
      3.2, psmux (Windows), Herdr older than 0.8.0 or Herdr on Windows; tmux sessions have no Move
- [ ] With the agent filter or "blocked first" on: the "Current session" row (phone) and a group's
      ⋯ menu say what to turn off to reorder; nothing said where the backend cannot reorder
- [ ] tmux: a Chat draft and an attached image in one window stay with it when another window is
      moved across it, on a second open device too; an open Edit form stays on its window
- [ ] tmux: closing a tab whose id another device's move shifted says "The tab changed; try
      again" and closes nothing
- [ ] psmux: whether `tmux display-message -p '#{window_id}'` prints `@N` (record it here)

### Worktrees (Herdr 0.9.2+, Linux/macOS)

Run against a Herdr of its own (`HERDR_SOCKET_PATH`, `HOME` and XDG dirs under a temp dir), or
on a repo you can throw away.

- [ ] A workspace's ⋯ menu has New worktree and Open worktree; tmux, Windows and Herdr 0.9.1 have
      neither (`caps.worktrees` false)
- [ ] New worktree from Current HEAD and from another base: the workspace appears, is selected and
      its header shows the branch, on a phone (390×844) and on desktop
- [ ] Typing an existing branch hides the base ("Checks out the existing branch") and checks it
      out; an invalid name (`-x`, a bidi or zero-width character) is pointed out before sending
- [ ] Open worktree lists only linked worktrees; a closed one opens, an open one is selected
- [ ] Remove worktree (linked worktrees only) names the branch and path; a clean one goes, a
      dirty one asks a second time and Cancel keeps its files; the branch is kept
- [ ] Remove after another client changed the worktree says "This worktree changed; look again"
      and removes nothing
- [ ] After a Herdr server restart, the branch labels and Remove are still offered
- [ ] A slow repo (`strace -e inject`, a network mount) does not slow the sidebar

### Session Tabs (Desktop)

- [ ] Tabs share the header row when the setting is enabled
- [ ] Tabs scroll into view when switching
- [ ] Clicking tab switches session
- [ ] Active tab highlighted

### Pane Strip (multi-pane tabs, Herdr only)

- [ ] Pane strip is hidden for a tab with a single pane
- [ ] Pane strip appears for a tab with more than one pane, with an agent-status badge per pane
- [ ] Selecting a pane switches the stream without changing the Herdr desktop's focus
- [ ] The X next to a pane asks "Close pane?"; Cancel keeps it, "Close pane" closes only that pane
- [ ] Closing the streamed pane switches the stream to another pane of the same tab

### Deep Links

- [ ] `<base>/#/s/<group>/<tab>` opens that session after load
- [ ] Unknown ID keeps the current session and shows a toast
- [ ] Opening a link never sends keys or creates/closes a session
- [ ] Switching session/tab/pane updates the address without new history entries
- [ ] "Copy link" in the More menu copies the current link

### Agent Notifications

Use a production build (the service worker is off in `pnpm dev`) and a pane running Claude Code.

- [ ] Settings → Sessions → "Notify when an agent needs me": turning it on asks for permission;
      denied reads "Blocked in browser settings" and stays off
- [ ] Desktop Chrome, tab in the background: a permission dialog raises one "Agent needs you";
      clicking it focuses the tab on that pane
- [ ] A finished turn raises "Agent finished"; without push (an older server), the pane on
      screen in a focused window raises none; with push it raises one, replacing any earlier one
      for that pane
- [ ] Android Chrome (installed app), PWA closed: a dialog raises a push; tapping it opens the pane
- [ ] Desktop Chrome and Firefox, every Termote tab closed: a push arrives
- [ ] iPhone/iPad Home Screen app (iOS 16.4+): turning it on subscribes, a push arrives with the
      app closed; Safari shows the Home Screen hint instead
- [ ] A subscription revoked in the browser: the next push gets 410 and the server drops it
- [ ] `termote start --fresh`: no push reaches any device until it signs in again
- [ ] Log out: no more pushes to that device
- [ ] With a subscription and no page open, `tmux kill-session -t main`: `main` is not recreated
- [ ] `ls -l ~/.local/state/termote/push`: 0600 files in a 0700 dir

### Fullscreen (Desktop)

- [ ] Fullscreen button visible in header (desktop only)
- [ ] Click toggles fullscreen mode
- [ ] Icon changes between Maximize/Minimize
- [ ] Esc/F11 exits fullscreen and syncs button state

### Session Actions (Mobile)

- [ ] Edit/Delete buttons hidden by default
- [ ] Swipe left/right on session item reveals Edit/Delete buttons
- [ ] With `caps.reorderTabs`: Move up/Move down buttons on the "Current session" row

### Sessions via API

- [ ] Sessions listed via API: `curl localhost:7680/api/mux/snapshot`
- [ ] Switch session via API works
- [ ] `POST /api/mux/tabs/<id>/move {"index":0}` answers `{ok, id}` (the new id on tmux);
      `{"index":99}` → 400 `invalid_index`; a group move on tmux → 501 `unsupported`
- [ ] `DELETE /api/mux/tabs/<id>?key=<another window's @N>` → 409 `changed`, nothing closed
- [ ] Session state persists across terminal reconnects

---

## Chat View (Claude Code, Codex)

Run on tmux (Linux/macOS), psmux (Windows) and Herdr (`herdr integration install claude` done).

### Availability

- [ ] A tab running `claude` shows the Terminal/Chat switcher; a tab without it does not
- [ ] Quitting Claude Code hides the switcher and returns to the terminal
- [ ] Phone: the header shows one view button (current view's icon) instead of tabs; it opens a
      menu of views with the current one checked, and the session name keeps its room
- [ ] tmux window split in two: the chat follows the pane with focus; switching focus mid-way
      never sends a message to the shell pane

### History

- [ ] The whole conversation shows: user messages (with a note for an attached image), markdown
      replies, tool calls collapsed with their result
- [ ] A new turn appears within 2 seconds; scrolling up keeps the position while new entries arrive
- [ ] An image in a reply shows as a text link and loads nothing (no request to another origin in
      the browser's network panel)
- [ ] `/clear` or `/resume` in the terminal: the chat switches to the new transcript within 2 seconds,
      without mixing the two

### Sending

- [ ] A multi-line message (with Vietnamese text) reaches Claude Code verbatim, as one turn
- [ ] While Claude Code works, a dialog is open or the input box holds a draft: sending is refused
      with `input not ready` and the pane gets no key
- [ ] A message typed before `/clear` in another client is refused and the composer says the
      conversation changed
- [ ] `/` at the start of the message lists the commands (`/exit` first, then built-ins, the
      project's and the user's commands and skills with their tags); typing filters; tap, Enter
      or Tab fills `/name` without sending; arrows move, Escape or a space closes the list
- [ ] On a phone the list sits above the keyboard and scrolls; each row is easy to tap
- [ ] `/model` (marked "opens in Terminal") is sent and the terminal shows its picker
- [ ] `/exit` asks first; Cancel sends nothing, Exit ends Claude Code and the app returns to the
      terminal
- [ ] (Once a view-only role exists, #236) view-only mode shows no composer and no answer
      buttons; until then this is covered by unit tests only

### Dialogs

- [ ] A permission dialog shows a card; each button picks that option, Cancel sends Escape
- [ ] A single-choice `AskUserQuestion` (≤ 9 options) shows buttons that pick the right option;
      "Type something" is an "Other…" button instead
- [ ] "Chat about this" has a button and returns Claude Code to the input box
- [ ] A wizard of single-choice questions is answered to the end, one card per tab: the step row
      marks the tab open and the tabs answered, and the Submit tab's "Submit answers" sends it
- [ ] Moving to another tab in the terminal (or answering on another device) before tapping
      sends nothing; the card shows the tab now open
- [ ] Tapping another step opens that tab (also backwards, and straight to Submit); a step that
      lands on another screen stops and the card shows it
- [ ] A multiSelect question or tab shows toggles: each tap ticks or unticks one option, "Next"
      moves on with the options kept and marks the tab answered
- [ ] "Other…" opens a field: a Vietnamese answer sent from it reaches Claude Code as the answer
      (single question), or moves a wizard to its next tab; Cancel closes the field, the dialog stays
- [ ] On a multiSelect tab, "Other…" adds the text as a ticked option that its button unticks;
      "Next" then moves on with it
- [ ] With the pointer on "Type something" in the terminal (or text typed into it and the pointer
      still there) the card is read-only; text typed there and left has no "Other…" button
- [ ] Moving the pointer in the terminal between opening "Other…" and Send sends nothing
      or stops before typing; the card shows the dialog now on screen
- [ ] Skipping a multiSelect tab with a step leaves it unanswered (Submit warns)
- [ ] A question whose options have previews shows one button per option (no preview text in
      the labels, no "Chat about this" button); a tap picks the option
- [ ] On a phone, a tall dialog card stays steady (the pane does not shrink under the Chat view)
- [ ] Two devices answer the same dialog: only one answer reaches the pane
- [ ] "Open terminal" switches to the terminal; the stream is still connected (no reconnect)

### Mobile (iPhone Safari PWA, Android Chrome)

- [ ] The on-screen keyboard does not cover the composer
- [ ] The conversation scrolls smoothly; buttons are easy to hit

### Codex

Run on tmux (Linux/macOS), psmux (Windows) and Herdr (`herdr integration install codex` done).
On psmux, sending from the Chat view fails until #408.

- [ ] A tab running `codex --no-daemon` shows the Terminal/Chat switcher; plain `codex` (shared
      daemon) does not
- [ ] User and Codex messages, commands and file changes show; a new turn appears within 2 seconds
- [ ] A message with Vietnamese text reaches Codex as one turn; one over 1000 characters too
      (Codex shows `[Pasted Content N chars]` before Enter)
- [ ] While Codex works or its composer holds a draft, sending is refused (`Not sent: ...`) and the
      pane gets no key
- [ ] `/` at the start of the message lists no commands
- [ ] tmux: `/new` in the terminal removes the Chat view until Codex is restarted
- [ ] tmux: an approval dialog (run a command, make edits) shows a read-only card with "Answer
      this dialog in the terminal."
- [ ] Herdr: the approval card's buttons pick the option, "Cancel (Esc)" sends Escape
- [ ] Other Codex dialogs (model picker, ...) are read-only on both backends
- [ ] Windows: plain `codex` (its daemon is a child `codex.exe app-server`) has no Chat view;
      `codex --no-daemon` has one after its first message
- [ ] Windows: a Codex started from an elevated PowerShell has no Chat view; the log shows at
      most the one "holds no single rollout" line

### Starting an agent (Herdr)

Linux, Herdr 0.8.2 or later, `termote-dev serve --mux herdr` (or `termote start --mux herdr`).

- [ ] An idle pane offers the Chat view with "Claude Code" and "Codex"; a pane running `vim`
      does not; tmux offers neither and `POST …/agent/start` answers 501
- [ ] Claude Code: `claude` runs, the state goes `starting` → `ready`, the conversation shows; a
      first message sent from the Chat view arrives (note how long until Herdr reports the
      session, meanwhile the view says "Claude Code is starting…")
- [ ] Codex: the process runs as `codex --no-daemon`; the Chat view asks for the first message in
      the terminal; after one typed there, the Chat view shows the conversation
- [ ] `echo hi` half-typed, then a start: only the agent runs. Same at a `PS2` prompt (`echo \`
      Enter) and inside `cat <<EOF`
- [ ] A new directory where Claude Code asks to trust the folder: the PWA opens the Terminal with
      "Claude Code is asking something in the terminal."
- [ ] `PATH` without `codex`: `exited` within a few seconds, a warning toast with Open terminal;
      starting again at once says Herdr still holds the last start (409 `start_pending`, nothing
      typed), and works once 30 seconds have passed
- [ ] `curl` POST to a pane running `vim` → 409 `pane_busy`, nothing typed (screen unchanged)
- [ ] Two devices start at once: one gets 200, the other 409 `starting` and follows the same start
- [ ] `curl` `{"kind":"bash"}` → 400 `invalid_kind`; `{"kind":"claude","args":["--help"],"name":"x"}`
      → the agent starts without them, `herdr agent list` shows the alias `termote-claude-…`
- [ ] Kill a working Claude Code (`C-c C-c`), start a new one: no "Agent finished" notification
- [ ] `/exit` in an agent while its Chat view is open: the view stays on Chat and offers the start
      buttons again (it no longer falls back to the Terminal)

Windows, Herdr 0.8.2 or later, pwsh as the pane shell, `termote start --mux herdr`.

- [ ] An idle pwsh pane offers the Chat view with "Claude Code" and "Codex"; the start
      reaches `ready`, or `blocked` on the folder-trust dialog (the PWA opens the Terminal)
- [ ] `ping -t 127.0.0.1`, `nvim` and a nested `cmd` running, then a
      `curl` POST → 409 `pane_busy` and the program keeps running (no Ctrl+C reached it)
- [ ] `Read-Host` waiting, or half-typed text, then a start: the prompt is cleared and only the
      agent runs (`Start-Sleep 60` and a `while ($true) {}` loop too)
- [ ] `Start-Job { Start-Sleep 300 }` running: 409 `pane_busy` (fail-closed); after `Remove-Job -Force`
      the pane is idle again
- [ ] `curl` `{"kind":"codex"}` starts `codex --no-daemon`; the snapshot's `caps.agentStartCodex` is true

---

## Files and Changes

Run on tmux (Linux/macOS) and Herdr; psmux (Windows) offers neither view.

### Files

- [ ] Desktop: the "Files" and "Changes" header toggles open the view in the side panel, pressed
      again they close it; phone: both are in the view menu
- [ ] The tree shows the pane's root (its git toplevel, else its directory); Refresh reads it again
- [ ] Folders open and close by click and by arrow keys; Enter or a click opens a file
- [ ] A file shows with line numbers and its size; "Copy path" and "Wrap lines" work; Back returns
      to the tree
- [ ] A binary file or one over 1 MiB shows "Not previewable (binary, special file or larger than
      1 MiB)"
- [ ] `.env` (lock icon in the tree) asks "Show this file?" first: Cancel closes its tab, Show
      shows it; switching tabs and back keeps it shown, closing its tab and opening it again asks
      again
- [ ] `.git` does not open ("This directory can't be shown")

### Open Files as Tabs

- [ ] Desktop: a click opens a file in the preview tab (italic name), the next click replaces it;
      a double click (tree or tab), Edit or "Keep open" keeps it; a file already open shows its tab
- [ ] Switching tabs brings back the scroll offset (code, Markdown, table, editor) and the draft
- [ ] Closing a tab with unsaved changes asks "Discard changes?"; a middle click or Delete closes a
      tab; opening an 11th file closes the least recently used clean tab, never one with a draft
- [ ] Ctrl/Cmd+click or a middle click on a Markdown link opens a new tab; a plain click goes on in
      the same tab and Back returns
- [ ] Phone: no tab bar; "Open files (N)" in the file's bar and above the tree opens a sheet to
      switch, keep open and close; a long press on a Markdown link opens a new tab; nothing scrolls
      sideways at 360 px
- [ ] A file deleted outside Termote keeps its tab with "File not found" and "Close tab"; when the
      pane moves to another directory, clean tabs close and tabs with a draft ask (Discard and
      close / Keep)
- [ ] `cd` out of the root in the pane, then Refresh: toast "The pane's directory changed" and the
      tree shows the new root

### Changes

- [ ] Header shows the branch; files are grouped as Conflicts, Staged, Changes, Untracked, each
      with its count and status letter
- [ ] A file staged and then changed again shows in Staged and in Changes, each opening its own diff
- [ ] A diff shows hunks with added/removed lines and "Staged" or "Not staged"; a rename shows
      `old → new`
- [ ] Phone shows one line-number column, desktop two
- [ ] A changed `.env` asks "Show this file?" before its diff
- [ ] A change made in the terminal shows within 5 seconds; committing (or staging) the open
      side closes its tab with "No changes left in <file>"; a tab being edited stays
- [ ] Outside a git repo: "Not a git repository: <dir>"; a clean tree: "No changes"
- [ ] Desktop: diffs open as tabs after a "Changes" tab: a click opens the preview tab, a double
      click (list or tab) or Edit keeps it; the staged and unstaged side of one file are two tabs,
      the staged one named "(staged)"
- [ ] Edit in one tab, switch to another and back: the editor and its draft are still there;
      switching tabs brings back the diff's scroll offset; closing the edited tab asks "Discard
      changes?"
- [ ] Phone: no tab bar; "Open files (N)" above the list and in the diff's bar opens the sheet

### Editing a File

- [ ] A text file has "Edit" (pencil); it shows the text in a box with "Cancel editing" and "Save";
      a `.md` file shows its source even with the preview on
- [ ] Change one line of a `docs/records/*.md` front matter on a phone, Save: toast "Saved", and
      on the host only that line changed (`git diff`); a file with `\r\n` line breaks keeps them
- [ ] Save stays off until the text changes; Ctrl+S (Cmd+S) saves; Cancel or Back with changes
      asks "Discard changes?"
- [ ] Edit, then change the file in the terminal, then Save: "The file changed on the host since
      you opened it"; the text stays; "Copy my text" copies it, "Reload" shows the host's version
- [ ] Switching view (or closing and reopening the panel) while editing keeps the text
- [ ] No "Edit" for a symlink, a file with mixed line breaks, an image, a file over 1 MiB, or
      `chmod 444` file (a save there: "The server can't write this file")
- [ ] `.env`: Edit appears only after "Show"; saving it works without asking again
- [ ] Changes: "Edit" on a modified or untracked text file ("Edit working copy" on the staged
      side), none on a deleted file, an image or a binary diff; after Save the unstaged diff
      shows the new text; editing the file back to the index version shows the list and "No
      changes left in <file>"
- [ ] No `.termote-edit-*` file is left next to the saved file
- [ ] (Once a view-only role exists, #236) view-only shows no "Edit", and `PUT files/content` is
      refused for that role; until then this is covered by unit tests only

### Markdown Preview

- [ ] A `.md` file opens rendered; the "Preview" (eye) button switches to the source and back, and
      the choice stays for the next Markdown file and after reload
- [ ] A relative link opens that file in the same tab (Back returns to the file it came from); a
      `#heading` link
      scrolls to it; an `http(s)` link opens in a new tab; a link leaving the pane's root is plain
      text
- [ ] Fenced code blocks are highlighted, labelled with their language and have "Copy code"
- [ ] Raw HTML (`<b>`, `<script>`) shows as text; an image shows as an "image: ..." link and loads
      nothing
- [ ] A Markdown file over 256 KiB shows "Too large to preview: shown as source"
- [ ] Changes: a changed `.md` file's "Preview" shows the current version rendered

### CSV and TSV Tables

- [ ] A `.csv` opens as a table; the "Preview" (eye) button switches to the source and back, and
      the choice stays for the next CSV and after reload, apart from Markdown's
- [ ] A `;` CSV and a `.tsv` read right; a quoted value with a comma or a line break stays one
      cell; a BOM never shows in the first header
- [ ] Sorting, "Filter rows", "Delimiter" and "Header row" change only the view (`git status`
      shows nothing)
- [ ] iPhone (Safari and the home-screen app): the header row stays on top and the row numbers on
      the left while scrolling both ways; "Records" shows one row at a time and the page never
      scrolls sideways
- [ ] A 1 MiB CSV opens and scrolls smoothly; a quote never closed shows "Unclosed quote on line
      N: shown as source"
- [ ] Edit on a table: tap a cell, change it, Apply, Save; `git diff` shows only that cell (a
      CRLF file stays CRLF); "Add row below", "Add a row at the end" and "Delete row" work, and
      Undo/Redo (Ctrl+Z, Ctrl+Shift+Z) walk back and forth
- [ ] Change the file from the terminal while editing (add a row above the edited one): Save says
      it changed; "Reload and reapply" puts the edit on the right row; a deleted row is listed
- [ ] iPhone: the cell sheet opens above the keyboard and Apply is reachable; the page never
      scrolls sideways while editing
- [ ] Drag the line at the right edge of a column name with the mouse: only that column changes,
      nothing sorts; a double-click on it fits the column; Tab to it, Left/Right step it and
      Enter fits it
- [ ] iPhone: drag the line with a finger (the table does not scroll meanwhile), double-tap it to
      fit the column, and the column never sorts
- [ ] "Columns": "Fit columns", "Reset widths", and "Wrap" on a column with long or multiline
      values: up to three lines per cell, `↵` kept, every row taller, PageDown and the arrow keys
      still land on the right row; off again, rows go back to their height
- [ ] Widths and wraps go back to the defaults on another "Delimiter" or "Header row", stay after
      editing a cell, and stay after showing another tab and coming back (same first row)
- [ ] Press a row number: Records opens on that row (also after sorting); turning Records off
      shows the table where it was

### Images

- [ ] A PNG, JPEG, GIF and WebP open as the picture with "<width>×<height> · <size>"; a text file
      renamed to `.png` shows "Not previewable (not a PNG, JPEG, GIF, WebP or SVG image)"
- [ ] An image over 10 MiB shows "Larger than 10 MiB"; a Git LFS pointer shows "Stored in Git LFS:
      only the pointer is in git"
- [ ] An `.svg` opens as source; the "Image" button shows the picture, and the choice stays for
      the next SVG and after reload; opening `/api/mux/panes/<id>/files/raw?path=<x>.svg`
      directly downloads it and runs no script
- [ ] A sensitive name (`secrets.png`) asks "Show this file?" first
- [ ] Changes: a modified image shows "Before · Index" and "After · Working tree" (staged: "HEAD"
      and "Index"), side by side on desktop, stacked on a phone; a new image shows "Added", a
      deleted one "Deleted"; a staged rename names the old path
- [ ] Changes: replacing the image in the terminal, then Refresh, shows the new picture; waiting
      for the 5-second poll alone does not reload it

### Side Panel (Desktop)

- [ ] Dragging the panel's left edge resizes it, the terminal is fitted once on release;
      double-click resets the width; the width persists after reload
- [ ] The focused handle steps with arrow keys, Home/End go to the limits
- [ ] The terminal always keeps at least 360px next to the panel
- [ ] "Maximize panel" covers the terminal; "Restore panel" or Escape brings it back
- [ ] Narrowing the window to phone width moves the open view to the main area

---

## Mobile Gestures

Test on real mobile device:

| Gesture       | Expected Action                                              | Status |
| ------------- | ------------------------------------------------------------ | ------ |
| Swipe left    | Ctrl+C                                                       | [ ]    |
| Swipe right   | Tab                                                          | [ ]    |
| Drag up       | Scroll down, following the finger (tmux: one page per swipe) | [ ]    |
| Drag down     | Scroll up, following the finger (tmux: one page per swipe)   | [ ]    |
| Flick up/down | History keeps gliding, slows down, stops on the next touch   | [ ]    |
| Long press    | Paste                                                        | [ ]    |
| Pinch in      | Decrease font                                                | [ ]    |
| Pinch out     | Increase font                                                | [ ]    |
| Tap           | Focus terminal                                               | [ ]    |

### Scrolling & Copy Mode

- [ ] Scroll up/down acts as Page Up/Down when copy mode enabled
- [ ] Terminal shrinks to fit above the toolbar when the mobile keyboard is open (bottom rows stay visible)
- [ ] Terminal fits above the toolbar in Vietnamese IME input mode
- [ ] Scrolling still works (not blocked by swipe gestures)

### Copy Text (Select text sheet)

- [ ] Android Chrome: long press in the sheet shows handles; Copy puts the selection on the clipboard
- [ ] iOS Safari (PWA): long press in the sheet shows handles and the system menu; Copy works
- [ ] The sheet shows the history (tmux and Herdr), Load more reads more, Copy all copies it all
- [ ] A bidi or zero-width character shows as `⟨U+XXXX⟩` and pastes as the character itself
- [ ] View-only device: the sheet opens from the View only bar, shows the screen only, sends no `/text` request
- [ ] Settings > Copy on select: releasing a mouse drag copies, with a short toast; off by default
- [ ] Over plain HTTP on the LAN (no secure context): copying still works, or a clear error toast

### Gesture Hints Overlay

- [ ] First-time mobile users see gesture tutorial overlay
- [ ] Overlay dismissible
- [ ] Not shown again after dismissal (persists via settings)
- [ ] Can be re-shown from Settings (Gesture hints viewer)

### Edge Cases

- [ ] Gestures work in IME input mode
- [ ] No accidental triggers during normal typing

---

## Virtual Keyboard Toolbar

### Minimal Mode (Default)

- [ ] Toolbar visible above system keyboard
- [ ] Keyboard toggle button works (show/hide system keyboard)
- [ ] IME toggle button works (switch IME mode)
- [ ] History button opens command history dropdown
- [ ] Tab key sends Tab
- [ ] Esc key sends Escape
- [ ] Enter key sends Enter
- [ ] Ctrl modifier toggles (visual indicator, blue when active)
- [ ] Shift modifier toggles (visual indicator, orange when active)
- [ ] Arrow keys (←↑↓→) work
- [ ] Expand button visible
- [ ] Buttons use icons (readable size, not symbols)
- [ ] Long press on buttons does NOT trigger context menu

### Expanded Mode

- [ ] Expand button toggles to expanded view
- [ ] Home key sends Home
- [ ] End key sends End
- [ ] Delete key sends Delete
- [ ] Backspace key sends Backspace
- [ ] Page Up/Down keys work
- [ ] Insert key works
- [ ] Collapse button returns to minimal mode

### Ctrl Combos (Minimal)

- [ ] Ctrl+C (interrupt) works
- [ ] Ctrl+D (EOF) works
- [ ] Ctrl+Z (suspend) works
- [ ] Ctrl+L (clear) works
- [ ] Ctrl+A (beginning of line) works
- [ ] Ctrl+E (end of line) works

### Ctrl Combos (Expanded)

- [ ] Ctrl+B (back one char) works
- [ ] Ctrl+X (cut) works
- [ ] Ctrl+K (kill to end) works
- [ ] Ctrl+U (kill to start) works
- [ ] Ctrl+W (kill word) works
- [ ] Ctrl+R (reverse search) works
- [ ] Ctrl+P (previous command) works
- [ ] Ctrl+N (next command) works

### Ctrl+Shift Combos

- [ ] Ctrl+Shift+C with a mouse selection copies it and sends nothing (Chrome, Firefox, Edge on Linux/Windows); without a selection the keys reach the program
- [ ] Cmd+C on macOS copies a mouse selection
- [ ] Ctrl+Shift+V (paste) works
- [ ] Ctrl+Shift+Z (redo) works
- [ ] Ctrl+Shift+X (cut) works

### Utility Keys

- [ ] tmux copy mode toggle works
- [ ] Select text key: next to copy mode on tmux, in its place on Herdr
- [ ] Paste button works (from configured source)
- [ ] Scroll up/down buttons work

### Font Size

- [ ] Font size adjustable (6–24px range)
- [ ] Default font size is 14px
- [ ] Font size persists after reload

### IME Support

- [ ] Vietnamese input (IME) supported on mobile
- [ ] IME send behavior respects settings (send-only / send+enter)

---

## Quick Actions (Mobile)

- [ ] Quick actions key (⚡) visible in the keyboard toolbar on mobile, no floating button
- [ ] Tap the key opens the Quick actions sheet
- [ ] Clear action (sends 'clear' + Enter)
- [ ] Cancel action (sends Ctrl+C)
- [ ] Clear line action (sends Ctrl+U)
- [ ] Exit action (sends Ctrl+D)
- [ ] Attach image action (when the server takes uploads) opens the image picker
- [ ] Haptic feedback on actions

---

## Image Attachments (Terminal)

- [ ] The keyboard toolbar shows an "Attach image" key next to Paste when the server takes uploads
- [ ] A PNG, JPEG, GIF or WebP image picked from it is uploaded and its host path (quoted when it
      holds a space) is typed into the pane with a trailing space, without Enter
- [ ] Pasting an image-only clipboard (paste in the terminal, Paste key, long press) uploads it the
      same way; a clipboard holding text pastes the text
- [ ] Over 10 MB: "Image is larger than 10 MB"; another type: "Only PNG, JPEG, GIF and WebP images
      can be attached"; HEIC: "HEIC images are not supported. Share the photo as JPEG"
- [ ] A slow upload shows "Uploading image…"; switching pane before it ends shows "Image uploaded:
      <path>" with Insert
- [ ] The file lands in the user cache dir (`~/.cache/termote/uploads` on Linux) under a random name
- [ ] (Once a view-only role exists, #236) view-only offers no Attach image key or action; until
      then this is covered by unit tests only

---

## Command History

- [ ] History dropdown opens from toolbar button
- [ ] Searchable (case-insensitive)
- [ ] Keyboard navigation (arrow up/down, Enter to select, Esc to close)
- [ ] Visual selection highlight with auto-scroll
- [ ] Remove individual commands (trash icon)
- [ ] Clear all button
- [ ] Max 100 commands stored
- [ ] History persists after reload

---

## Authentication & Request Guards

### Basic Auth

- [ ] Browser prompts for credentials on first access
- [ ] Valid credentials grant access
- [ ] Invalid credentials denied (401)
- [ ] Auth persists across page refreshes (session cookie)
- [ ] Session cookie prevents double auth prompt on mobile
- [ ] Clear Cache & Reload clears session cookie (re-prompts auth)
- [ ] An empty saved password no longer disables auth — `start` on such a config generates
      and saves a new password instead

### Host Allowlist

- [ ] Request with an unrecognised `Host` header gets 403 (Sec-Fetch aside)
- [ ] Loopback (`localhost`, `127.0.0.1`, `::1`) is always allowed
- [ ] The address a request arrived on is allowed automatically when started with `--lan`
- [ ] Tailscale name is allowed automatically when started with `--tailscale`
- [ ] A name added with `--allow-host` is allowed and persisted across a restart
- [ ] No `*`/wildcard value disables the check

### Write / CSRF Guard

- [ ] A cross-site POST (`Sec-Fetch-Site: cross-site`) to `/api/mux/*` is rejected
- [ ] A `text/plain` POST to `/api/mux/panes/{id}/keys` is rejected (415)
- [ ] `/api/mux/stream` rejects a cross-site Origin
- [ ] `/api/mux/stream` rejects a missing/expired/reused stream token

### Brute-Force Protection

- [ ] Rate limiter blocks after 5 failed attempts/min per IP (429)
- [ ] Rate limiter blocks a whole IPv6 /64 after 20 failed attempts/min (429)
- [ ] Server log shows `auth: failed login from <ip>` and `auth: <ip> blocked ...`, without the
      username or password sent
- [ ] Constant-time password comparison

### Server Hardening

- [ ] ReadHeaderTimeout set (Slowloris protection)
- [ ] Request body size limited (8KB on `/api/mux/*` writes)
- [ ] Internal errors logged server-side only, generic messages to clients

### No Auth Mode

- [ ] `--no-auth` flag bypasses auth prompt
- [ ] Direct access without credentials
- [ ] `--mux herdr --no-auth` is refused unless `--allow-herdr-no-auth` is also given

---

## API Endpoints

```bash
# Health check
curl http://localhost:7680/api/mux/health

# Snapshot (groups → tabs → panes)
curl http://localhost:7680/api/mux/snapshot

# Create a tab
curl -X POST http://localhost:7680/api/mux/tabs \
  -H 'Content-Type: application/json' \
  -d '{"groupId":"main","name":"test"}'

# Select a tab
# Every write needs the JSON Content-Type, even without a body (else 415)
curl -X POST http://localhost:7680/api/mux/tabs/<id>/select \
  -H 'Content-Type: application/json'

# Rename a tab
curl -X PATCH http://localhost:7680/api/mux/tabs/<id> \
  -H 'Content-Type: application/json' \
  -d '{"name":"newname"}'

# Close a tab
curl -X DELETE http://localhost:7680/api/mux/tabs/<id> \
  -H 'Content-Type: application/json'

# Close a pane (Herdr only)
curl -X DELETE http://localhost:7680/api/mux/panes/<id> \
  -H 'Content-Type: application/json'

# Send keys to a pane
curl -X POST http://localhost:7680/api/mux/panes/<id>/keys \
  -H 'Content-Type: application/json' \
  -d '{"keys":"ls\n"}'

# Get a terminal stream token
curl http://localhost:7680/api/mux/stream-token
```

- [ ] Health endpoint returns 200 with `apiVersion`, `backend`, `version` and `install`
- [ ] Snapshot endpoint lists groups/tabs/panes
- [ ] Create tab works
- [ ] Select tab works (tmux; Herdr answers 501 because the PWA selects client-side)
- [ ] Rename tab works
- [ ] Close tab works
- [ ] Send keys works
- [ ] Stream token endpoint returns a valid single-use token (30s TTL)
- [ ] Invalid requests return proper errors (400/404/405/415)
- [ ] `/api/tmux/*` and `/terminal/` return 404/410, never a working response

---

## Cross-Platform

### Linux

- [ ] Container mode works
- [ ] Native mode works (tmux and Herdr backends)
- [ ] CLI detects correct architecture (x86_64/aarch64)

### macOS

- [ ] Container mode works (Docker Desktop or Podman)
- [ ] Native mode works
- [ ] Cross-compilation for Linux container works
- [ ] LAN IP detection works

### Windows

- [ ] Container mode works (Docker Desktop)
- [ ] Native mode works (psmux + termote)
- [ ] DPAPI password encryption works
- [ ] Link/Unlink creates the global `termote` command
- [ ] `termote` flags use the same Go syntax as Unix (`--lan`, `--no-auth`, `--port`,
      `--tailscale`, `--fresh`, `--mux`, `--allow-host`, `--allow-herdr-no-auth`)

---

## Build & CI/CD

```bash
make build
make test
```

- [ ] PWA builds without errors: `pnpm --filter termote build`
- [ ] TypeScript compiles: `pnpm --filter termote exec tsc --noEmit`
- [ ] Lint passes: `pnpm --filter termote lint:ci`
- [ ] Go builds without errors: `cd server && go build .`
- [ ] Go tests pass on Linux, macOS and Windows: `cd server && go test ./...`
- [ ] All shell tests pass: `make test`
- [ ] Website CI pipeline runs on push
- [ ] Website deploys successfully

---

## Unit Tests

```bash
pnpm --filter termote test
```

- [ ] All Vitest unit tests pass (hooks, utils, contexts)

## E2E Tests

```bash
pnpm --filter termote test:e2e
```

- [ ] All Playwright tests pass
- [ ] Tests work headless
- [ ] Tests work with `--ui` flag

---

## Notes

_Add any issues or observations during testing:_

-

---

**Tested by:** **\*\***\_\_\_**\*\***

**Date:** **\*\***\_\_\_**\*\***

**Version:** **\*\***\_\_\_**\*\***
