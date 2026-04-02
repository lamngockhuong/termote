# Getting Started with Termote

Control Claude Code, GitHub Copilot, or any terminal tool from your phone — in under 5 minutes.

## What is Termote?

Termote (Terminal + Remote) turns your browser into a mobile-friendly terminal. It wraps your existing CLI tools with touch gestures, a virtual keyboard, and session management — all through a PWA you can install on your homescreen.

**Use cases:**

- Control Claude Code from your phone while away from your desk
- Monitor long-running processes from mobile
- Pair program by sharing a terminal session
- Run CLI tools on a remote server with a touch-friendly UI

## Installation

> For detailed installation options (Container Mode, Native Mode, Windows), see the [Deployment Guide](deployment-guide.md).

Quick start with Container Mode:

```bash
curl -fsSL https://raw.githubusercontent.com/lamngockhuong/termote/main/scripts/termote.sh -o termote.sh
chmod +x termote.sh
./termote.sh install container
```

This starts Termote on `http://localhost:7680`. Open it in your browser.

## Accessing from Your Phone

### Local Network (LAN)

To access Termote from other devices on your network:

```bash
./termote.sh install container --lan
```

This binds to your local IP (e.g., `http://192.168.1.100:7680`). Open that URL on your phone.

### Install as PWA

For the best mobile experience, install Termote as a Progressive Web App:

1. Open Termote in your phone's browser
2. **iOS:** Tap Share → "Add to Home Screen"
3. **Android:** Tap the menu → "Install app" or "Add to Home Screen"

The PWA works offline and feels like a native app.

## Using Termote

### Sessions

Termote manages **tmux sessions** (called "windows" in the UI):

- **Create:** Tap the "+" button in the sidebar
- **Switch:** Tap a session name in the sidebar
- **Delete:** Swipe left on a session (or use the delete icon)

Each session is independent — run Claude Code in one, a build process in another.

### Touch Gestures

| Gesture     | Action                    |
| ----------- | ------------------------- |
| Swipe left  | Send `Ctrl+C` (interrupt) |
| Swipe right | Send `Tab` (autocomplete) |
| Swipe up    | Previous command (↑)      |
| Swipe down  | Next command (↓)          |

### Virtual Keyboard

The toolbar at the bottom provides modifier keys:

- **Tab** — autocomplete
- **Ctrl** — hold for Ctrl+key combinations
- **Shift** — toggle for uppercase
- **Esc** — escape key (useful for vim)
- **↑ / ↓** — command history navigation

## Common Workflows

### Running Claude Code from Mobile

1. Open a session in Termote
2. Type `claude` to start Claude Code
3. Use touch gestures: swipe up/down for history, swipe right for tab completion
4. Use the virtual keyboard for special keys (Ctrl+C to interrupt)

### Monitoring Long-Running Processes

1. Start your process in a session (e.g., `npm run build`)
2. Switch to another session while it runs
3. Come back to check output — sessions persist

### Multi-Session Workflow

1. **Session 1:** Run your dev server (`npm run dev`)
2. **Session 2:** Run Claude Code for AI-assisted coding
3. **Session 3:** Monitor logs (`tail -f logs/app.log`)
4. Switch between sessions using the sidebar

## Troubleshooting

### Can't Access from Phone

- Ensure you started with `--lan` flag
- Check that both devices are on the same network
- Verify the URL matches your server's local IP (`ip addr` or `ifconfig`)
- Check firewall allows port 7680

### Terminal Not Rendering Properly

- Use a modern browser (Chrome, Safari, Firefox)
- Try landscape mode for better terminal width
- If text is too small, pinch to zoom then reload

### Session Lost After Restart

- Sessions persist across page reloads but not server restarts
- To auto-start sessions, add startup commands to your shell profile
- Use `termote health` to check service status

### Connection Drops

- Check your WiFi signal strength
- If using over internet (not LAN), consider a reverse proxy with HTTPS
- The PWA will automatically reconnect when connection is restored
