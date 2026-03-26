# Self-Test Checklist

Manual testing checklist for Termote features before release.

## Prerequisites

- [ ] tmux installed
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
- [ ] Auto-generated credentials shown in logs: `docker logs termote`

### Native Mode

- [ ] `./scripts/termote.sh install native` completes without error
- [ ] Processes running: `ps aux | grep -E 'ttyd|tmux-api'`
- [ ] PWA accessible at <http://localhost:7680>

### Options

- [ ] `--lan` flag exposes to LAN (test from another device)
- [ ] `--no-auth` disables basic auth
- [ ] `/terminal/` blocked via direct browser URL (403 Forbidden)
- [ ] `/terminal/` accessible from mobile browser via LAN/Tailscale (no Sec-Fetch-Dest header)
- [ ] `/terminal/` loads in PWA iframe with valid token
- [ ] `--port <port>` changes port correctly
- [ ] `--tailscale <host>` configures Tailscale HTTPS
- [ ] Custom `TERMOTE_USER`/`TERMOTE_PASS` env vars work
- [ ] `WORKSPACE` env var mounts correct directory

### Uninstall

- [ ] `./scripts/termote.sh uninstall container` removes container
- [ ] `./scripts/termote.sh uninstall native` stops processes
- [ ] `./scripts/termote.sh uninstall all` cleans everything

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
- [ ] Desktop: Icon list displays correctly (no layout issues)
- [ ] About page looks good in dark mode
- [ ] Settings button clickable on mobile
- [ ] Clear Cache & Reload button works (unregisters SW, clears caches, reloads)

### Install/Offline

- [ ] PWA installable to homescreen (mobile/desktop)
- [ ] Service worker registered
- [ ] Offline mode shows cached shell

### Help & Documentation

- [ ] Basic usage guide accessible
- [ ] Common tmux shortcuts documented
- [ ] Frequently used key combinations listed

---

## Session Management

### Session Switching

- [ ] Sidebar opens (swipe from left edge or hamburger icon)
- [ ] Sidebar scrollable when many sessions exist
- [ ] Sidebar collapse/expand toggle works (desktop)
- [ ] Collapsed sidebar shows icons only with tooltips (desktop)
- [ ] Create new session works
- [ ] Edit session name works
- [ ] Delete session works
- [ ] Clicking session switches terminal
- [ ] Active session highlighted in sidebar
- [ ] Sessions persist after page refresh

### Fullscreen (Desktop)

- [ ] Fullscreen button visible in header (desktop only)
- [ ] Click toggles fullscreen mode
- [ ] Icon changes between Maximize/Minimize
- [ ] Esc/F11 exits fullscreen and syncs button state

### Session Actions (Mobile)

- [ ] Edit/Delete buttons hidden by default
- [ ] Swipe left/right on session item reveals Edit/Delete buttons

### tmux Sessions

- [ ] Sessions created via API: `curl localhost:7680/api/tmux/sessions`
- [ ] Switch session via API works
- [ ] Session state persists across terminal reconnects

---

## Mobile Gestures

Test on real mobile device:

| Gesture     | Expected Action  | Status |
| ----------- | ---------------- | ------ |
| Swipe left  | Ctrl+C           | [ ]    |
| Swipe right | Tab              | [ ]    |
| Swipe up    | History up (↑)   | [ ]    |
| Swipe down  | History down (↓) | [ ]    |
| Long press  | Paste            | [ ]    |
| Pinch in    | Decrease font    | [ ]    |
| Pinch out   | Increase font    | [ ]    |

### Scrolling & Copy Mode

- [ ] Scroll up/down acts as Page Up/Down when copy mode enabled
- [ ] Terminal scrollable when mobile keyboard is open
- [ ] Terminal scrollable in Vietnamese IME input mode
- [ ] Scrolling still works (not blocked by swipe gestures)

### Edge Cases

- [ ] Gestures work in IME input mode
- [ ] No accidental triggers during normal typing

---

## Virtual Keyboard Toolbar

### Minimal Mode (Default)

- [ ] Toolbar visible above system keyboard
- [ ] Tab key sends Tab
- [ ] Esc key sends Escape
- [ ] Enter key sends Enter
- [ ] Ctrl modifier toggles (visual indicator)
- [ ] Shift modifier toggles (visual indicator)
- [ ] Arrow keys (←↑↓→) work
- [ ] Expand button visible
- [ ] Buttons use icons (readable size, not symbols)
- [ ] Long press on buttons does NOT trigger context menu

### Expanded Mode

- [ ] Expand button toggles to expanded view
- [ ] Home key sends Home
- [ ] End key sends End
- [ ] Delete key sends Delete
- [ ] Page Up/Down keys work
- [ ] A-/A+ font size buttons work
- [ ] Collapse button returns to minimal mode

### Modifier Combinations

- [ ] Ctrl+C (interrupt) works
- [ ] Ctrl+L (clear) works
- [ ] Ctrl+D (EOF) works
- [ ] Ctrl+Z (suspend) works
- [ ] Ctrl+Shift+V (paste) works
- [ ] Ctrl+Shift+C (copy) works

### IME Support

- [ ] Vietnamese input (IME) supported on mobile

---

## Authentication

### Basic Auth

- [ ] Browser prompts for credentials on first access
- [ ] Valid credentials grant access
- [ ] Invalid credentials denied (401)
- [ ] Auth persists across page refreshes
- [ ] Logout clears session

### No Auth Mode

- [ ] `--no-auth` flag bypasses auth prompt
- [ ] Direct access without credentials

---

## API Endpoints

```bash
# Health check
curl http://localhost:7680/api/tmux/health

# List sessions
curl http://localhost:7680/api/tmux/sessions

# Create session
curl -X POST http://localhost:7680/api/tmux/sessions \
  -H 'Content-Type: application/json' \
  -d '{"name":"test"}'

# Switch session
curl -X POST http://localhost:7680/api/tmux/switch \
  -H 'Content-Type: application/json' \
  -d '{"session":"test"}'
```

- [ ] Health endpoint returns 200
- [ ] Sessions endpoint lists tmux sessions
- [ ] Create session works
- [ ] Switch session works
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

### Windows (WSL2)

- [ ] Container mode works in WSL2
- [ ] Scripts run in WSL bash

---

## Build & CI/CD

```bash
make build
make test
```

- [ ] PWA builds without errors: `cd pwa && pnpm build`
- [ ] TypeScript compiles: `cd pwa && pnpm tsc --noEmit`
- [ ] Go builds without errors: `cd tmux-api && go build`
- [ ] All shell tests pass: `make test`
- [ ] Website CI pipeline runs on push
- [ ] Website deploys successfully

---

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
-
- ***

  **Tested by:** **\*\***\_\_\_**\*\***

  **Date:** **\*\***\_\_\_**\*\***

  **Version:** **\*\***\_\_\_**\*\***
