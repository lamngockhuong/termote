# Project Overview - Termote

## Summary

**Termote** (Terminal + Remote) is a Progressive Web App for remotely controlling CLI tools from mobile/desktop devices via touch-friendly interface.

## Problem Statement

- CLI tools (Claude Code, GitHub Copilot) are keyboard-centric, difficult to use on mobile
- Need persistent terminal sessions accessible from anywhere
- Existing solutions lack mobile-optimized gestures and virtual keyboards

## Solution

PWA that wraps ttyd terminals with:

- Touch gestures mapped to common shortcuts (swipe → Ctrl+C, Tab, arrows)
- Virtual keyboard toolbar for modifier keys
- Session management via tmux integration
- Responsive UI for phone/tablet/desktop
- Customizable settings (IME send behavior, toolbar expand, context menu control)
- Persistent storage for user preferences
- Session cookies for seamless mobile authentication
- Context menu control for terminal area (disable right-click)

## Features

| Feature                | Description                                                |
| ---------------------- | ---------------------------------------------------------- |
| Session Management     | Create, switch, delete tmux windows via UI                 |
| Virtual Keyboard       | Touch-friendly buttons for special keys                    |
| Keyboard Gestures      | Swipe, long-press, pinch for common shortcuts              |
| Gesture Hints          | First-time overlay teaching touch gestures (mobile)        |
| Theme Support          | Light/dark/system theme toggle (in-place switching)        |
| Font Scaling           | Adjustable terminal font size (6-24px)                     |
| Fullscreen Mode        | Desktop-only fullscreen terminal view                      |
| Context Menu Control   | Disable right-click menu on terminal (default: enabled)    |
| Settings / Preferences | IME behavior, toolbar default, context menu, poll interval |
| Paste Source Config    | Choose paste source: system clipboard or tmux buffer       |
| Toast Notifications    | Error feedback for clipboard access issues                 |
| Persistent Settings    | User preferences saved to localStorage                     |
| Session Poll Interval  | Configurable sync frequency (3s-5m) to reduce server spam  |
| Session Cookie Auth    | Prevents double basic auth prompt on mobile                |
| iOS Safe Area          | Respects status bar safe area inset                        |
| Basic Authentication   | HTTP basic auth + iframe-only terminal access              |
| Brute-force Protection | Rate limiter (5 failed attempts/min per IP)                |
| Self-Update            | Fetch & install latest release, preserve config            |

## Target Users

- Developers monitoring/controlling AI coding assistants remotely
- DevOps engineers managing servers from mobile
- Anyone needing quick terminal access on the go

## Tech Decisions

| Decision      | Rationale                                            |
| ------------- | ---------------------------------------------------- |
| React + Vite  | Fast dev, good PWA support                           |
| xterm.js      | Standard terminal emulator, ttyd protocol compatible |
| tmux backend  | Persistent sessions, window management               |
| Go (tmux-api) | Unified server: PWA, auth, WebSocket proxy, API      |
| TailwindCSS   | Rapid styling, responsive utilities                  |

## Success Metrics

- Mobile usability: <3 taps to send common commands
- Session persistence: survive browser refresh/close
- Response latency: <100ms keystroke to display

## Constraints

- Single user (basic auth is sufficient)
- Local/VPN network only (not public internet)
- Self-hosted deployment required
