# Upgrading to 1.0.0

Termote 1.0.0 is a breaking release: ttyd is removed everywhere (container and
every native OS), tmux-api streams the terminal itself into xterm.js over
WebSocket, and the CLI moved from `scripts/termote.sh`/`scripts/termote.ps1`
into Go subcommands of the `tmux-api` binary. This page lists what changes for
an existing 0.x install and how to move to 1.0.0. For everyday command usage
see the root [`README.md`](../README.md); for the request-guard design see
[`system-architecture.md`](system-architecture.md).

## How to update

```bash
termote update                    # latest release
termote update --version 1.0.0    # pin a version
```

```powershell
.\scripts\termote.ps1 update
.\scripts\termote.ps1 update -Version 1.0.0
```

`update` preserves the saved mode, LAN, auth, port and Tailscale settings (see
"Config migration" below for what changes in the saved file itself).
`scripts/termote.sh` and `scripts/termote.ps1` still exist and are still the
entry point a 0.x install calls during its own `update`; in 1.0.0 they are
thin shims that dispatch to the `tmux-api` binary.

## Breaking changes

- **Terminal transport**: ttyd and its WebSocket proxy are gone. tmux-api opens
  the terminal itself (PTY on Unix, ConPTY on Windows) and streams it over
  `/api/mux/stream`; the PWA renders it with xterm.js instead of an iframe.
  The old `/terminal/` route now answers `410 Gone`.
- **API path**: `/api/tmux/*` is renamed to `/api/mux/*`, with a different
  shape (three levels: group → tab → pane, plus `caps`/`backend` fields for
  the Herdr badge and client-side tab select). There is no alias; a cached 0.x
  PWA bundle gets a JSON error instead of a broken UI.
- **`-Ttyd`/`--ttyd` is ignored**: still accepted (0.x's own `update` passes it
  when relaunching the new installer) but has no effect beyond a warning.
- **Empty saved password no longer disables auth**: a 0.x config that ended up
  with an empty password ran without authentication. `install` on such a
  config now generates a new password, saves it encrypted, and prints it once;
  recover it later with `termote show-password` / `termote.ps1 show-password`.
- **Host allowlist**: the server now rejects requests whose `Host` header is
  not on an allowlist (loopback, the LAN IP when `--lan` is set, the Tailscale
  name when `--tailscale` is set, plus any name added with
  `--allow-host`/`-AllowHost`, repeatable). There is no wildcard to disable the
  check; a rejected request's error message names the exact
  `--allow-host <name>` to run.
- **CLI implementation**: `install`, `uninstall`, `update`, `health`, `logs`,
  `link`, `unlink`, `version`, and the interactive menu are now Go code in
  `tmux-api/cli*.go`, compiled into the `tmux-api` binary. The menu no longer
  uses `gum` (plain numbered prompts). Config file path and format (Unix
  `~/.termote/config`, Windows `~/.termote/config.json`, same encryption) are
  unchanged.

## New in 1.0.0

- **Herdr backend**: `--mux herdr`/`-Mux herdr` (native mode only) drives
  [Herdr](https://termote.ohnice.app/installation/native/) workspaces instead
  of tmux; the PWA shows per-pane agent-status badges. Selecting a tab on the
  PWA does not change what is shown on the desktop. `--mux herdr --no-auth`
  is refused unless `--allow-herdr-no-auth` is also given, because Herdr
  exposes every workspace on the host.
- **`show-password`**: prints the saved admin password again, for the case
  above and for any install where the password was auto-generated.
- **`--allow-host`/`-AllowHost`**: add a Host header name to the allowlist
  (see above); repeatable, persisted in the saved config.

## Config migration

`install` on a 0.x config is idempotent and runs automatically the first time
1.0.0 starts:

- A config with no `Mux`/`TERMOTE_MUX` key defaults to `tmux`.
- A ttyd process that Termote itself started (matched by its exact command
  line, never a user-run ttyd) is stopped; on Windows, `scripts/ttyd.exe` and
  `scripts/ttyd.source` are removed.
- An empty saved password is replaced as described above.

Verified by re-running the real 0.1.0 → 1.0.0 update on Linux native, Linux
container and Windows native (psmux), keeping mode/LAN/auth/port/Tailscale —
see `plans/reports/tester-260926-0143-GH-1-upgrade-010-to-100.md` for the
session record (macOS was not available to test; Go's cross-platform tests
run on `macos-latest` in CI).

## Release procedure note (maintainers)

1.0.0 is released by merging the long-lived `feat/1.0` branch into `main`
once, with `release-as: 1.0.0` set for the package in
`release-please-config.json` (`bump-minor-pre-major: true` would otherwise
turn the `feat!:` merge commit into `0.2.0`). Remove `release-as` again right
after the release goes out, or every later release stays pinned to 1.0.0. See
[`release-guide.md`](release-guide.md) for the full release workflow.
