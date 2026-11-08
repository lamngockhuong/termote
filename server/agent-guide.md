# Termote: a guide for coding agents

You are a coding agent (Claude Code, Codex or another) asked to install, start or check Termote
for the person you work with. Follow this guide; every command in it runs as written.

Once Termote is installed, `termote help agent` prints this guide for the installed version.
The copy at https://termote.ohnice.app/agents.md follows the latest stable release; `termote version`
shows which version is installed here.

## What Termote is

Termote serves a web app that controls terminal sessions (tmux, Herdr, Zellij or herdr-core) of
this machine from a phone or another computer. One server per OS user, on port 7680 (Windows:
7690). It needs no root and no admin rights.

## Before you start

Ask the user, unless they already said:

1. Where will they open it from?
   - only this machine: no option;
   - a phone or computer on the same Wi-Fi or LAN: `--lan`;
   - anywhere, over Tailscale: `--tailscale <host>` (the machine's MagicDNS name, such as
     `myhost.tailnet-name.ts.net`);
   - anywhere, over a Cloudflare Tunnel the user already runs: `--cloudflare <host>`.
2. Native or container? Native (`termote start`) runs on the host and sees its tools (claude,
   git, node). A container (`termote container up`, podman or docker) keeps sessions apart from
   the host. Pick native when unsure.

Check what is already there:

```bash
termote version
termote status --json
```

If `termote` is not found, install it. If `status --json` reports `"running": true`, Termote is
already set up: do not install it again; change options with `termote start <options>`.

## Install

Linux and macOS:

```bash
curl -fsSL https://termote.ohnice.app/install.sh | sh
```

Homebrew (macOS, Linux):

```bash
brew install lamngockhuong/tap/termote
```

Windows (PowerShell):

```powershell
irm https://termote.ohnice.app/install.ps1 | iex
```

The installer verifies the download, installs the `termote` command and starts nothing. When
its directory is not on `PATH`, it prints the full path of the command: use that path in place
of `termote` below. Never run the installer or Termote with `sudo`.

Native mode needs a terminal backend: tmux on Linux and macOS, psmux on Windows
(`winget install psmux`), or Herdr. If none is installed, tell the user which package to install
and let them run the package manager when it needs `sudo`.

## Choose and start

| The user wants                     | Command                             |
| ---------------------------------- | ----------------------------------- |
| Only this machine                  | `termote start`                     |
| Phone on the same Wi-Fi            | `termote start --lan`               |
| Anywhere over Tailscale            | `termote start --tailscale <host>`  |
| Behind their Cloudflare Tunnel     | `termote start --cloudflare <host>` |
| Isolated in a container            | `termote container up`              |
| Container, phone on the same Wi-Fi | `termote container up --lan`        |
| Herdr workspaces instead of tmux   | `termote start --mux herdr`         |
| Zellij sessions (Linux, macOS)     | `termote start --mux zellij`        |
| Another port                       | `termote start --port <port>`       |

`start` saves its options, registers a service (systemd user unit, launchd agent or Scheduled
Task) and starts it. A flag not given keeps its saved value, and a boolean is turned off with
`=false` (`termote start --lan=false`). After that, `termote restart` starts it again with the
same options. `start` asks nothing, so it is safe to run without a terminal.

Tailscale needs Tailscale installed and signed in, with HTTPS certificates on for the tailnet.
On Linux the user must once allow their account to change `tailscale serve`; `termote start`
prints the exact command when that is missing. Let the user run it, it needs `sudo`.

Cloudflare: Termote never starts `cloudflared`. The user runs the tunnel, pointed at
`http://127.0.0.1:<port>`, with Cloudflare Access in front of it.

## Verify

```bash
termote status --json
```

It exits 0 when the server answers. Read:

- `running`: `true` when the server answers;
- `status`: `"ok"` when healthy;
- `lan`, `auth`, `backend`, `port`, `version`;
- `urls.local`, `urls.lan` (a list), `urls.tailscale`, `urls.cloudflare`;
- `cloudflareAccess`: `"on"` is what you want; `"off"` means anyone on the Internet reaches the
  sign-in page, so tell the user.

For a container, use `termote container status`.

`termote url` prints the one link another device most likely reaches.

## Hand over to the user

Give the user the link. Do not run `termote show-password` and do not repeat a password: your
output goes into a transcript. When `start` runs outside a terminal it prints the username and
no password.

Tell the user to see the password themselves:

- `termote show-password` in a terminal of their own, not through you: a command they run through
  you (`!` in Claude Code) goes into your transcript too, which a view-only device reads in
  Termote's Chat view;
- or `termote panel`, which shows the links and a QR code to open on the phone.

To sign a phone in without the password, the user can run `termote pair --role full` and enter
the code on the phone. That code is a secret too: let the user run it.

## Never

- `--no-auth` together with `--lan`, `--tailscale` or `--cloudflare`. Without a password,
  everyone who reaches the port gets a shell.
- `--allow-herdr-no-auth` or `--allow-hc-no-auth` without the user asking for it.
- `sudo` for the installer or for any `termote` command.
- Editing Termote's config files or service files by hand. Use `termote start <options>`.
- Pasting a password or a pair code into a commit, a log, an issue or a chat.
- Raising the port number because the port is busy. Find out what holds it first.

## Troubleshooting

- **The port is busy.** Run `termote status`. If it reports another listener, ask the user what
  runs there; pick another port only with their agreement (`termote start --port <port>`).
- **The phone cannot reach the LAN address.** The server needs `--lan` (check `lan` in
  `status --json`). A firewall on this machine may block the port: tell the user which port and
  let them change the rule. Under WSL 2, the LAN reaches Windows, not the VM: in WSL's NAT
  networking mode the port has to be forwarded from Windows, in mirrored mode the Windows
  firewall decides. Explain this; do not change Windows settings yourself.
- **It does not start.** Read `termote logs server`; `start` also prints the last log lines when
  the server does not come up.
- **No systemd (WSL 2 without it, some containers).** `start` runs the server as a detached
  process instead. It does not come back after a reboot; run `termote start` again.
- **"the saved password was not accepted".** The server runs with another password than the
  saved one. `termote restart` restarts it with the saved config.

## Update and remove

```bash
termote update
termote uninstall
```

Homebrew installs update with `brew upgrade termote && termote restart`. `uninstall` keeps the
config and the logs; `termote uninstall --purge` removes them too. Ask before removing anything.
