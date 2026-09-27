# Self-Test Checklist

Manual testing checklist for Termote features before release.

## Prerequisites

- [ ] tmux installed (macOS/Linux)
- [ ] psmux installed (Windows)
- [ ] herdr installed (only for Herdr backend testing, native)
- [ ] Go 1.24+ (for native build)
- [ ] Node.js 18+ & pnpm (for PWA build)
- [ ] Docker or Podman (for container mode)
- [ ] Mobile device or emulator (for gesture testing)

---

## Installation

### Container Mode

- [ ] `./scripts/termote.sh install container` completes without error
- [ ] Container running: `docker ps | grep termote`
- [ ] PWA accessible at <http://localhost:7680>
- [ ] Auto-generated credentials shown in logs
- [ ] `--mux herdr` is refused in container mode

### Native Mode (macOS/Linux)

- [ ] `./scripts/termote.sh install native` completes without error
- [ ] Process running: `ps aux | grep termote-server`
- [ ] PWA accessible at <http://localhost:7680>

### Native Mode (Windows)

- [ ] `.\scripts\termote.ps1 install native` completes without error
- [ ] psmux + termote running
- [ ] PWA accessible at <http://localhost:7690>

### Native Mode + Herdr (Linux)

- [ ] `./scripts/termote.sh install native --mux herdr` completes without error (herdr on `PATH`)
- [ ] `curl localhost:7680/api/mux/health` reports `"backend":"herdr"`
- [ ] `--mux herdr --no-auth` is refused unless `--allow-herdr-no-auth` is also given
- [ ] PWA lists the same workspaces/tabs/panes as `herdr pane list`
- [ ] Selecting a tab/pane on the PWA does not change the Herdr desktop's focused tab
- [ ] Agent status badge changes within one `pollInterval` after `herdr` reports a status change
- [ ] Typing from the PWA lands in the correct order in the Herdr pane (no interleaving)

### Options

- [ ] `--lan` flag exposes to LAN (test from another device)
- [ ] `--no-auth` disables basic auth
- [ ] `--port <port>` changes port correctly
- [ ] `--tailscale <host>` configures Tailscale HTTPS and adds the name to the Host allowlist
- [ ] `--fresh` forces new password (ignores saved config)
- [ ] `--allow-host <name>` adds a name to the Host allowlist (persisted); a request with an
      unlisted `Host` header gets 403 with that exact flag suggested
- [ ] A request from an unrecognised LAN hostname/IP is rejected (403) until added with
      `--allow-host`
- [ ] `--ttyd`/`-Ttyd` is accepted and ignored, with a warning
- [ ] Custom `TERMOTE_USER`/`TERMOTE_PASS` env vars work
- [ ] `WORKSPACE` env var mounts correct directory

### Config Persistence

- [ ] Password encrypted with AES-256-CBC + PBKDF2 (macOS/Linux)
- [ ] Password encrypted with DPAPI (Windows)
- [ ] Config file chmod 600
- [ ] Saved config reused on reinstall (mode, LAN, auth, port, mux, allowlist, Tailscale)
- [ ] `show-password` prints the saved password; refuses when `--no-auth` or undecryptable

### Uninstall

- [ ] `./scripts/termote.sh uninstall all` cleans everything (stops services, removes config)

### Link/Unlink

- [ ] `./scripts/termote.sh link` creates symlink (tries /usr/local/bin, falls back to ~/.local/bin)
- [ ] `termote help` works after linking
- [ ] `./scripts/termote.sh unlink` removes symlink and shows restore hint

### Update

- [ ] `./scripts/termote.sh update` updates to latest release
- [ ] `./scripts/termote.sh update --version X.Y.Z` pins to specific version
- [ ] `./scripts/termote.sh update --force` reinstalls current version
- [ ] Update preserves saved configuration (mode, LAN, auth, port, mux, allowlist, Tailscale)
- [ ] Update re-links symlink if it existed
- [ ] Refuses to run from git repo (dev guard)
- [ ] Warns on downgrade, skips if already on target version
- [ ] A real 0.1.0 install updated to 1.0.0 keeps its settings, drops any Termote-started ttyd
      process (and, on Windows, `scripts/ttyd.exe`), and an empty saved password is replaced
      with a new generated one (see [`upgrade-1.0.md`](upgrade-1.0.md))

### Other CLI Commands

- [ ] `./scripts/termote.sh health` checks service health
- [ ] `./scripts/termote.sh logs` shows service logs
- [ ] `./scripts/termote.sh version` shows installed version

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
- [ ] Settings button clickable on mobile
- [ ] Clear Cache & Reload button works (unregisters SW, clears caches, clears session cookie, reloads)

### Connection Indicator

- [ ] Shows "connecting" state (yellow pulsing dot) on initial load
- [ ] Shows "connected" state (green dot, Wifi icon) when active
- [ ] Shows "disconnected" state (red dot, WifiOff icon) when server unreachable
- [ ] Clickable when disconnected — triggers a reconnect

### Toast Notifications

- [ ] Toast appears for clipboard errors, paste failures, update availability
- [ ] Auto-dismisses after ~4 seconds
- [ ] Positioned bottom-center above toolbar

### Preferences (Settings Modal)

- [ ] Preferences modal opens from Settings menu
- [ ] IME send behavior toggle works (Send text only / Send + Enter)
- [ ] Paste source toggle works (System clipboard / tmux buffer)
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
- [ ] Theme toggle accessible in settings menu
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

- [ ] Sidebar opens (swipe from left edge or hamburger icon)
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

### Session Tabs (Desktop)

- [ ] Tab bar visible when setting enabled
- [ ] Tabs scroll into view when switching
- [ ] Clicking tab switches session
- [ ] Active tab highlighted

### Pane Strip (multi-pane tabs, Herdr only)

- [ ] Pane strip is hidden for a tab with a single pane
- [ ] Pane strip appears for a tab with more than one pane, with an agent-status badge per pane
- [ ] Selecting a pane switches the stream without changing the Herdr desktop's focus

### Bottom Navigation (Mobile)

- [ ] Bottom nav visible on mobile only
- [ ] Shows sidebar toggle, add button, and first 5 session icons
- [ ] Tapping session icon switches session

### Fullscreen (Desktop)

- [ ] Fullscreen button visible in header (desktop only)
- [ ] Click toggles fullscreen mode
- [ ] Icon changes between Maximize/Minimize
- [ ] Esc/F11 exits fullscreen and syncs button state

### Session Actions (Mobile)

- [ ] Edit/Delete buttons hidden by default
- [ ] Swipe left/right on session item reveals Edit/Delete buttons

### Sessions via API

- [ ] Sessions listed via API: `curl localhost:7680/api/mux/snapshot`
- [ ] Switch session via API works
- [ ] Session state persists across terminal reconnects

---

## Mobile Gestures

Test on real mobile device:

| Gesture     | Expected Action | Status |
| ----------- | --------------- | ------ |
| Swipe left  | Ctrl+C          | [ ]    |
| Swipe right | Tab             | [ ]    |
| Swipe up    | Scroll down     | [ ]    |
| Swipe down  | Scroll up       | [ ]    |
| Long press  | Paste           | [ ]    |
| Pinch in    | Decrease font   | [ ]    |
| Pinch out   | Increase font   | [ ]    |
| Tap         | Focus terminal  | [ ]    |

### Scrolling & Copy Mode

- [ ] Scroll up/down acts as Page Up/Down when copy mode enabled
- [ ] Terminal scrollable when mobile keyboard is open
- [ ] Terminal scrollable in Vietnamese IME input mode
- [ ] Scrolling still works (not blocked by swipe gestures)

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

- [ ] Ctrl+Shift+C (copy) works
- [ ] Ctrl+Shift+V (paste) works
- [ ] Ctrl+Shift+Z (redo) works
- [ ] Ctrl+Shift+X (cut) works

### Utility Keys

- [ ] tmux copy mode toggle works
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

## Quick Actions Menu (Mobile)

- [ ] FAB button visible on mobile
- [ ] Tap FAB opens action menu
- [ ] Clear action (sends 'clear' + Enter)
- [ ] Cancel action (sends Ctrl+C)
- [ ] Clear line action (sends Ctrl+U)
- [ ] Exit action (sends Ctrl+D)
- [ ] FAB draggable (touch drag to reposition)
- [ ] FAB position persists after reload
- [ ] FAB clamps within viewport bounds
- [ ] Haptic feedback on actions

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
- [ ] An empty saved password no longer disables auth — `install` on such a config generates
      and saves a new password instead

### Host Allowlist

- [ ] Request with an unrecognised `Host` header gets 403 (Sec-Fetch aside)
- [ ] Loopback (`localhost`, `127.0.0.1`, `::1`) is always allowed
- [ ] LAN IP is allowed automatically when installed with `--lan`
- [ ] Tailscale name is allowed automatically when installed with `--tailscale`
- [ ] A name added with `--allow-host` is allowed and persisted across reinstall
- [ ] No `*`/wildcard value disables the check

### Write / CSRF Guard

- [ ] A cross-site POST (`Sec-Fetch-Site: cross-site`) to `/api/mux/*` is rejected
- [ ] A `text/plain` POST to `/api/mux/panes/{id}/keys` is rejected (415)
- [ ] `/api/mux/stream` rejects a cross-site Origin
- [ ] `/api/mux/stream` rejects a missing/expired/reused stream token

### Brute-Force Protection

- [ ] Rate limiter blocks after 5 failed attempts/min per IP (429)
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

# Send keys to a pane
curl -X POST http://localhost:7680/api/mux/panes/<id>/keys \
  -H 'Content-Type: application/json' \
  -d '{"keys":"ls\n"}'

# Get a terminal stream token
curl http://localhost:7680/api/mux/stream-token
```

- [ ] Health endpoint returns 200 with `apiVersion` and `backend`
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
- [ ] PowerShell script handles DPAPI password encryption
- [ ] Link/Unlink creates global command
- [ ] `termote.ps1` flags: `-Lan`, `-NoAuth`, `-Port`, `-Tailscale`, `-Fresh`, `-Mux`,
      `-AllowHost`, `-AllowHerdrNoAuth`

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
