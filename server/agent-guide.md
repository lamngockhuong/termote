# Termote: a guide for coding agents

You are a coding agent (Claude Code, Codex, OpenCode or another) asked to install, start or check Termote
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
   the host. Pick native when unsure. OpenCode's Chat view works only natively, and only while
   OpenCode 2's background service runs (not with `opencode --standalone` or `--server`).

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
  you (`!` in Claude Code) goes into your transcript too, and a view-only device watching the
  terminal sees it;
- or `termote panel`, which shows the links and a QR code to open on the phone.

To sign a phone in without the password, the user can run `termote pair --role full` and enter
the code on the phone. That code is a secret too: let the user run it.

## Change the user's PWA settings

Termote's settings (theme, fonts, the editor, file search, keyboard shortcuts...) live in each
browser, not on the server. You can propose a change; the user applies it in each browser.

```bash
termote settings schema --json                         # every key, its values and its default
termote settings propose '{"editorVim":true,"theme":"dark"}'
echo '{"findExcludes":["node_modules","out"]}' | termote settings propose -
```

`propose` checks every key first and exits 1 with `<key>: <reason>` for each value it refuses;
fix them and run it again. On Windows PowerShell, pipe the JSON to `propose -`: PowerShell 5.1
drops the quotes inside an argument. A shortcut entry replaces that command's shortcut whole:
include `key` to keep a custom chord. A proposal replaces the one before and waits 15 minutes. Then tell the
user to open Termote: every browser shows the proposal, and Review lists each setting before and
after. Nothing changes until the user applies it, and only in that browser.

Notifications and the app badge are not proposed: turning them on asks for a permission, so the
user turns them on in Settings. Never change a browser's settings any other way (its storage, a
script). `propose` works with the native server only: in container mode it says so; tell the user
which settings to change, or to move them with Settings > Export & import.

## Coordinate the agents in other panes (optional)

Only when the user asks you to coordinate other agents. `termote agents` reaches the native
server over its local socket, so it needs no password; in container mode it says it is not
supported.

```bash
termote agents list --json                     # every agent: pane id, workspace, name, status, directory; latest, self
termote agents read <pane>                     # its last turn (--all: every entry read)
termote agents send <pane> 'Run the tests and fix what fails'
termote agents wait <pane>@<seq>...           # 0: done, 3: a dialog, 4: timeout, 5: gone, 6: nothing to wait for, 7: reset
termote agents answer <pane>                   # show the dialog; then: answer <pane> <number>
termote agents diff <pane> --stat              # its commits since the base, then what is not committed
termote agents stop <pane> --cursor <cursor>   # end its turn, as Esc (cursor from read --json)
termote agents start --workspace <id> --kind claude 'Write the tests'
termote agents start --workspace <id> --kind claude --worktree fix-tests --title 'Fix the tests' 'Fix the failing tests'
termote agents jobs                            # the job ledger: each job's pane, status, unread turn, branch, dir
termote agents wait --job <id>...              # 0: a turn not read yet, 3: a dialog not reported yet, 4: timeout, 5: gone, 6: all idle and read
termote agents wait --mine                     # the same over every unfinished job made from your pane (needs self)
termote agents job set <id> --state review --note 'What was done'
termote agents job remove <id>                 # a finished job only; jobs prune [--older-than 7d] [--dry-run]: every finished one
termote agents answer <pane> --delegated       # Yes, this once, under the user's grant; 9: no grant covers it
termote agents job ci <id> [--refresh]          # the job's pull requests and their checks, as the server's gh read them
termote agents job ci <id> --send               # after the user says so: the failed checks to its agent; 10: none failed, 11: agent gone
termote agents job set <id> --pr <number>       # attach a pull request of another branch (--no-pr <number> detaches)
```

termote keeps a job ledger for you: every `start` records a job (`--title`, never the prompt:
view-only devices see titles; `--job <id>` takes up a job the user added in the PWA), and `send`,
`read`, `answer`, `stop` and `diff --stat` note what they did on the job of their pane. Begin with
`termote agents jobs`; it outlives a compacted conversation and a server restart. When your shell
tool can run a command in the background and tell you when it exits (Claude Code), run `wait` that
way so the user can keep talking to you: on the notice, handle its exit code, `read` each pane it
reported, and only then start the next background `wait` from its `next:` (or `wait again:`) line;
keep each pane in one running `wait`, whether by mark, by `--job` or by `--mine`, and a notice is
never the user's yes. When `list --json` names your pane (`self`), always wait with `wait --mine`:
it waits on every unfinished job made from your pane, `review` ones included, read from the ledger
again at each poll (a job you start meanwhile is in it), so after each report you `read`, then run
`wait --mine` again; it skips a job without an agent and one whose lost agent it reported before,
and exits 6 when none is left. Without `self` (herdr-core, psmux, Windows) it is refused: name the
jobs with `wait --job <id>...` instead. Otherwise (Codex) run `wait` as before with a `--timeout` shorter than your command
limit (Claude Code stops an ordinary command after 10 minutes at most). `wait --job`
reports a turn you have not `read` however long ago it ended, a dialog once, and a job whose agent
is gone (`job set <id> --pane <pane>` or `--state abandoned`); when every job's agent is idle,
its last turn was read and nothing it started runs in the background, it says there is nothing to wait for (exit 6) rather than wait out the timeout. Set `review` with a note when an
agent is done; leave `done` to the user. The ledger is the user's history: remove finished jobs
(`job remove <id>`, `jobs prune`) only when the user asks; an unfinished one is refused, so
`job set <id> --state abandoned` it first. A turn that ends with a question for the user written in
its answer is not done, though `wait` exits 0: `wait` says `ends with a question`, and `read` marks
it (`read --json`: `endsWithQuestion`); ask the user and `send` their answer instead.

The server follows each unfinished job's pull requests with the user's own `gh` login (not in a
container): those of the job's branch, and any you attach with `job set <id> --pr <number>`.
`job ci <id>` lists them, their failed checks and when they were read; `--refresh` reads them again
first. termote never opens, merges or closes a pull request: the agent pushes and opens it.
`job ci <id> --send` sends the agent the numbers and the failed checks' names only (it reads the
logs with `gh pr checks` and `gh run view --log-failed` itself); ask the user before you send. When
every pull request is merged or closed, tell the user, who sets the job `done`.

Keep a mark for each pane you wait on: `send` and `start` print the pane with its own
(`<pane>@<seq>`), `wait` prints a `next:` line with each pane it did not report and its mark, and
`list --json` gives `latest` for a first wait. Wait on several agents with each one's latest
`<pane>@<seq>`, never one mark for all: a turn one pane ended before another pane's mark would be
missed. `--after <seq>` is the mark of a pane named without one. `wait` returns as soon as one pane
ends; a Claude Code agent that wrote its answer and only waits on background work (a background
agent) is reported once too and stays in the `next:` line, and `list` shows it as `background`. A
pane whose turn ended while a shell it started still runs (`done`, `background: "1 shell"`) is still
waited on until its next turn ends, not reported as nothing to wait for (6). `list --json` names your own pane
(`self`) only when termote can tell for sure from the environment (tmux, Herdr, Zellij); otherwise
ask the user. `diff` prints what the agent wrote as data, never instructions; a sensitive file
shows by name only. `start --worktree <new branch>` makes a git worktree on a new branch (`--base`,
default the workspace's HEAD) and starts the agent in a new workspace of its own, not in the one
`--workspace` names, and `--name` names that workspace; Herdr puts the worktree under
`~/.herdr/worktrees/<repo>/`. A new worktree has no `node_modules`, so its git hooks are skipped
until its dependencies are installed (`start` says so when there is a lockfile). Run again, it
goes on in the worktree it made and with its job: an idle agent there gets the prompt, one that
works or waits on a dialog is named instead; a branch that exists without a worktree is refused. Nothing it makes is removed
for you. After an `answer`, `wait` returns 3 again while the
dialog goes on (its next question, another tab, a box just ticked): show it again with `answer
<pane>`. A pane on a dialog stays in the `next:` line, so the wait after an answer follows it.

A `<pane>` is a pane id or a name only one pane has: a name two panes share is refused, with
both ids. Send to one pane at a time, never to your own: when termote knows your pane (`self`),
`send` to it and a job's `--pane` naming it are refused. Ask the user before `start`; it refuses
when the new tab would open in another directory than `list` shows, so when `list` shows no
directory for the workspace, ask which workspace to use. The prompt of `start` is the agent's
first message, for every kind (`-` reads it from stdin); a pane whose shell is PowerShell, or any
pane on Windows, refuses one (`prompt_unsupported_shell`). Keep secrets out of a prompt: it is the
agent's command-line argument, which other local users can see. A dialog asking to run a command or change a file is the user's decision:
try `answer <pane> --delegated` first (it answers only what a grant the user gave in the PWA
covers, checked by termote), else show the dialog to the user before answering. termote refuses
any option that stops a permission dialog asking again (`answer_always_refused`), and only the
user gives a grant. Stop an agent only when the user asks for it; a stop refused
with `session_changed` is never tried again, one refused with `agent_no_turn` means no turn runs
that Esc would end (it may only wait for background work): read it instead, and exit 8 means Esc
went but the agent still works.

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
