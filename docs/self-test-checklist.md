# Self-Test Checklist

Manual testing checklist for Termote features before release.

## Prerequisites

- [ ] tmux installed (macOS/Linux)
- [ ] psmux installed (Windows)
- [ ] ttyd installed
- [ ] Go 1.21+ (for native build)
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

### Native Mode (macOS/Linux)

- [ ] `./scripts/termote.sh install native` completes without error
- [ ] Processes running: `ps aux | grep -E 'ttyd|tmux-api'`
- [ ] PWA accessible at <http://localhost:7680>

### Native Mode (Windows)

- [ ] `.\scripts\termote.ps1 install native` completes without error
- [ ] psmux + ttyd + tmux-api running
- [ ] PWA accessible at <http://localhost:7690>

### Options

- [ ] `--lan` flag exposes to LAN (test from another device)
- [ ] `--no-auth` disables basic auth
- [ ] `/terminal/` blocked via direct browser URL (403 Forbidden)
- [ ] `/terminal/` accessible from mobile browser via LAN/Tailscale (no Sec-Fetch-Dest header)
- [ ] `/terminal/` loads in PWA iframe with valid token
- [ ] `--port <port>` changes port correctly
- [ ] `--tailscale <host>` configures Tailscale HTTPS
- [ ] `--fresh` forces new password (ignores saved config)
- [ ] Custom `TERMOTE_USER`/`TERMOTE_PASS` env vars work
- [ ] `WORKSPACE` env var mounts correct directory

### Config Persistence

- [ ] Password encrypted with AES-256-CBC + PBKDF2 (macOS/Linux)
- [ ] Password encrypted with DPAPI (Windows)
- [ ] Config file chmod 600
- [ ] Saved config reused on reinstall (mode, LAN, auth, port, Tailscale)

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
- [ ] Update preserves saved configuration
- [ ] Update re-links symlink if it existed
- [ ] Refuses to run from git repo (dev guard)
- [ ] Warns on downgrade, skips if already on target version

### Other CLI Commands

- [ ] `./scripts/termote.sh health` checks service health
- [ ] `./scripts/termote.sh logs` shows service logs
- [ ] `./scripts/termote.sh version` shows installed version

---

## PWA Features

### Basic

- [ ] PWA loads without console errors
- [ ] Terminal iframe connects via WebSocket
- [ ] Terminal renders correctly
- [ ] Typing sends input to terminal
- [ ] Output displays in terminal
- [ ] Terminal colors match dark mode theme
- [ ] Terminal colors match light mode theme
- [ ] Theme switching does not reload terminal (no disconnect/reconnect)
- [ ] Correct terminal theme applied after page reload (F5)
- [ ] Desktop: Icon list displays correctly (no layout issues)
- [ ] About page looks good in dark mode
- [ ] Settings button clickable on mobile
- [ ] Clear Cache & Reload button works (unregisters SW, clears caches, clears session cookie, reloads)

### Connection Indicator

- [ ] Shows "connecting" state (yellow pulsing dot) on initial load
- [ ] Shows "connected" state (green dot, Wifi icon) when active
- [ ] Shows "disconnected" state (red dot, WifiOff icon) when server unreachable
- [ ] Clickable when disconnected — triggers iframe reconnect

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

## Session Management

### Session Sidebar

- [ ] Sidebar opens (swipe from left edge or hamburger icon)
- [ ] Sidebar scrollable when many sessions exist
- [ ] Sidebar collapse/expand toggle works (desktop)
- [ ] Collapsed sidebar shows icons only with tooltips (desktop)
- [ ] Create new session works
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

### tmux Sessions

- [ ] Sessions created via API: `curl localhost:7680/api/tmux/windows`
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

## Authentication

### Basic Auth

- [ ] Browser prompts for credentials on first access
- [ ] Valid credentials grant access
- [ ] Invalid credentials denied (401)
- [ ] Auth persists across page refreshes (session cookie)
- [ ] Session cookie prevents double auth prompt on mobile iframe loads
- [ ] Clear Cache & Reload clears session cookie (re-prompts auth)

### Brute-Force Protection

- [ ] Rate limiter blocks after 5 failed attempts/min per IP (429)
- [ ] Constant-time password comparison

### Server Hardening

- [ ] ReadHeaderTimeout set (Slowloris protection)
- [ ] Request body size limited (8KB on send-keys)
- [ ] Internal errors logged server-side only, generic messages to clients

### No Auth Mode

- [ ] `--no-auth` flag bypasses auth prompt
- [ ] Direct access without credentials

---

## API Endpoints

```bash
# Health check
curl http://localhost:7680/api/tmux/health

# List windows
curl http://localhost:7680/api/tmux/windows

# Create window
curl -X POST 'http://localhost:7680/api/tmux/new?name=test'

# Select window
curl -X POST http://localhost:7680/api/tmux/select/1

# Rename window
curl -X POST 'http://localhost:7680/api/tmux/rename/1?name=newname'

# Kill window
curl -X DELETE http://localhost:7680/api/tmux/kill/1

# Send keys
curl -X POST http://localhost:7680/api/tmux/send-keys \
  -H 'Content-Type: application/json' \
  -d '{"target":"1","keys":"ls"}'

# Get terminal token
curl http://localhost:7680/api/tmux/terminal-token
```

- [ ] Health endpoint returns 200
- [ ] Windows endpoint lists tmux windows
- [ ] Create window works
- [ ] Select window works
- [ ] Rename window works
- [ ] Kill window works
- [ ] Send keys works
- [ ] Terminal token endpoint returns valid single-use token (30s TTL)
- [ ] Invalid requests return proper errors

---

## WebSocket Proxy

- [ ] WebSocket connects through tmux-api (not direct to ttyd)
- [ ] Proxy handles reconnection gracefully
- [ ] No CORS errors in console
- [ ] Connection stable over extended use

---

## Cross-Platform

### Linux

- [ ] Container mode works
- [ ] Native mode works
- [ ] Scripts detect correct architecture (x86_64/aarch64)

### macOS

- [ ] Container mode works (Docker Desktop or Podman)
- [ ] Native mode works
- [ ] Cross-compilation for Linux container works
- [ ] `ipconfig getifaddr en0` fallback works for LAN IP

### Windows

- [ ] Container mode works (Docker Desktop)
- [ ] Native mode works (psmux + ttyd + tmux-api)
- [ ] PowerShell script handles DPAPI password encryption
- [ ] Link/Unlink creates global command
- [ ] `termote.ps1` flags: `-Lan`, `-NoAuth`, `-Port`, `-Tailscale`, `-Fresh`

---

## Build & CI/CD

```bash
make build
make test
```

- [ ] PWA builds without errors: `cd pwa && pnpm build`
- [ ] TypeScript compiles: `cd pwa && pnpm tsc --noEmit`
- [ ] Lint passes: `cd pwa && pnpm biome check .`
- [ ] Go builds without errors: `cd tmux-api && go build`
- [ ] All shell tests pass: `make test`
- [ ] All Go tests pass: `cd tmux-api && go test ./...`
- [ ] Website CI pipeline runs on push
- [ ] Website deploys successfully

---

## Unit Tests

```bash
cd pwa && pnpm test
```

- [ ] All Vitest unit tests pass (hooks, utils, contexts)

## E2E Tests

```bash
cd pwa && pnpm test:e2e
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
