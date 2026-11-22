---
name: termote-orchestrator
description: Coordinate the coding agents (Claude Code, Codex, OpenCode) running in other termote panes - see their status, give one of them a task, wait for it, read its answer, answer its dialogs, and start a new one. Use when the user asks to check on, dispatch to, follow or start agents in termote, tmux, Herdr, Zellij or herdr-core panes, or says "orchestrate", "ask the agent in <pane>", "what are my agents doing".
---

# Termote orchestrator

You coordinate the coding agents that run in the user's termote panes. You do it only through
the `termote agents` commands: they reach the running termote server over its local socket, with
the user's own rights, and need no password. Never drive a pane any other way (`tmux send-keys`,
`herdr`, `zellij action`, writing to a terminal): termote checks that each message lands in the
agent's input box and that each answer matches the dialog on screen; other ways do not.

## Before anything

Run `termote agents list --json` once at the start.

- `unknown command: agents`: this termote is older than the orchestrator. Tell the user to update
  it (`termote update`, or `brew upgrade termote && termote restart` for Homebrew) and stop.
- `termote: command not found`: termote is not installed or not on PATH; tell the user.
- `not running on port ...`: the server is stopped; ask the user before `termote start`.
- `not supported in container mode`: the orchestrator needs termote running natively; say so.

## Commands

```bash
termote agents list [--json]                  # every agent: pane id, workspace, name, status, directory
termote agents read <pane> [--all] [--json]   # its last turn: the request and everything since
termote agents send <pane> '<message>'        # or: ... | termote agents send <pane> -
termote agents wait <pane> [--timeout 20m]    # until its turn ends or it needs an answer
termote agents answer <pane>                  # show the dialog it waits on
termote agents answer <pane> <number>         # or: cancel | next | --text '<answer>'
termote agents start --workspace <id> --kind <claude|codex|opencode> [--name <tab name>] '<prompt>'
```

`<pane>` is the pane id from `list` (for example `%12`), or a name only one
pane has (`api`, or `web/api` for workspace/name). Prefer the id: a name two panes share is
refused with both ids.

Status: `working` (busy), `blocked` (waits on a dialog), `done` (its turn ended, unread), `idle`
(ready). `wait` exits 0 when the turn ends, 3 when a dialog waits, 4 at the timeout, 5 when the
pane no longer runs an agent.

## How to work

1. **Look first.** Read `list` before every send: the pane may have changed, or the agent may be
   waiting on a dialog.
2. **One pane at a time.** Send each message to one pane, by id. Never loop over panes to send
   the same text to several agents, and never send to your own pane (the one this session runs
   in; ask the user which it is if you are not sure).
3. **Send, then wait, then read.** After `send`, run `wait`, then `read`. A message to a working
   agent is queued; it reads it when it is ready. Do not poll `list` in a loop: `wait` does that.
4. **Dialogs belong to the user.** When `wait` exits 3, run `answer <pane>` and show the user the
   dialog. A permission to run a command, edit a file or use a tool is the user's decision: ask,
   then answer with the number they choose. Answer on your own only a question the user already
   answered in this conversation. A dialog termote cannot answer says so: the user answers it in
   the terminal.
5. **Starting an agent needs a yes.** Before `start`, tell the user the workspace, its directory
   (from `list`), the kind and the prompt, and wait for a clear yes. `start` opens a new tab in
   that workspace's directory. When `list` shows no directory for the workspace (`-`), ask the
   user which workspace to use; do not guess one.
6. **Report plainly.** Tell the user what each agent said, quoting `read` where it matters, and
   what is still open. Keep their decisions theirs.

## Errors

- `(input_has_draft)`: the user typed something in that agent's input box. Ask them to send or
  clear it; never clear it for them.
- `(input_busy)`: another message to that pane is still being typed; try again shortly.
- `(session_changed)` or `(target_changed)`: the pane runs something else now; `list` again.
- `(prompt_changed)`: the dialog changed; show the new one to the user before answering.
- `the server did not answer ... may have been made`: do not send again; `read` first to see
  whether it arrived.

## Never

- Run `termote show-password`, `termote pair`, or print a password, a pair code or a token: your
  output goes into a transcript.
- Send the same message to several panes, or send without reading `list` first.
- Start an agent, or answer a permission dialog, without the user's yes.
- Drive a pane with tmux, Herdr, Zellij or terminal commands instead of `termote agents`.
