# Termote plugin for Herdr

Opens the Herdr pane you are on in [Termote](https://termote.ohnice.app), shows its link as a QR
code to scan with a phone, copies it, and starts, stops or restarts the server.

```bash
termote link                                             # put termote on PATH, once
herdr plugin install lamngockhuong/termote/herdr-plugin
herdr plugin action invoke lamngockhuong.termote.panel   # the popup
```

Needs Herdr 0.7.4+ and a server on the Herdr backend (`termote start --mux herdr`); with tmux the
link opens Termote's home screen. Every command in `herdr-plugin.toml` runs `termote`, so the
plugin has no runtime of its own and its version follows Termote's.

| Entry                               | Runs                                                 |
| ----------------------------------- | ---------------------------------------------------- |
| pane `panel` (popup)                | `termote panel`: status, links, QR, keys o c s x r q |
| action `panel`                      | opens the popup (key bindings can only run actions)  |
| action `open` / `copy`              | `termote url --herdr --open` / `--copy`              |
| action `start` / `stop` / `restart` | `termote start` / `stop` / `restart`                 |

Action output only reaches `herdr plugin log list --plugin lamngockhuong.termote`. Full guide:
[Herdr Plugin](https://termote.ohnice.app/usage/herdr-plugin/).

Develop from a checkout: `herdr plugin link ./herdr-plugin` (it runs whatever `termote` is on
`PATH`), then `herdr plugin unlink lamngockhuong.termote`.
