# CLAUDE.md

Instructions for Claude Code when working with this repository.

## Project Overview

**Termote** = Terminal + Remote

A PWA for remotely controlling CLI tools (Claude Code, GitHub Copilot, any terminal) from mobile/desktop.

## Tech Stack

| Layer           | Technology                                 |
| --------------- | ------------------------------------------ |
| Frontend        | React 18 + TypeScript + Vite + TailwindCSS |
| PWA             | vite-plugin-pwa + Workbox                  |
| Terminal        | ttyd (WebSocket terminal)                  |
| Proxy           | nginx (reverse proxy + basic auth)         |
| Sessions        | tmux (persistent sessions)                 |
| Package Manager | pnpm                                       |

## Project Structure

```
termote/
├── pwa/                    # React PWA frontend
│   ├── src/
│   │   ├── components/     # React components
│   │   ├── hooks/          # Custom React hooks
│   │   ├── types/          # TypeScript types
│   │   └── utils/          # Utility functions
│   ├── package.json
│   └── vite.config.ts
├── nginx/                  # Nginx configurations
├── scripts/                # Shell scripts
├── systemd/                # Systemd service files
├── docker compose.yml      # Dev environment
└── README.md
```

## Development Commands

```bash
# Install dependencies
cd pwa && pnpm install

# Development server
pnpm dev

# Type check
pnpm tsc --noEmit

# Build for production
pnpm build

# Start Docker environment
docker compose up -d
```

## Architecture

```
PWA (React) → nginx (proxy + auth) → ttyd instances → tmux sessions
                                      ├── :7681 claude
                                      ├── :7682 copilot
                                      └── :7683 shell
```

## Code Conventions

- **File naming**: kebab-case for all files (e.g., `keyboard-toolbar.tsx`)
- **Components**: Function components with TypeScript
- **Hooks**: Prefix with `use-` (e.g., `use-session.ts`)
- **State**: React hooks (useState, useCallback, useMemo)
- **Styling**: TailwindCSS utility classes

## Key Files

| File                                      | Purpose                                   |
| ----------------------------------------- | ----------------------------------------- |
| `pwa/src/App.tsx`                         | Main app with gestures, toolbar, sessions |
| `pwa/src/components/keyboard-toolbar.tsx` | Virtual keyboard for mobile               |
| `pwa/src/hooks/use-gestures.ts`           | Hammer.js gesture handling                |
| `pwa/src/utils/terminal-bridge.ts`        | Iframe keystroke injection                |
| `docker compose.yml`                      | ttyd + nginx dev environment              |
| `nginx/nginx.conf`                        | Dev proxy with WebSocket support          |

## Security Notes

- Basic auth over HTTPS required for production
- Same-origin iframe setup via nginx proxy
- PostMessage uses explicit origin (not wildcard)
- Exclude sensitive dirs (.ssh, .gnupg) from volume mounts

## Testing

```bash
# Type check
cd pwa && pnpm tsc --noEmit

# Build verification
pnpm build
```

## Deployment

1. Build PWA: `cd pwa && pnpm build`
2. Install systemd services: `sudo cp systemd/*.service /etc/systemd/system/`
3. Configure nginx with SSL
4. Run `scripts/deploy.sh`
