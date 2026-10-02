# Termote plugin for Herdr

Opens the Herdr pane you are on in [Termote](https://termote.ohnice.app), shows its link as a QR
code to scan with a phone, copies it, and starts, stops or restarts the server.

```bash
herdr plugin install lamngockhuong/termote/herdr-plugin
herdr plugin action invoke lamngockhuong.termote.panel   # the popup
```

Needs Herdr 0.7.4+, Termote 1.5.0+ (it has `url` and `panel`) and a server on
the Herdr backend (`termote start --mux herdr`); with tmux the link opens Termote's home screen.
Every command runs `termote`, so the plugin has no runtime of its own and its version follows
Termote's.

On Linux and macOS each entry runs `bin/termote.sh`: Herdr's `PATH` often lacks `~/.local/bin`,
so it also looks there and in `~/.local/share/termote/current/bin`, runs the first copy new
enough for the plugin, and when none is, or the command fails, keeps the popup open on the
message. Herdr allows each id once, so
Windows (where the installer puts `termote` on the user `PATH`) has the same entries with a
`-windows` suffix that run `termote` directly.

| Entry                               | Runs                                                 |
| ----------------------------------- | ---------------------------------------------------- |
| pane `panel` (popup)                | `termote panel`: status, links, QR, keys o c s x r q |
| action `panel`                      | opens the popup (key bindings can only run actions)  |
| action `open` / `copy`              | `termote url --herdr --open` / `--copy`              |
| action `start` / `stop` / `restart` | `termote start` / `stop` / `restart`                 |

Action output only reaches `herdr plugin log list --plugin lamngockhuong.termote`. Full guide:
[Herdr Plugin](https://termote.ohnice.app/usage/herdr-plugin/).

Develop from a checkout: `herdr plugin link "$PWD/herdr-plugin"` (it runs the `termote` the
launcher finds), then `herdr plugin unlink lamngockhuong.termote`. Launcher tests:
`make test-herdr-plugin`.
