# Getting Started with Termote

Control Claude Code, GitHub Copilot, or any terminal tool from your phone — in under 5 minutes.

## What is Termote?

Termote (Terminal + Remote) turns your browser into a mobile-friendly terminal. It wraps your existing CLI tools with touch gestures, a virtual keyboard, and session management — all through a PWA you can install on your homescreen.

Since 1.0.0 a single binary, `termote`, does everything: it serves the PWA and the API, handles
auth, and streams the terminal itself (a PTY on Unix, ConPTY on Windows) over the
`/api/mux/stream` WebSocket to xterm.js in the browser. Termote no longer uses `ttyd`. The CLI
lives in the same binary — the installer puts `termote` on your `PATH` directly, so there is no
separate shim to call.

**Use cases:**

- Control Claude Code from your phone while away from your desk
- Monitor long-running processes from mobile
- Pair program by sharing a terminal session
- Run CLI tools on a remote server with a touch-friendly UI

## Installation

> For detailed options (native flags, container mode, Windows, Tailscale), see the
> [Deployment Guide](deployment-guide.md).

Two commands, on Linux or macOS:

```bash
curl -fsSL https://termote.ohnice.app/install.sh | sh
termote start
```

On Windows (PowerShell):

```powershell
irm https://termote.ohnice.app/install.ps1 | iex
termote start
```

The installer only downloads the release for your OS/arch, verifies its checksum, and lays it
out — it never starts anything itself. `termote start` creates a password the first time and
prints it once, registers the server with your OS (systemd/launchd/Scheduled Task) so it
survives logins, and prints the URL once the server answers — open it in your browser. Print
the password again any time with:

```bash
termote show-password
```

Want a container instead of a native install? Run `termote container up` (needs podman or
docker) instead of `termote start`; see the [Deployment Guide](deployment-guide.md) for its
flags.

## Accessing from Your Phone

### Local Network (LAN)

To access Termote from other devices on your network:

```bash
termote start --lan
```

This binds to `0.0.0.0` instead of `127.0.0.1` (e.g., reachable at `http://192.168.1.100:7680`).
Open that URL on your phone.

The server only accepts requests whose `Host` header is on its allowlist: loopback always, and
with `--lan` the address the request actually arrived on (so it keeps working as your LAN IP
changes), plus the Tailscale name with `--tailscale`. If you reach it by another hostname (for
example the machine's name on your network), add it with `--allow-host <name>` (repeatable):

```bash
termote start --lan --allow-host mypc.local
```

### Install as PWA

For the best mobile experience, install Termote as a Progressive Web App:

1. Open Termote in your phone's browser
2. **iOS:** Tap Share → "Add to Home Screen"
3. **Android:** Tap the menu → "Install app" or "Add to Home Screen"

The PWA works offline and feels like a native app.

## Using Termote

### Sessions

Termote organises terminals in three levels: **group → tab → pane**. With tmux (the default),
a group is a tmux session (every session on the tmux server is listed, ones you started
yourself included) and each tab is a tmux window:

- **Create:** Tap the "+" button in the sidebar
- **Switch:** Tap a session name in the sidebar
- **Delete:** Swipe left on a session (or use the delete icon)

Each session is independent — run Claude Code in one, a build process in another.

You can use [Herdr](https://herdr.dev/#install) instead of tmux with `termote start --mux herdr`
(native) or `termote container up --mux herdr` (container). A tab can then hold several panes,
and each pane shows a badge with the status of the coding agent running in it. In the
container, Herdr runs inside it and sees only the container's terminals.

### Touch Gestures

| Gesture     | Action                             |
| ----------- | ---------------------------------- |
| Swipe left  | Send `Ctrl+C` (interrupt)          |
| Swipe right | Send `Tab` (autocomplete)          |
| Swipe up    | Scroll down (back to newer output) |
| Swipe down  | Scroll up (read earlier output)    |

### Virtual Keyboard

The toolbar at the bottom provides modifier keys:

- **Tab** — autocomplete
- **Ctrl** — tap once, then tap another key for Ctrl+key
- **Shift** — tap once to apply Shift to the next key (Shift+Tab = backtab)
- **Esc** — escape key (useful for vim)
- **↑ / ↓** — command history navigation

## Common Workflows

### Running Claude Code from Mobile

1. Open a session in Termote
2. Type `claude` to start Claude Code
3. Use touch gestures: swipe down/up to scroll the output, swipe right for tab completion
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
- If you get a 403 because the Host was rejected, run the `termote start --allow-host <name>`
  the error message suggests

### Forgot the Password

- Run `termote show-password` to print the saved username and password

### Give Another Device Access

Run `termote pair` for a one-time code (5 minutes) and open `/pair` on the new device; the device
gets its own sign-in, view only unless `--role full`. List or sign out devices with
`termote devices` and `termote devices revoke <id>`, or in Settings > Devices. Needs sign-in
(not `--no-auth`). The model and limits: [`system-architecture.md`](system-architecture.md).

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

### Works on Wi-Fi, Stalls on Mobile Data (Tailscale)

- The header stays at "Loading...", or the terminal stays blank, and a toast says the network seems
  to drop large replies
- The carrier's IPv6 path drops Tailscale's full-size packets: lower Tailscale's MTU on the server
  (`TS_DEBUG_MTU=1200` in `/etc/default/tailscaled`, then restart `tailscaled`)
- See [Stalls on mobile data](https://termote.ohnice.app/installation/tailscale/#stalls-on-mobile-data)
  for the check and its side effects

## Coming from a 0.x install

There is no in-place upgrade from 0.x to 1.0: the install layout, config format and CLI all
changed, and 1.0 reads nothing 0.x left behind. Remove 0.x completely first; its `uninstall`
only stops it, so also remove the command and the install directory (`~/.termote` unless
`TERMOTE_INSTALL_DIR` was set):

```bash
# Linux, macOS
~/.termote/scripts/termote.sh uninstall all   # stops native + container, resets Tailscale serve
~/.termote/scripts/termote.sh unlink          # removes the 'termote' symlink
rm -rf ~/.termote
hash -r                                       # zsh: rehash
```

```powershell
# Windows (PowerShell)
& "$HOME\.termote\scripts\termote.ps1" uninstall all
& "$HOME\.termote\scripts\termote.ps1" unlink
Remove-Item -Recurse -Force "$HOME\.termote"
```

`uninstall all` runs `tailscale serve reset`, which removes every `tailscale serve` mapping on
the machine, not only Termote's. A container install also leaves the image it built
(`docker images | grep termote`). See the archived 0.x
[native](https://termote.ohnice.app/0.x/installation/native/#uninstall) and
[container](https://termote.ohnice.app/0.x/installation/docker/#uninstall) pages. Then install
1.0 fresh with the two commands above.
