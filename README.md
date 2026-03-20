# Termote

Remote control CLI tools (Claude Code, GitHub Copilot, any terminal) from mobile/desktop via PWA.

> **Termote** = Terminal + Remote

## Features

- **Session switching**: Claude, Copilot, Shell terminals
- **Mobile-friendly**: Virtual keyboard toolbar (Tab/Ctrl/Esc/arrows)
- **Gesture support**: Swipe for Ctrl+C, Tab, history navigation
- **PWA**: Installable to homescreen, offline-capable
- **Persistent sessions**: tmux keeps sessions alive

## Deployment

### Docker

```bash
./scripts/deploy.sh --docker
# Access: http://localhost:8080 (basic auth)
```

### Native (local)

```bash
sudo apt install ttyd tmux nginx socat
./scripts/deploy.sh --native
# Access: http://localhost:8080 (basic auth)
```

### Native + Tailscale (recommended for remote)

```bash
sudo apt install ttyd tmux nginx socat
./scripts/deploy.sh --native --tailscale myhost.ts.net
# Access: https://myhost.ts.net:8080

# Custom port
./scripts/deploy.sh --native --tailscale myhost.ts.net:9000
# Access: https://myhost.ts.net:9000
```

### Hybrid

```bash
./scripts/deploy.sh --hybrid
# Customize: --nginx=docker --ttyd=native --api=native
```

### Uninstall

```bash
./scripts/uninstall.sh --docker   # Docker only
./scripts/uninstall.sh --native   # Native only
./scripts/uninstall.sh --all      # Everything
```

## Mobile Usage

| Action           | Gesture             |
| ---------------- | ------------------- |
| Cancel/interrupt | Swipe left (Ctrl+C) |
| Tab completion   | Swipe right         |
| History up       | Swipe up            |
| History down     | Swipe down          |
| Paste            | Long press          |
| Font size        | Pinch in/out        |

Virtual toolbar provides: Tab, Esc, Ctrl, Arrow keys, and common Ctrl combos.

## Project Structure

```
termote/
├── docker compose.yml      # Dev environment
├── nginx/
│   ├── nginx.conf          # Dev config
│   └── nginx-production.conf
├── pwa/                    # React PWA
│   ├── src/
│   │   ├── components/
│   │   ├── hooks/
│   │   └── utils/
│   └── package.json
├── scripts/
│   ├── deploy.sh           # Deploy (--docker|--native)
│   ├── uninstall.sh        # Uninstall
│   ├── health-check.sh     # Service health check
│   └── tmux-api.sh         # tmux REST API server
└── systemd/
    ├── termote.service     # ttyd WebSocket
    └── tmux-api.service    # tmux API
```

## Troubleshooting

### Session not persisting

- Check tmux: `tmux ls`
- Verify ttyd uses `-A` flag (attach-or-create)

### WebSocket errors

- Check nginx `proxy_read_timeout`
- Verify WebSocket upgrade headers

### Mobile keyboard issues

- Ensure viewport meta tag is present
- Test on real device, not emulator

## Security Notes

- Basic auth over HTTPS (or Tailscale)
- Consider fail2ban for brute-force protection
- Restrict to trusted networks/VPN

## License

MIT
