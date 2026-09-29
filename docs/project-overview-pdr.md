# Project Overview - Termote

## Summary

**Termote** (Terminal + Remote) is a Progressive Web App for remotely controlling CLI tools from mobile/desktop devices via touch-friendly interface.

## Problem Statement

- CLI tools (Claude Code, GitHub Copilot) are keyboard-centric, difficult to use on mobile
- Need persistent terminal sessions accessible from anywhere
- Existing solutions lack mobile-optimized gestures and virtual keyboards

## Solution

PWA whose Go server (termote) streams a real terminal (PTY on Unix, ConPTY on Windows)
straight into an xterm.js terminal in the page, with:

- Touch gestures mapped to common shortcuts (swipe → Ctrl+C, Tab, arrows)
- Virtual keyboard toolbar for modifier keys
- Session management via a `Mux` backend abstraction: tmux/psmux, or Herdr workspaces
  (native or inside the container) with per-pane coding-agent status
- Responsive UI for phone/tablet/desktop
- Customizable settings (IME send behavior, toolbar expand, context menu control)
- Persistent storage for user preferences
- Session cookies for seamless mobile authentication
- Context menu control for terminal area (disable right-click)
- Request guards (Host allowlist, Origin/CSRF checks, single-use stream token) protecting
  every request and the terminal WebSocket

## Features

| Feature                | Description                                                      |
| ---------------------- | ---------------------------------------------------------------- |
| Session Management     | Create, switch, delete tabs via UI (tmux windows, or Herdr tabs) |
| Session Tabs           | Horizontal tab bar for quick tab switching                       |
| Herdr Backend          | Alternative to tmux with per-pane agent-status badges            |
| Virtual Keyboard       | Touch-friendly buttons for special keys                          |
| Keyboard Gestures      | Swipe, long-press, pinch for common shortcuts                    |
| Gesture Hints          | First-time overlay teaching touch gestures (mobile)              |
| Theme Support          | Light/dark/system theme toggle (in-place switching)              |
| Font Scaling           | Adjustable terminal font size (6-24px)                           |
| Nerd Font Icons        | Bundled Symbols Nerd Font; optional custom terminal font         |
| Fullscreen Mode        | Desktop-only fullscreen terminal view                            |
| Context Menu Control   | Disable right-click menu on terminal (default: enabled)          |
| Settings / Preferences | IME behavior, toolbar default, context menu, poll interval       |
| Paste Source Config    | Choose paste source: system clipboard or tmux buffer             |
| Toast Notifications    | Error feedback for clipboard access issues                       |
| Persistent Settings    | User preferences saved to localStorage                           |
| Session Poll Interval  | Configurable sync frequency (3s-5m) to reduce server spam        |
| Connection Indicator   | Real-time server status with auto-detection of disconnects       |
| Command History        | Search and recall previously sent commands                       |
| Quick Actions Menu     | FAB with preset commands (clear, cancel, exit)                   |
| Update Checker         | Auto-detect new releases via GitHub, show notifications          |
| Session Cookie Auth    | Prevents double basic auth prompt on mobile                      |
| iOS Safe Area          | Respects status bar safe area inset                              |
| Basic Authentication   | HTTP basic auth + Host allowlist + Origin/CSRF guards            |
| Brute-force Protection | Rate limiter (5 failed attempts/min per IP)                      |
| Self-Update            | Fetch & install latest release, preserve config                  |

## Target Users

- Developers monitoring/controlling AI coding assistants remotely
- DevOps engineers managing servers from mobile
- Anyone needing quick terminal access on the go

## Tech Decisions

| Decision     | Rationale                                                                                                                        |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| React + Vite | Fast dev, good PWA support                                                                                                       |
| xterm.js     | Standard terminal emulator; termote streams to it directly, no ttyd                                                              |
| Mux backend  | Interface over tmux/psmux and Herdr: persistent sessions, tab/pane management, one backend to add later without changing the API |
| Go (termote) | Unified server: PWA, auth, terminal WebSocket, API, CLI                                                                          |
| TailwindCSS  | Rapid styling, responsive utilities                                                                                              |

## Success Metrics

- Mobile usability: <3 taps to send common commands
- Session persistence: survive browser refresh/close
- Response latency: <100ms keystroke to display

## Constraints

- Single user (basic auth is sufficient)
- Local/VPN network only (not public internet)
- Self-hosted deployment required
