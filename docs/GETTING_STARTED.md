# Getting Started with Termote

Control Claude Code, GitHub Copilot, or any terminal tool from your phone — in under 5 minutes.

## What is Termote?

Termote (Terminal + Remote) turns your browser into a mobile-friendly terminal. It wraps your existing CLI tools with touch gestures, a virtual keyboard, and session management — all through a PWA you can install on your homescreen.

**Use cases:**
- Control Claude Code from your phone while away from your desk
- Monitor long-running processes from mobile
- Pair program by sharing a terminal session
- Run CLI tools on a remote server with a touch-friendly UI

## Quick Start

### Option 1: Container Mode (Recommended)

Container mode bundles everything — no manual dependency management.

```bash
# Download and run the installer
curl -fsSL https://raw.githubusercontent.com/lamngockhuong/termote/main/scripts/termote.sh -o termote.sh
chmod +x termote.sh

# Interactive setup (asks you questions)
./termote.sh

# Or one-liner for local use
./termote.sh install container
```

This starts Termote on `http://localhost:7680`. Open it in your browser.

### Option 2: Native Mode

If you prefer running without containers:

**Prerequisites:**
- [Go 1.21+](https://golang.org/dl/)
- [tmux](https://github.com/tmux/tmux) (Linux/macOS)
- [ttyd](https://github.com/tsl0922/ttyd)

```bash
./termote.sh install native
```

### Create a Global Command

After installation, create the `termote` command for convenience:

```bash
./termote.sh link
```

Now you can run `termote health`, `termote install native --lan`, etc. from anywhere.

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

| Gesture | Action |
|---------|--------|
| Swipe left | Send `Ctrl+C` (interrupt) |
| Swipe right | Send `Tab` (autocomplete) |
| Swipe up | Previous command (↑) |
| Swipe down | Next command (↓) |

### Virtual Keyboard

The toolbar at the bottom provides modifier keys:

- **Tab** — autocomplete
- **Ctrl** — hold for Ctrl+key combinations
- **Shift** — toggle for uppercase
- **↑↓←→** — arrow keys for navigation
- Tap the expand icon for more keys

### Common Workflows

**Start Claude Code from your phone:**
```bash
# In a Termote session
claude
```
Then interact with Claude Code using the virtual keyboard and gestures.

**Monitor a build:**
```bash
# Start your build in one session
npm run build

# Switch to another session for other work
```

## Authentication

By default, Termote uses basic auth to protect your terminal:

```bash
# Set during installation, or configure manually
./termote.sh install container  # Prompts for username/password
```

For local-only use without auth:
```bash
./termote.sh install container --no-auth
```

⚠️ **Never expose Termote to the internet without authentication.**

## Troubleshooting

### "Connection refused" on mobile
- Make sure you used `--lan` flag during installation
- Check that your phone is on the same WiFi network
- Verify the IP address: `hostname -I` (Linux) or `ifconfig` (macOS)

### Terminal not responding
- Try refreshing the page
- Check if tmux is running: `tmux ls`
- Restart Termote: `termote install container` (re-runs the container)

### Gestures not working
- Make sure you're swiping on the terminal area, not the sidebar
- Gestures can be customized — check Settings in the UI

### PWA not installing
- You need HTTPS for PWA on most browsers (except localhost)
- For LAN access, some browsers allow HTTP PWA installation

## Next Steps

- Read the [Deployment Guide](deployment-guide.md) for production setups
- Check the [System Architecture](system-architecture.md) to understand how it works
- Join the conversation on [GitHub Issues](https://github.com/lamngockhuong/termote/issues)
