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
| Go (tmux-api) | Lightweight HTTP API for tmux control, single binary |
| nginx proxy   | Basic auth, WebSocket, single origin for PWA         |
| TailwindCSS   | Rapid styling, responsive utilities                  |

## Success Metrics

- Mobile usability: <3 taps to send common commands
- Session persistence: survive browser refresh/close
- Response latency: <100ms keystroke to display

## Constraints

- Single user (basic auth is sufficient)
- Local/VPN network only (not public internet)
- Self-hosted deployment required
