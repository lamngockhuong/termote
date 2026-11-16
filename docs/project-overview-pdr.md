# Project Overview - Termote

## Summary

**Termote** (Terminal + Remote) is a Progressive Web App for remotely controlling CLI tools from mobile/desktop devices via touch-friendly interface.

## Problem Statement

- CLI tools (Claude Code, Codex, OpenCode, GitHub Copilot) are keyboard-centric, difficult to use on mobile
- Need persistent terminal sessions accessible from anywhere
- Existing solutions lack mobile-optimized gestures and virtual keyboards

## Solution

PWA whose Go server (termote) streams a real terminal (PTY on Unix, ConPTY on Windows)
straight into an xterm.js terminal in the page, with:

- Touch gestures mapped to common shortcuts (swipe → Ctrl+C, Tab, arrows)
- Virtual keyboard toolbar for modifier keys
- Session management via a `Mux` backend abstraction: tmux/psmux, Herdr workspaces (native or
  inside the container) with per-pane coding-agent status, Zellij sessions, or herdr-core
- A Chat view that reads and answers Claude Code, Codex and OpenCode, with their session history,
  tokens and cost
- Responsive UI for phone/tablet/desktop
- Customizable settings (IME send behavior, toolbar expand, context menu control)
- Persistent storage for user preferences
- Session cookies for seamless mobile authentication
- Context menu control for terminal area (disable right-click)
- Request guards (Host allowlist, Origin/CSRF checks, single-use stream token) protecting
  every request and the terminal WebSocket

## Features

| Feature                | Description                                                           |
| ---------------------- | --------------------------------------------------------------------- |
| Session Management     | Create, switch, delete tabs via UI (tmux windows, or Herdr tabs)      |
| Session Tabs           | Horizontal tab bar for quick tab switching                            |
| Herdr Backend          | Alternative to tmux with per-pane agent-status badges                 |
| Zellij, herdr-core     | More backends, chosen with `--mux zellij` or `--mux hc`               |
| Chat View              | Read and answer Claude Code, Codex and OpenCode as a chat             |
| Session History        | List, read, resume and fork an agent's past sessions in a folder      |
| Tokens and Cost        | Tokens and estimated cost per agent session, with daily totals        |
| Files and Changes      | Browse, preview and edit files; review, stage and discard git changes |
| Tasks                  | Run `package.json` scripts and Makefile targets of a pane             |
| Worktrees              | Open a git worktree as a group of its own                             |
| Machines               | Reach other computers' Termote over SSH                               |
| Device Pairing         | One-time code signs a new device in, view only or full                |
| Open in Windows        | Under WSL, copy a file's Windows path or open it in Windows           |
| Settings Export        | Export and import settings; review settings an agent proposes         |
| Virtual Keyboard       | Touch-friendly buttons for special keys                               |
| Keyboard Gestures      | Swipe, long-press, pinch for common shortcuts                         |
| Welcome Screen & Tour  | First-visit summary of the install, 4-step tour (EN/VI)               |
| Interface Language     | English or Vietnamese across the PWA, chosen in Settings (or Auto)    |
| Theme Support          | Light/dark/system theme toggle (in-place switching)                   |
| Font Scaling           | Adjustable terminal font size (6-24px)                                |
| Nerd Font Icons        | Bundled Symbols Nerd Font; optional custom terminal font              |
| Fullscreen Mode        | Desktop-only fullscreen terminal view                                 |
| Context Menu Control   | Disable right-click menu on terminal (default: enabled)               |
| Settings / Preferences | IME behavior, toolbar default, context menu, poll interval            |
| Paste Source Config    | Choose paste source: system clipboard or tmux buffer                  |
| Toast Notifications    | Error feedback for clipboard access issues                            |
| Persistent Settings    | User preferences saved to localStorage                                |
| Session Poll Interval  | Configurable sync frequency (3s-5m) to reduce server spam             |
| Connection Indicator   | Real-time server status with auto-detection of disconnects            |
| Command History        | Search and recall previously sent commands                            |
| Quick Actions          | Actions row, expanded toolbar: preset commands (clear, cancel, exit)  |
| Interface Styles       | Neutral, Terminal or Native, independent of light/dark theme          |
| Deep Links             | Shareable `#/s/<group>/<tab>` addresses that select a session         |
| Agent Overview         | Every agent (`#/overview`): dialog queue, history, subagents, log     |
| Update Checker         | Auto-detect new releases via GitHub, show notifications               |
| Session Cookie Auth    | Prevents double basic auth prompt on mobile                           |
| iOS Safe Area          | Respects status bar safe area inset                                   |
| Basic Authentication   | HTTP basic auth + Host allowlist + Origin/CSRF guards                 |
| Brute-force Protection | Rate limiter (5 failed attempts/min per IP, 20/min per IPv6 /64)      |
| Self-Update            | Fetch & install latest release, preserve config                       |

## Target Users

- Developers monitoring/controlling AI coding assistants remotely
- DevOps engineers managing servers from mobile
- Anyone needing quick terminal access on the go

## Tech Decisions

| Decision     | Rationale                                                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| React + Vite | Fast dev, good PWA support                                                                                                                  |
| xterm.js     | Standard terminal emulator; termote streams to it directly, no ttyd                                                                         |
| Mux backend  | Interface over tmux/psmux, Herdr, Zellij and herdr-core: persistent sessions, tab/pane management, a backend added without changing the API |
| Go (termote) | Unified server: PWA, auth, terminal WebSocket, API, CLI                                                                                     |
| TailwindCSS  | Rapid styling, responsive utilities                                                                                                         |

## Success Metrics

- Mobile usability: <3 taps to send common commands
- Session persistence: survive browser refresh/close
- Response latency: <100ms keystroke to display

## Constraints

- Single user; other devices sign in with the password or a pairing code
- Never exposed directly to the public internet: local network, VPN (Tailscale), or a Cloudflare
  Tunnel with Cloudflare Access in front
- Self-hosted deployment required
