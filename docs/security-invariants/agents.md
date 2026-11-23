# Security invariants: Agents

Part of the [security invariants](README.md): agent status, overview, subagents, starting and resuming agents, usage, prompt templates, tasks and review comments.

- **Agent activity** (`server/agent_activity.go`, `GET /api/mux/activity`): the tracker is fed
  only by snapshot reads that already run (the snapshot route, a stream attaching, the push
  watcher's tick, and `server/agent_activity_follow.go`: after `agent/message` or `agent/start`
  succeeded, a peek of the snapshot, which makes nothing, every 2 s while that agent works, one
  loop for every followed pane, each let go once it stops working, shows no work within a minute,
  or after 2 h); the tracker never reads tmux, Herdr or Zellij itself and never runs a command, so
  `/activity` costs no mux call. The one change recorded without a read: after `agent/answer`
  answered 204 (the screen moved on), `leftDialog` moves that pane, only if the tracker shows it
  `blocked`, to `working` with a `blocked` → `working` event, and makes every read begun before
  it stale, so the next read showing it blocked (the next question, another tab, a new dialog)
  records a new dialog for `agents wait`; a refused answer records nothing. Each read takes a generation number before it starts and a read
  that finishes after a newer one changes nothing (no false change). `observe` copies the
  snapshot and gives every agent a new `AgentInfo` before setting `since`/`sinceFirstSeen`, so
  Herdr's cached view (shared with streams) is never written; the snapshot gains `serverNow`.
  Statuses are folded with the push watcher's rule (`foldPaneStatus`) and keyed by `paneKey`;
  a group keyed by tab index (psmux, tmux without window ids) is forgotten, without events, when
  its tabs change, and a Zellij rename from Termote moves the group's prefix (`onRename`).
  Memory: 500 events, one state per pane with an agent. The route: `requireMethod(GET)`,
  `crossSiteRejection` (`Sec-Fetch-Site: none` included, as the snapshot), `after` a
  non-negative integer (else 400 `invalid_after`); a cursor past the latest or before the
  oldest kept event answers the whole ring with `reset`. It returns ids, keys, agent names and
  statuses with times, which the snapshot already gives a view-only client, so view-only may
  read it; nothing from a transcript or a screen. **Unseen turns** (tmux, Zellij, Herdr; never
  hc, which keeps `herdr.seen`; the flag comes from `m.Name()` when the tracker is made, never from
  `snap.Backend`, empty at `observe`): a turn that ends (`working` → `idle`, Herdr's `done`) with no
  viewer since the previous fold is kept unseen and annotated `done` on the copy; once seen, Herdr's
  own `done` reads `idle`. It is an annotation only: no event, `since` unchanged, the push watcher
  folds the raw statuses. Two more inputs, both counts and no command: a full stream's `visible`
  frames (`activityWatch`, one per stream, flipped only when its value changes and counted out at
  the stream's end; tmux by group, the stream showing its session's current window; Herdr and
  Zellij by pane), and the snapshot's unexported `viewers`, filled by the mux's own read (below).
  Memory: one viewer entry per stream, so no more than the hub allows, dropped once no stream
  holds it and a fold passed its last sighting; a Zellij rename moves the key of every stream's
  watch, off screen as well as on, until the stream ends.
  **Native viewers** (`server/native_viewers.go`): tmux runs `list-clients -F
  #{client_pid}:#{client_activity}:#{window_id}` through argv (`tmuxCmd`), never a shell; a client
  whose pid is a terminal Termote runs (`ownTerminals`, filled by `startTerminal`) or with no key
  for 5 minutes (`nativeViewerIdle`) is left out; psmux is skipped. Zellij reuses its
  `list-clients`, leaving out Termote's clients (its own and those closed a moment ago) and every
  client of a session whose slot is held (a client starting), and counts every pane of the tab
  holding a client's pane (`panesOfTabsShowing`); sessions are listed 4 at a time. A
  failed listing counts no one and is logged once until it works again. No pid, tty or client id reaches the snapshot JSON (`viewers` is unexported)
- **Agent overview** (`server/agent_overview.go`, `GET /api/mux/overview`): `requireMethod(GET)`,
  `crossSiteRejection`, `requireAgentRead`; internal errors are logged only. It summarizes the
  panes with an agent in the activity tracker's last snapshot (64 at most) and never reads the
  panes itself: per pane only `AgentSession` and the transcript's tail, through the Chat view's
  read cache (`readCached`), 4 at a time within 3 s (late ones answer `unavailable:
  ["transcript"]`); the whole read is shared for 2 s. It returns ids, the last assistant text
  (280 runes, never a tool result, never a sidechain row), the last row's time, the context size,
  window and share (Claude: tokens and model; Codex: its `token_count` rows; OpenCode: the tokens
  and model id of the last settled answer, the window only when the service's `/api/model` lists
  that provider and model, for the session's directory or, when the session cannot be read, the
  service's own list; else no share), and a branch and
  changed-file count, and the signed `cursor` of the transcript read (the session the card sums
  up, which its Stop sends to `agent/interrupt`; the same cursor the transcript route gives every
  role); never a cwd, a root, a transcript path or a file name. The Claude window comes
  from the transcript's last model row (`claudeModels`: the same file `Locate` found, opened
  nonblocking, scanned forward from where the last scan ended, lines over 64 KiB skipped
  undecoded; only the model id is kept), else from the agent process's argv (`--model`),
  read with the process during the walk that finds it (`claudeProcOf`); only the window is kept,
  argv is never returned or logged. `accounts` are the
  Codex rate limits (`primary`/`secondary`, `plan_type`) of the `token_count` rows already read,
  keyed by an HMAC of the `CODEX_HOME` with the process-lifetime cursor key (`accountKey`, 12 hex),
  never the path; `limit_id`, `credits` and the rest are not sent. No file beyond the transcript is
  read for any of it, and nothing is written. `?pane=<id>` (the header's usage chip) reads
  that pane alone and queues no changes for it; `sessionUsage` (a session's token total, its
  subagents' share and the estimated cost) comes only from a background worker that reads one
  session at a time as `GET .../agent/usage` does (see Agent usage and cost), every 15 s at most,
  kept 5 minutes after last asked; the request never waits for it; only an id the last snapshot shows with an agent
  gets a read and a cache entry, any other answers `panes: []`, so an arbitrary id costs nothing. Changes never run git in the request: a background worker reads one pane at a time
  through `paneRootForRead` (the Files gate: `Caps().Files`, `f.dirs`, `paneRoot`), uses a status
  the Changes view just read, else runs `gitStatusArgs` as a `tryOnly`, `noBackoff` heavy call,
  which returns `errGitBusy` instead of waiting for a slot and never backs the root off; results
  live 30 s, unasked ones 5 minutes. That worker calls `PaneDir` on the backend. A view-only client
  gets the same summary (the snapshot already names the agents) but no branch or count for a
  root `viewHidesRoot` refuses (no repo, a home dir or one above), as Files. The PWA shows the
  last text, the branch, the model, a Codex plan and an agent name it does not know (Herdr reports
  its own; the card and the activity log) with every C0/C1, bidi (U+061C included), line or
  paragraph separator and invisible character (zero-width space, soft hyphen, invisible operator,
  Hangul filler, tag character) as `⟨U+XXXX⟩` (`visibleUnsafe`, `pwa/src/utils/unsafe-chars.ts`). Group, tab
  and session names, which any process in a pane can change (`tmux rename-window`), are shown the
  same way wherever they appear as text or a tooltip: the overview's cards, its queue and the
  activity log, the sidebar (rows, group headers, the collapsed rail, the current session), the
  session tabs, the header, the session chip, the Chat view's header and the confirmations that
  close a session or a group; a rename field keeps the name as it is. So are a pane's label (an
  agent's name or the pane title, which any program sets with an escape sequence) in the pane
  strip, the Chat view's header and the close-pane confirmation, a pane's name (pane strip, a
  one-pane tab's row, the Chat view's header), the Herdr metadata chips (pane strip, tab rows,
  group headers), and a branch name in a worktree group's header and the Changes header
  For a pane whose snapshot shows Claude Code `working`, the overview also reads its screen through
  the prompt route's capture cache (`paneBackground`, inside the same bounded parallel reads) and
  sends `background`, the work its working line says it only waits for, never any other screen text;
  the card then shows no Stop.
- **Agent subagents** (`server/agent_subagents.go`, `GET /api/mux/panes/{id}/agent/subagents`):
  `requireMethod(GET)`, `crossSiteRejection`, `requireAgentRead`; internal errors are logged only.
  Only the pane's own Claude Code or OpenCode session (`AgentSession`, as the transcript): another
  agent, no transcript or no subagents directory answers `{nodes: []}`. Nothing comes from the client but the
  pane id. The directory is `projects/<proj>/<sessionId>/subagents` under the resolved `claudeDir`,
  only when `Locate` resolved the transcript to `projects/<proj>/<sessionId>.jsonl` there; it is opened
  through `os.Root` with every step checked by `Lstat` to be a plain directory (a symlink or a junction
  is refused even when it stays inside), and the opened root must be the directory checked. A file is
  read only when its name matches `^agent-[a-z0-9]{1,64}\.(jsonl|meta\.json)$`, the listing says it is
  a plain file and the opened file is the one listed; meta files over 64 KiB are not read. Ends come
  from the transcript's `queue-operation` rows: the first read takes its last `agentTailMax` bytes,
  later ones go on from the offset kept per session (the same file identity, at most
  `agentForwardMax` behind), so the whole file is never read again; only the first 64 KiB of a line is
  kept, matched by pattern, never decoded. A subagent's own file is read for its first line (1 MiB at
  most) and its last 256 KiB, and a meta file is read, again only when its size or mtime changed;
  every file is opened nonblocking. The overview reads only the new transcript rows, the listing and
  the meta files of subagents with no end (the same checks and cache). A meta file's
  `stoppedByUser: true` (Claude Code's stop of background agents, which writes no end row) ends the
  subagent at the meta file's mtime unless an end row comes later or its file is written more than
  30 s after it.
  OpenCode (`server/agent_opencode_subagents.go`): only through the service (see OpenCode service
  client), never a file: the children of the pane's own session (`GET /api/session?parentID=<id>`,
  the id checked as the pane's session is, at most 200 in all) and their children, no deeper; a
  session is kept only when its `parentID` is the session it was listed for and its id matches
  `^ses[A-Za-z0-9_]{1,64}$`. Running is the shared `session/active` read; else `outcome`. Its last
  tool name and the tokens of its last answer come from its last 10 messages (a page over 24 MB
  is asked again for 1, still up to 24 MB); the type and title are cut as Claude's. What was read of a subagent that
  does not run is kept 10 minutes by its id and its `time.updated` (and the list's limit), so a
  finished one is not read again; a running one is read on every tree read (shared for 2 s).
  Grandchildren that cannot be read are left out and the tree marked truncated. No service found
  answers `{nodes: []}`; a service that refuses or fails, 404 with nothing of its words.
  A Claude Code subagent's own conversation (`server/agent_subagent_transcript.go`, `GET
  /api/mux/panes/{id}/agent/subagents/{agentId}/transcript`): `requireMethod(GET)`,
  `crossSiteRejection`, `requireAgentRead`, then a view-only client is refused (`view_only`, 403): the
  task a subagent is given and the report it ends with are plain text in its file, where in the
  session's transcript they are an Agent tool call's input and result, which `viewTranscript` leaves
  out. The client sends only `agentId`, which must match `^[a-z0-9]{1,64}$` (else 400
  `invalid_request`); only the pane's own Claude Code session (another agent, or none left in the pane:
  404 `session_not_found`; a 404 without a code is a server without the route). The file
  `agent-<agentId>.jsonl` is never opened by a path: it is `Lstat`ed inside the `os.Root` of
  `openSubagentsDir` (the same directory checks as the tree), opened in that root nonblocking and kept
  only when it is a plain file and `os.SameFile` with what was `Lstat`ed, so a link, even to another
  subagent's file, and a file swapped between the two are refused. Every failure to find it (no
  transcript, no directory, a link at any level) is 404 `session_not_found`, answered before the read
  waits for a `transcriptReads` slot, so an id with no file costs no slot. The read is the transcript's
  own (`readJournal`: tail, `cursor`, `before`, the read cache keyed by the subagent, the file identity
  and its size, so the read made when the subagent ends is never a page cached before its last lines);
  its cursors name the session and the subagent, so neither the session's transcript nor another
  subagent's continues from one. Rows marked `isSidechain` are shown only here; the session's transcript
  still leaves them out. There is no image route and no file link for a subagent's conversation
  (`files/mentioned` still compares a path with the pane's own agent transcript only). `Cache-Control:
  no-store`; internal errors are logged only.
  Memory: per session asked for in the last 10 minutes, the ends, meta and file facts of the subagents
  listed. Limits: 200 nodes (the newest), 4 levels, a parent loop dropped, `truncated` set. It
  returns agent ids, the type, the description (200 runes), status, times, the last tool's name and
  a token count;
  never a prompt, a tool input or result, a path or a file name, so view-only may read it; the PWA
  shows the type, the description and the tool's name through `visibleUnsafe`, in the overview's card
  and in the Chat view's strip of running subagents. The
  newest write of a running subagent becomes the overview's `lastTs`
- **Starting an agent** (`POST /api/mux/panes/{id}/agent/start` `{kind}`, `GET` of the same path,
  `server/agent_start.go`, `caps.agentStart`: Herdr ≥ 0.8.2 from the subscription's `ping`, on
  every OS; `caps.agentStartCodex`: also Codex has a Chat view on this OS, `codexProcSupported`):
  `writeGuard` (same-site JSON), `requireWriteRole`
  (a view-only client gets 403 `view_only`, also on `GET`), 64 KB body (`agentMessageBody`). Only `kind` and an optional `prompt`
  are decoded (`claude` → no arguments, `codex` →
  `--no-daemon`, `opencode` → `--session ses_<26 random base32>`, a new id the server makes for
  each start (`rand.Text`), so the pane has a session to show from the start; else 400 `invalid_kind`; the prompt goes through
  `cleanText` and `agentMaxText` as a message's text (413 `text_too_long`; empty once cleaned →
  400 `invalid_request`), and absent (the PWA) means none; `codex` where Codex has no Chat view
  (`codexProcSupported` false) → 501 `unsupported`, checked before the pane is resolved, nothing
  sent to Herdr; the PWA then offers only Claude Code); arguments and the Herdr alias
  (`termote-<kind>-<8 hex>`, one retry on `agent_name_taken`) are the server's. The pane is
  resolved (`requirePane`) before the pane lock, the one message/answer take, so the locks map
  holds only existing panes (404 `not_found`); the lock is waited for as theirs is (409
  `input_busy` past it, nothing sent). Under it: a start of this server still running
  there → 409 `starting`; the pane must be an idle shell (`paneIdleShell`: one foreground
  process, the shell, leading its group, a `knownShells` name, shared with the PWA through
  `server/testdata/known-shells.json`), read again every 250 ms for 1.5 s, else 409 `pane_busy`
  with nothing sent. On Windows the shell must also have no child process (Toolhelp32 snapshot,
  `procChildrenFunc`; a snapshot error fails the start): Herdr there reports as foreground only
  an agent it knows, else the shell, never `ping`, `nvim` or a nested `cmd`, so without this a
  busy pane would read idle and the `C-c` below would kill the program (Herdr's own
  `available_pane_shell` rule); Linux and macOS keep the rule above; `agent.get` on the pane id: Herdr holds a start pending until its deadline
  even when the command failed at once, and lets an expired one go only when it is read (this
  read does), so one still held → 409 `start_pending` with nothing sent; then `C-c` (clears half-typed text, a `PS2` line, a heredoc, a `read`),
  200 ms, the idle check again, polled like the first (the prompt it redraws can run `git`, a child that reads busy on Windows; 409 `pane_busy`), then `agent.start` with `timeout_ms` 30000.
  A body with `newTab: true` (`termote agents start`, for the tab it made just before, or with
  `--worktree` for the first pane of the worktree workspace the same command just opened) gets no
  `C-c` on any backend: a new shell may still run its rc files, and the `C-c` cut them short (zsh
  then lacked the `PATH` its `.zshrc` sets, and the agent was not found). Its shell is waited for
  as a task's new tab is (`waitNewTabShell`: `waitTaskShell` with settle, idle, a prompt shown,
  its text unchanged between two reads, up to 15 s, each read under its own `muxTimeout`; else 409
  `pane_busy` with nothing sent; a backend whose `pane.read` is unsupported gets the idle check
  alone), in place of the first idle check, the `C-c`, the 200 ms and the second check; the start
  then goes on as above. The flag only leaves out that `C-c`: a client that sends it for another
  pane gets its line typed after whatever that pane's input holds, which a client allowed to start
  an agent could type there anyway. Accepted gaps, as for a task's new tab: the settle is a
  heuristic, so an rc file that prints, then keeps working in the shell reads settled early (the
  line then waits in the terminal's typeahead and runs once the rc files end, `PATH` set), and an
  rc file that reads stdin (an update prompt) takes the line; stream input in the new tab before
  the start comes before the line.
  Each Herdr call has its own `muxTimeout`; the whole start runs without the request's
  cancellation once begun. Herdr answers at once (`launch_pending`): 200 `{ok, state:
  "starting"}`; `agent.start` timing out → 504 `start_unknown`, followed as if typed. Herdr's
  `agent_pane_busy` → 409 `pane_busy`, `agent_pane_not_found`/`agent_pane_unavailable` → 404,
  `unsupported_agent_kind` (Herdr 0.9.5 takes `opencode`; an older one may not) and an older Herdr's `invalid_request` naming `agent.start` → 501
  `unsupported`, anything else 500 `start_failed` (logged, never Herdr's text). `GET` (same-site
  read) reads `agent.get` by the alias: `ready` (`interactive_ready`), `blocked`, `exited` (alias
  gone, another agent, `launch_pending` false, or no agent seen and the pane an idle shell again
  4 s after the start: the command failed), `timeout` 35 s after the start, or 404 `no_start`; a final state is kept 60 s, and a refused start leaves it. Accepted gaps: stream input from another client is not
  under the pane lock and can land between `C-c` and the command; a refusal decided by Herdr
  comes after the `C-c`. Windows gaps (accepted for #357): work that runs inside pwsh itself
  reads idle, so the `C-c` clears a wait (`Start-Sleep`, `Read-Host`, `ReadKey`, a loop;
  verified) but also stops a `.ps1` script or a `Copy-Item -Recurse` halfway (on Linux/macOS only
  shell builtins behave so); a process left on the pane's console by `start /b` has no live
  parent, is missed, and gets the `C-c` too (Herdr's own check misses it as well); a shell with a long-lived
  child (`Start-Job`, a GUI app started from it, a process its profile started) is never idle,
  409 `pane_busy` (fail-closed); a `wsl.exe` pane is never idle. The PWA offers it in the Chat view of an idle pane and polls the `GET`
  every 2 s; Codex writes no rollout before its first message, so after a Codex start the Chat
  view asks for that message in the terminal.
  **tmux, Zellij and hc** (`server/agent_start_shell.go`, `shellStarter`; a backend that runs
  tasks, `taskMux`, and finds an agent under a pane's shell, `agentWriter`; not psmux;
  `caps.agentStart` where `agentProcSupported`, `caps.agentStartCodex` also with
  `codexProcSupported`): the same route, guards, body, `kind` table, pane lock and 409 `starting`;
  the pane is resolved through `IdleShell` (gone → 404 `not_found`). Under the lock: `IdleShell`
  polled like Herdr's check (busy → 409 `pane_busy`; a shell `resumeShellKind` does not know →
  409 `unsupported_shell`; nothing sent, not even `C-c`), `Interrupt` (`C-c`), 200 ms, `IdleShell`
  again (409 `pane_busy`, nothing typed; with `newTab` the new tab's wait above replaces the first
  check, the `C-c`, the 200 ms and the second check), then `TypeLine` with the program name and each server
  argument through `shellQuote` for that shell, never a client's. Each backend call has its own
  `muxTimeout` and a call cut short reports the context's error (a killed tmux included):
  `TypeLine` cut short → 504 `start_unknown`, followed as if typed; any other error 500
  `start_failed`. No alias exists: the start is
  followed by pane id, its name only tells this server's starts apart (`pendingStart.shell` picks
  this follower on Herdr). **A prompt** (`server/agent_start_prompt.go`) is never typed and never
  handed to Herdr's `agent.start`, on any backend: Herdr types its arguments into the shell itself,
  quoting them POSIX-style for fish too (a prompt with `\'` then runs commands there, verified with
  fish 4.9.3) and only `'` for PowerShell (not `‘’‚‛`), and refuses a line break, so on Herdr a
  start with a prompt takes this shellStarter path instead (Herdr's `IdleShell`, `Interrupt`,
  `TypeLine`; no `agent.get`/`launch_pending` check, no alias). The prompt is written to a new
  file (`os.CreateTemp`, 0600) in `<UserCacheDir>/termote/start-prompts` (0700, `Lstat` not a
  symlink, `checkPrivateDir`), its path refused when `validTaskDir` would refuse it; the typed
  line ends with words that read it back as one argument when the line runs, the path through
  `shellQuote`: POSIX `-- "$(command cat -- '<path>')"`, fish
  `-- (command cat -- '<path>' | string collect)`, OpenCode `--prompt=` with the same
  substitution instead of `--` (`--` keeps a prompt starting with `-` or naming a subcommand,
  `logout`, a prompt; checked on Claude Code 2.1.330, Codex 0.169.0, OpenCode 2.3.2). Nothing of
  the prompt is on the line, so neither the shell nor its line editor (Tab, a line break, `!`)
  acts on it; `TestAgentStartLineRealShells` runs bash, zsh, dash, sh and fish on prompts with
  quotes, `$()`, backticks, `\'`, line breaks and Unicode. pwsh and Windows PowerShell (no
  substitution that passes a native program one argument whatever it holds), and every shell on
  Windows (`startPromptGOOS`: an agent installed by npm is a `.cmd` shim that cmd.exe reparses, from
  Git Bash too; psmux has no shellStarter, 501 `unsupported` first) → 409 `prompt_unsupported_shell` with nothing sent, not even `C-c`, checked
  before and after the `C-c`; a shell not known at all keeps 409 `unsupported_shell`. The file is
  deleted at once when typing never began, else `startPromptKeep` (35 s) after (a failed or cut
  short `TypeLine` included: part of the line may wait in the shell); `serve` at its start and each
  write delete the dir's `prompt-<digits>.txt` regular files older than that, which a stopped
  server left. Codex's TUI is told from its daemon by `app-server` only before `--`
  (`codexProcOf`), so a prompt naming it is still a prompt. The answer carries `prompt: true`, and `termote agents start` reports a server that
  answers without it (older, so it started the agent without the prompt) instead of claiming it
  sent one (it says so only for a 200; a followed `start_unknown` or `starting` claims nothing).
  Accepted gaps: the prompt is an argument of the agent for its whole life, so other local users
  can read it (`/proc/<pid>/cmdline` without `hidepid`, `ps`), unlike a message; the guide and the
  orchestrator skill say to keep secrets out of it. The agent starts with an empty prompt, while
  the answer says `prompt: true`, when the file cannot be read when the line runs: a fish without
  `string collect` (before 3.1), a pane whose shell runs as another user (`su`), or a line that runs
  more than 35 s after it was typed (typeahead behind a job started after the idle check). The line
  runs `cat` through `command`, so a `cat` earlier on the user's `PATH` reads the file. `GET` reads the pane
  (`AgentSessionNow`, no cache, then a fresh process walk under the shell, `shellStartProc`, for an
  agent with no session yet: Codex before its first message): an agent of the kind in the
  foreground → `ready`, its status `blocked` (Claude Code's session file, Codex's rollout,
  OpenCode's service) → `blocked`, another agent, a gone pane, or no agent and an idle shell 4 s
  after the start → `exited`; `timeout` and
  the 60 s keep as on Herdr. Accepted gap: what runs in the pane after the line is typed is the
  shell's, so a `claude` alias or function in the user's shell runs instead of the program
- **Agent session history and resume** (`GET /api/mux/panes/{id}/agent/history`,
  `GET /api/mux/panes/{id}/agent/history/{session}/transcript?agent=`, `POST
  /api/mux/panes/{id}/agent/resume` `{agent, session, where, fork}`; `server/agent_history*.go`,
  `server/agent_resume.go`): the client names only a pane, an agent (`claude`|`codex`|`opencode`)
  and a session id (`historySessionID`: a lowercase UUID, `isOpencodeSessionID` for OpenCode);
  never a path. The server reads its own user's dirs
  (`CLAUDE_CONFIG_DIR` or `~/.claude`; `CODEX_HOME` or `~/.codex`), both resolved: Claude Code
  `projects/<dir>/<id>.jsonl` (only dirs named like the pane root's encoding, a subdir of it, or of
  200+ characters; never `<id>/subagents/`), Codex `sessions/<Y>/<M>/<D>/rollout-*-<id>.jsonl`
  newest day first, at most 2000 files per agent (`truncated`), plus `session_index.jsonl` (first
  4 MB) for thread names. Each file must resolve (`EvalSymlinks`) inside that dir and be a regular
  file, opened nonblocking; a rollout's resolved name must still carry its id and its first line
  (at most 256 KB) be the `session_meta` of that id, a thread whose `thread_source` is not `user`
  is skipped. A session counts only when the `cwd` the file records (resolved when it still
  exists) is the pane's root (`paneRootForRead`, as Files) or under it, compared without case on
  Windows and macOS; the dir name only narrows the scan. Only 64 KB at each end of a transcript
  (Codex: after the meta line) is read for the title (`custom-title`, then `ai-title` or the Codex
  thread name, then the first prompt, never a note beside it such as a `!` command's output; a view-only
  client gets no OpenCode title, which its model writes from the first message, a command template's
  shell output included: `viewHistoryTitles`), branch and cwd; titles are one line of at most 200 bytes
  without control or invisible characters. The reply holds the cwd relative to the root, never an
  absolute path; pages of 30 continue through a MAC'd cursor (`historyCursor`, the transcript
  cursors' key, a prefix of its own), a forged one is 400. Reads (list and transcript):
  `crossSiteRejection`, `requireAgentRead`; a view-only client is refused (403 `view_only`) where
  Files refuses it the root (no git repo, a home dir) and gets transcripts through
  `viewTranscript`, as the Chat view's (text only: no tool part, no note). A transcript is read only for a session the listing finds in that root
  (another root's, another agent's or an unknown id: 404 `session_not_found`, no reason given),
  and from the file that listing matched to the root (Claude Code: `Transcript`, never another
  project dir's file of the same id; Codex: its rollout), through the journal adapters' own `Locate`
  checks. One scan per root is shared for 10 s; parsed
  files are kept by path, size and mtime (at most 5000). `live` marks a session some pane runs now
  (its agent lookup, cached). OpenCode's sessions come only from the server user's own service
  (see OpenCode service client in [`agent-chat.md`](agent-chat.md); never `opencode.db`): `GET /api/session?parentID=null&limit=100`,
  page after page through the service's own cursor (passed back to it only, at most 1 KB), at most
  2000 sessions (`truncated`), one read shared for 10 s by every root; the service's
  `directory` filter matches one directory exactly, so it is not used. A session counts only with
  no `parentID` (a subagent's is never listed), an id `isOpencodeSessionID` takes, and a
  `location.directory` that, cleaned and resolved when it still exists, is the root or under it
  (`relUnder`, as above; not required to be absolute by Go's rules, since the path is the
  service's); title through the same cleaning, `titleSource: ai`, the time its `time.updated`. A
  service that does not run or fails lists no OpenCode session and fails nothing else (logged
  without its body). `model` is read only for the OpenCode sessions of the page sent (at most 30):
  `GET /api/session/{id}/message?type=assistant&limit=1&order=desc` (24 MB), six at once, 2 s in
  all, kept 10 min by id and `time.updated`; only the newest message's `model.providerID` and
  `model.id` are decoded, and `provider/id` is sent only when it matches
  `^[A-Za-z0-9][A-Za-z0-9._:@+/-]{0,127}$`. A read that fails leaves `model` out, is not kept and
  is logged without its body; the page is sent all the same. Its transcript is read as the Chat view reads a running one, only for a
  session the listing finds in that root. Resume: `writeGuard`, `requireWriteRole` (view-only 403 for both
  `where`), 8 KB body, only the four fields; a backend that cannot run tasks (`runsTasks`: not psmux) → 501
  `unsupported`; a session running in a pane and no `fork` → 409 `session_live` with that tab and
  pane (two processes appending to one transcript break it). The command line is the server's:
  `claude --resume <id>` (`--fork-session` with `fork`), `codex resume --no-daemon <id>`
  (`codex fork --no-daemon <id>` with `fork`) or `opencode --session <id>` (its id holds only
  `[A-Za-z0-9_]`), typed as
  keys (`TypeLine`, never a paste) only into a shell `resumeShellKind` knows (else 409
  `unsupported_shell`): `taskShellKind`'s, plus Windows PowerShell 5.1 (`powershell.exe`) for resume
  only, in pwsh's syntax (the line needs no exit status or markers, and 5.1 quotes `'...'` as pwsh
  does); Tasks still refuse 5.1. `tab`: a new tab of the pane's group at the session's dir when it is still a
  dir inside the root (resolved), else the root (`validTaskDir`, else 400 `invalid_root`), named
  from the title only when `validPaneName`; its shell must settle at its prompt (`waitTaskShell`,
  409 `shell_busy`), an unsupported one has its tab closed again. `here`: under the pane's input
  lock (409 `input_busy` past the wait), the pane's shell must be idle (409 `pane_busy`, nothing
  sent), then `C-c`, 200 ms, idle again, then the line, after `cd '<dir>' &&` (fish `; and`, pwsh
  `Set-Location -LiteralPath ...;`, `shellQuote`d) when the session's dir is not the pane's. An
  OpenCode `fork` (allowed for a running session too) is `POST /api/session/{id}/fork` `{}` to the
  service for the session the listing found, made after the shell checks and right before the line
  (a new tab is closed again when it fails); the reply is decoded up to 1 MB for its `id` only,
  which must pass `isOpencodeSessionID`, and that new session is the one the line opens. The
  service's 404 → 404 `session_not_found`, any other failure or no service → 502
  `agent_unavailable`, logged without its body; nothing is typed. The TUI that line opens starts
  the service itself when none runs (OpenCode's own behaviour, documented; termote never does). The
  typing runs without the request's cancellation once begun. Each resume logs `audit:
  agent-resume` with the agent, the id's first 8 characters (`shortSessionID`: a shorter
  OpenCode id whole; for a fork, the session forked), `where`, `fork` and who; never a title
  or a path. Accepted gaps, as Tasks: stream input from another client can land between `C-c` and
  the line; a session the 10 s cache does not hold yet is 404 until the next scan; an OpenCode
  fork whose line then fails to type stays in OpenCode's list
- **Agent usage and cost** (`GET /api/mux/panes/{id}/agent/usage[?agent=&session=]`,
  `GET /api/mux/panes/{id}/agent/usage/summary`, `GET /api/mux/usage`; `server/agent_usage*.go`,
  `server/agent_journal_scan.go`, `server/agent_session_files.go`, `server/agent_pricing.go`):
  `requireMethod(GET)`, `crossSiteRejection`, `requireAgentRead`, `Cache-Control: no-store`; internal
  errors are logged only. The client names a pane and, for an old session, an agent and a session id
  (`isSessionID`), never a path. One session: without parameters the pane's running one (its agent
  lookup), with them a session the pane root's history lists (`historyRoot`, `findHistorySession`,
  as the history transcript: 400 `invalid_request`, 404 `session_not_found`); its transcript through
  the journal adapter's `Locate`, then `openHistoryFile` (resolved inside the agent's dir, regular,
  nonblocking), plus Claude Code's `projects/<proj>/<id>/subagents/agent-*.jsonl` opened with the
  subagent tree's checks (`openSubagentsDir`: each step a plain directory by `Lstat`, then
  `openPlainFile`: still the regular file listed), and the rollouts of the Codex threads whose
  `session_meta` names it (or a thread of it) as `parent_thread_id` (`forked_from_id` for a
  `subagent` thread), found through the history's index in the day dirs from the parent rollout's
  on, the newest 2000 rollouts, the list shared for 60 s. Root summary: the sessions the history lists for the root (the same view-only refusal
  where Files refuses the root) written in the last 8 days, with their subagents' files. Machine
  summary: the server user's whole `projects/<dir>/<uuid>.jsonl` and
  `projects/<dir>/<uuid>/subagents/agent-*.jsonl` (no deeper, links skipped by the listing and refused
  by `openHistoryFile`) and the 400 newest Codex day dirs (a rollout resumed long after the day it
  started on still counts), files written in the last 8 days by their mtime, at most 5000 per agent (newest kept, `truncated`); a view-only client reads it. Files are
  read incrementally (`journalScanner`): by resolved path, the next read starts where the last one
  ended when the file is the same (`os.SameFile`) and not shorter, else from the start; only complete
  lines, a line over 2 MiB skipped undecoded, only lines naming `"usage"` (Claude) or
  `session_meta`/`turn_context`/`token_usage_record`/`token_count` (Codex) decoded, and of them only
  token counts, model ids, message or response ids and times are kept (12000 files at most, above the
  summary's 5000 per agent, the least used tenth dropped). Requests count once by `message.id`/`response_id` (across files in a summary),
  `<synthetic>` and other threads' rows are skipped. Replies hold only numbers, model ids, the price
  table's date and 15-minute UTC bucket times: no path, cwd, title, session id or
  text. Shared reads: a session 5 s, a summary 30 s. Costs are estimates from the price table built
  into the binary, nothing configurable. OpenCode (`server/agent_usage_opencode.go`) is read only
  through the OpenCode service client (no file opened, nothing of `opencode.db`, the service never
  started), with a session id checked by `isOpencodeSessionID` before it goes into a URL path: the
  pane's session, or one the root's history lists (`sessionTarget`, as above). One session is its
  `session.get` (`tokens` and `cost` only, no model listed), and its subagents' sessions
  (`session.list` with `parentID`, two levels, at most 200); a session the service does not hold
  yet has used nothing.
  The summaries read `GET /api/session/{id}/message?type=assistant`, 100 a page, newest first, until
  one older than the summary, at most 5000 per session, kept by session id and `time.updated` for
  an hour (30 s for the OpenCode share of one summary, the sessions read before that kept); of a message only its id, time, model, tokens and cost are decoded, and a fork's copies
  of its parent's (`msg_…_<n>`) are skipped. Root summary: the history's OpenCode sessions of the
  root (the same filter as its list) updated in the last 8 days and their subagents (two levels);
  machine summary: every session `session.list` gives (subagents' and archived ones too) updated in
  the last 8 days, at most 5000 (`truncated`). The cost is the one OpenCode recorded at the prices of
  the user's provider, never the price table: 0 shows the tokens alone and counts nothing as
  unpriced, and the PWA tells the two apart by agent. A service that does not run adds nothing and
  fails no route (one session: 404 `transcript not found`); one that fails is logged without its
  body and marks the summary `truncated`, the other agents' share still sent. Model ids are the
  service's `provider/id`. Accepted: the machine summary tells a view-only client how many tokens
  each agent used across every directory, by 15 minutes
- **Files a session touched** (`GET /api/mux/panes/{id}/agent/touched[?agent=&session=]`;
  `server/agent_touched*.go`): `requireMethod(GET)`, `crossSiteRejection`, `requireAgentRead`,
  `Cache-Control: no-store`; internal errors are logged only. The client names a pane and, for an
  old session, an agent and a session id, never a path; the root is the pane's (`historyRoot`, the
  view-only refusal where Files refuses the root: no git repo, a home dir → 403 `view_only`) and the
  session is the pane's running one or one its root's history lists (`sessionTarget`, as Agent
  usage: 400 `invalid_request`, 404 `session_not_found`). The files read are the session's, opened as
  Agent usage opens them (`sessionFiles`: the transcript through `Locate` and `openHistoryFile`,
  Claude Code's subagent files through `openSubagentsDir`/`openPlainFile`, the Codex child rollouts
  found through the history's index), incrementally (`journalScanner`, only lines naming
  `"tool_use"`/`"tool_result"` or `FileChange`/`patch_apply_end`/`session_meta`/`turn_context`
  decoded). Of them only the paths of Claude Code's `Edit`, `MultiEdit`, `Write` and `NotebookEdit`
  calls whose result is not `is_error` (or not come yet: running, kept only for the pane's own live
  session), of Codex's `FileChange` items
  with `status: completed` and of legacy `patch_apply_end` events that succeeded, their kind and
  times are kept; a sidechain row of the main transcript and the rows a subagent's rollout copies
  from its parent (ordinal below `subagent_history_start_ordinal`) are skipped. A relative path is
  joined to the cwd the journal records, then cleaned. A path is never opened, and one outside the
  root as written (`relUnder`, without case on Windows and macOS) is dropped before anything is
  looked up, so a journal's `\\host\share` or `/net/<host>` path never reaches the network or a
  mount; one inside is resolved once (`EvalSymlinks`, through its directory when the file is gone)
  and dropped when it then leads outside the root, is the root itself, or is `denied` (a deny dir,
  the repo's `.git`, a separate git dir); dropped paths are only counted (`skipped`). The reply holds paths relative to the root, `sensitive` (`sensitivePath`), and for a
  full client the kinds of change, a count, the last time, `sub`, `running` and `deleted`; at most
  2000 files of the root, the latest, counted after the dropped ones (`truncated`). Contents and diffs are never in it: the PWA reads them through
  `files/diff` and `files/content`, with their own checks and `reveal`. A view-only client gets only
  the paths of the root's tracked list (`findLists` `committed`) that `viewHides` lets it read, in
  name order, with `sensitive` only (no kind, count, time, `sub`, `running`, `deleted`, `skipped` or
  `truncated`); a list that cannot be read refuses the request as Files does. One read per root,
  session and role is shared for 4 s. An OpenCode session (`server/agent_touched_opencode.go`) is
  read only through the OpenCode service client (no file opened, nothing of `opencode.db`,
  `session.diff` not used, the service never started), its id checked by `isOpencodeSessionID`
  before it goes into a URL path: its `session.get` (directory, update and turn times), its
  `GET /api/session/{id}/message?type=assistant`, 100 a page, newest first, at most 5000 (older ones
  not listed), and its
  subagents' sessions (`session.list` with `parentID`, two levels, at most 200, each with its own
  messages). Of a message only its id, time and the name, status, input and times of its tool calls
  are decoded, and only the calls of `edit`, `write` (their `path`, else `filePath`) and
  `patch`/`apply_patch` (the `*** Add File:`, `*** Update File:`, `*** Move to:` and
  `*** Delete File:` lines of `patchText`) with `status` `completed` (or `running`, kept only for the
  pane's own live session) are kept; a call that failed or that the user declined (`error`), another
  tool, and a fork's copies of its parent's messages (`msg_…_<n>`) are skipped. A relative path is
  joined to the directory the service records for that session (a subagent's, else its parent's),
  then placed as above. An idle session's files (its `time.idle` after its `time.busy`) are kept by
  session id, `time.updated` and `time.idle` for an hour; any other is read every time (a tool call
  does not change those times). A session the
  service does not hold yet changed nothing; a service that does not run gives 404 `transcript not
  found`; one that fails is logged without its body and answered as an internal error; a subagent
  that cannot be read is left out. Accepted: a file changed by a shell command is not listed, nor
  one the journal names through a path that is outside the root as written (a symlink to it), nor
  one changed by an OpenCode tool of another name
- **Prompt templates** (`/api/mux/templates*`, `server/template_store.go`,
  `server/template_routes.go`, `caps.templates`; PWA `pwa/src/hooks/use-prompt-templates.ts`,
  `utils/prompt-templates.ts`, `template-fill-dialog.tsx`, `prompt-templates-section.tsx`): one
  file `<stateDir>/templates/templates.json` (dir 0700 through `checkPrivateDir`, file 0600
  through `writeStateFile`, a symlinked file or dir refused, stale `.templates-*.part` removed;
  the state dir is in `FilesDenyDirs`; `uninstall --purge` removes it with the state dir). The
  templates are what the user typed: a file that cannot be read (corrupt JSON, no `v`, larger
  than 16 MiB) is never renamed or written over: at start it turns the store off
  (`caps.templates` false, every route 503 `templates_unavailable`), later every write fails
  (500) and reads keep what was read; a `v` above 1 (a newer
  version's) is read only (every write 409 `newer_format`), so a rollback of `update` keeps
  them. Every write takes `templates.lock` (`lockStateFile`, 2 s, then 503 `busy`), reads the
  file again, applies one change and writes, so a second `serve` on the same state dir loses
  nothing; a read never waits for another process's lock and reads the file again when its time
  or size changed. `GET` (every role) goes through `crossSiteRejection` and `no-store`;
  `POST /templates`, `PUT|DELETE /templates/{id}` (16 hex digits, else 404) and
  `POST /templates/import[?dryRun=1]` through `writeGuard`, `requireWriteRole` (403
  `view_only`) and a body limit (40 KiB, an import 100 × 40 KiB; over it 413 `too_large`): the
  largest template whose every byte JSON escapes to two fits. Limits, checked on writes only: 100
  templates (409 `too_many`); a name of 1-64 characters once trimmed, unique case aside
  (`EqualFold`, 409 `name_taken`); a text of 1-16384 bytes once line breaks are `\n`; both
  refuse control characters (the text keeps tab and newline) and characters that show nothing
  (format characters but ZWJ/ZWNJ, tags U+E0000-E007F, variation selectors U+E0100-E01EF): 400
  `invalid_template` with `field`, so a shared template cannot carry an instruction its reader
  cannot see (`server/testdata/template-hidden-chars.json`, read by the Go and PWA tests). `PUT`
  and `DELETE` name the `updated` they read: another one is 409 `conflict` with the template as it
  is now, a missing one 404 `not_found`. An import is one write or none: every entry checked
  first (400 `invalid_template` or `duplicate_name` with `index`; more than 100 entries is 409
  `too_many` before any is checked or compared), a name already there
  (`EqualFold`) replaced, the rest added; the dry run says which by name, and the import names
  what it replaces (`replace`): another set is 409 `import_changed`. An error carries its code, a
  fixed message and what it is about (`field`, `index`, the current `template`), never OS text or a
  path; anything else is logged and answered with a generic 500; no
  name or text is logged, and there is no `audit:` line. The PWA never sends a template: it is
  filled in a dialog and put in the Chat draft (`requestDraftInsert`), only for the pane and agent
  it was picked for; a view-only client has no composer and in Settings only lists and exports.
  Names and texts are shown through `visibleUnsafe`. The templates read are kept in memory for the
  server of the snapshot's `instanceId` and dropped when it changes, when `caps.templates` goes,
  and on sign-out. `{{selection}}` is the text last selected in the terminal, the select-text
  sheet, the editor, a file shown or the Chat transcript, kept per pane in memory only, never
  from a sensitive file shown (`reveal`), dropped on another server and on sign-out; the Chat
  drafts (`sessionStorage` `termote-chat-draft:*`) are cleared on sign-out too. Limits: native and
  container keep separate templates; a name differing only by a look-alike character is another
  name (the import confirmation lists every name); with tmux, a selection in another split of the
  window is kept for the pane shown. The Chat's Quote button (`chat-quote.ts`, `chat-selection.ts`)
  uses the text last selected in the transcript, built from the DOM as shown (a list keeps its
  numbers and a path drawn as a `data-file-ref` button its text; other button labels, `select-none`
  and `sr-only` text, the body of a closed `<details>` (thinking) and what a folded
  `data-quote-clip` block hides below its bottom stay out) and kept per pane in memory only, dropped
  once quoted, on a click or tap in the transcript that leaves nothing selected, on leaving the
  pane or the view, on another server and on sign-out. The quote goes
  through `revealHidden` (a hidden character shows as `⟨U+XXXX⟩`), its `[Image #N]` becomes
  `[Image N]` so it never names an image of the draft, and it is cut to 60 lines or 4 KB (a longer
  line on a character boundary). It is only put in the draft, after the caret and replacing nothing,
  never sent (an `@path` in it is read by Claude Code once the user sends it, as typed text is); the
  button is off while sending and absent with a dialog open and for a view-only
  client (no composer)
- **Tasks** (`/api/mux/panes/{id}/tasks`, `/api/mux/panes/{id}/tasks/run`,
  `/api/mux/tasks/runs/{runId}`, `/api/mux/tasks[/{id}]`; `server/tasks.go`,
  `tasks_discover.go`, `tasks_tools.go`, `tasks_tools_toml.go`, `tasks_shell.go`, `tasks_run.go`, `tasks_run_state.go`, `task_store.go`,
  `task_routes.go`, `mux_{tmux,herdr,zellij}_tasks.go`; `caps.tasks`: the Files routes work and
  the backend runs tasks (`taskMux` and `runsTasks`: tmux, Herdr, Zellij; never psmux, whose `%N` can name
  another session's pane);
  `caps.userTasks`: the store is usable). Every route is a full client's only, reads included
  (403 `view_only`): a script's command, a user task's command and a run's output can hold a
  token or a path. **Listing** (`GET .../tasks`): `requireMethod(GET)`, psmux → 501 (before the root is read), then the Files routes'
  `start` with `requireWriteRole` (never `begin`, which lets a view-only client through and runs
  git for it), so cross-site, the role and `?root=` (409 with the current root) are checked
  before anything is read; `no-store`. Nothing runs: `package.json` and one Makefile (the one make
  picks: `GNUmakefile`, `makefile`, `Makefile`) are read through `os.Root` under the pane's root,
  never under a Files deny dir, opened non-blocking, a regular file only (a FIFO answers at once),
  at most 1 MiB (else named in `tooLarge`, read as empty). Script and target names must match
  `^[A-Za-z0-9][A-Za-z0-9:_.@/+-]{0,99}$` (others counted in `skipped`), at most 500 of each;
  Makefile targets are explicit rules only (no assignment `=`, `:=`, `::=`, `?=`, `+=`, `!=`, no
  directive or `define` block, no `.`-special, `%` pattern or `$` name). A script's command is
  shown (cut at 4096 bytes) with its `pre`/`post` hooks, which npm, pnpm and bun run too.
  The other tools (`toolGroups`, in this order) are read the same way, from the root only, each
  file once per listing, no tool started: Gradle (`build.gradle.kts`, else `build.gradle`, else
  only `settings.gradle(.kts)`: the fixed `build test check clean assemble`, `run` when the root's
  build file applies `application`, `bootRun` when it applies the Spring Boot plugin, never a
  dependency or `apply false`; no script evaluated, no sub-project read), Maven (`pom.xml`: `clean
  compile test package verify install`), PDM (`[tool.pdm.scripts]` but `_`, with `pre_`/`post_`
  hooks), Hatch (`hatch.toml` `[envs.<e>.scripts]` when present, else pyproject's
  `[tool.hatch.envs.<e>.scripts]`; a key holding `:` left out; shown `name` for `default`, else
  `env:name`), Poe the Poet (`[tool.poe.tasks]` but `_` names), Cargo (`Cargo.toml`: `build check
  test clippy fmt`, `run` with `src/main.rs` or a `[[bin]]`; `[alias]` of `.cargo/config`, else
  `.cargo/config.toml`, minus every name of a Cargo command or built-in alias; an alias of the
  external `clippy` or `fmt` overrides it and shows on that task), Go (`go.mod`:
  `build`/`test`/`vet ./...`, `run .` with a root `main.go`), just (`justfile`/`.justfile` in any
  case; two of them is `unreadable`; recipes with no `_` name, no `[private]` attribute and no
  parameter without a default; read line by line), Task (the first of go-task's
  `Taskfile.yml`, `taskfile.yml`, `Taskfile.yaml`, `taskfile.yaml` and their `.dist` forms: the
  keys one indent under a column-0 `tasks:`, read as YAML scalars line by line, but `internal:
  true`), Composer (`composer.json` `scripts`) and Deno (`deno.json`, else `deno.jsonc`, `tasks`;
  comments and trailing commas stripped). Names follow the same pattern and cap per group (each
  once, file order kept); a detail (a script's body) is cut at 4096 bytes. TOML (`pyproject.toml`,
  `hatch.toml`, `Cargo.toml`, `.cargo/config(.toml)`) is read at most 256 KiB (else `tooLarge`),
  pre-scanned outside strings and comments (arrays and inline tables nested at most 32 deep, at
  most 16 dotted parts in a key, at most 32 parts in a key's whole path through the inline tables
  and arrays it is in: the decoder's cost grows with the square of the path, a 40 KB dotted key
  costs it gigabytes, short dotted keys nested in inline tables hundreds of megabytes), then decoded into structs holding only the tables read, two decodes at
  once server-wide (a file that gets no slot before its request ends is named in `unreadable`, the
  rest of the list still shows).
  `pyproject.toml` is decoded once for PDM, Hatch and Poe. A file there that is no valid JSON or
  TOML, refused by the pre-scan, or one of two justfiles is named once in `unreadable`.
  **Run** (`POST .../tasks/run`, body ≤ 4 KiB `{kind, name|id, root, newTab}`): `writeGuard`,
  `requireWriteRole`, then `start` as above; the client only names the task, never sends a
  command: the server reads the root again and runs only a name in that list (404
  `task_not_found`, nothing opened or typed), a user task by its id from the store; a `root`
  other than the current one is 409. A kind that is neither `script`, `make`, `user` nor a tool is
  400 `unknown_task_kind` (`taskCommand` returns nothing for it and nothing is typed). It builds
  the line itself: `<pm> run <name>`, `make <name>`, a tool's constant program and runner
  arguments followed by the task's arguments, each quoted (`gradle`, `mvn`, `pdm run`, `hatch run
  <env>:<name>`, `poetry run poe` with `poetry.lock`, `uv run poe` with `uv.lock`, else `poe`,
  `cargo`, `go build ./...`, `just`, `task`, `composer run-script`, `deno task`; never a text a
  file supplied), or the user's one-line command handed whole to `eval` (`Invoke-Expression` in pwsh), the name or
  command quoted for the shell found (POSIX `'…'`, fish `'…'` with `\\` and `\'`, pwsh `'…'`
  doubling `'` and U+2018–U+201B), wrapped between `[termote-task <nonce> start]` and
  `[termote-task <nonce> exit <code>]` (a fresh 16-hex nonce per run). Gradle and Maven run their
  wrapper (`./gradlew`, `./mvnw`; `.\gradlew.bat`, `.\mvnw.cmd` from pwsh on Windows) only when it
  is a regular file in the root as `os.Root` sees it (a symlink out of the root is refused, the
  bare program runs); the listing shows the POSIX choice (on Windows a root with `gradlew` and no
  `gradlew.bat` lists `./gradlew` and pwsh runs `gradle`). Every parser keeps the names it has seen
  in a map, so a 1 MiB file lists in linear time; a run of a script, target or user task reads no
  other tool's file. A tool task's tab is named
  `task:<kind>:<name>` (two tools may share a name), others `task:<name>`. Only bash, zsh, sh, dash,
  ash, ksh, mksh, yash, fish and pwsh are typed into; any other shell (PowerShell 5.1, cmd, nu,
  csh) is 409 `unsupported_shell` with nothing typed. The root goes to the backend as the new
  tab's directory, never into the line (tmux `new-window -d -c` and `-n` through `tmuxLiteral`,
  Herdr `tab.create` `cwd`, Zellij `new-tab --cwd=`); one holding a control, invisible or invalid
  character is 400 `invalid_root`. The line is typed as keystrokes, never pasted (tmux `send-keys
  -l` then `Enter`, Herdr `pane.send_text`, Zellij through a Termote client), into the pane by its
  own target (tmux `%N`). A lock per task (root, kind, name or id) is held from looking up its last
  run until the line is typed, so two devices pressing Run open one tab (the other gets 409
  `task_running` with its `runId`); typing holds the pane's input lock the agent routes take. The
  last run's tab is used again only when its shell waits at its prompt (the shell itself in its
  terminal's foreground, tmux not in copy mode) and is still the shell process the run typed into
  (its pid, as `IdleShell` reads it; never when unknown), so a pane id a restarted tmux, Herdr, hc or
  Zellij gave another pane gets a new tab instead: C-c clears its input line first and the shell is
  checked again; a new tab is never sent C-c (its rc files may still run) and is typed into once
  its shell is idle and its text stopped changing (up to 15 s); a shell still busy after the wait
  is 409 `shell_busy`. A new tab whose line could not be typed (`shell_busy`,
  `unsupported_shell`) stays open and is kept, shown to no client, as the task's next tab, so
  Run never piles tabs up. A user task's command is checked again before it is typed (400
  `invalid_task`: the file can be edited by hand). Zellij without a client is 409 `no_client`; a
  tab closed meanwhile 409 `tab_gone`. pwsh resets `$LASTEXITCODE` before the command and reports
  it first (`Invoke-Expression` leaves `$?` true after a failed native command). **Update** (kind
  `termote`, name `update` only, else 404 `task_not_found`; Settings' Run in a new tab): listed in
  no root and the root is not compared (any pane of the server can ask, its group gets the tab), but
  `start` and `requireWriteRole` hold as above. The tab opens at home (`updateTabDir`), never at the
  pane's root, whose shell hooks (direnv, mise) could change the HOME or XDG dirs the update finds
  its install by. Its line is `serverUpdateSteps`, set once at `serve` start from
  the install (`updateSteps`): the installer's `current` binary with `update`, or Homebrew's
  `<prefix>/bin/brew upgrade termote && <prefix>/bin/termote restart`, every word quoted, each
  program by its absolute path (pwsh calls it with `&`); a container, a checkout or a binary
  copied by hand has none, and a step word holding a control character is refused: both 409
  `update_unsupported`, nothing opened or typed. Its lock is one per server (key root `""`) and
  `newTab` is ignored, so a running update is 409 `task_running` and two never race on `current`
  and the service; its run is in no root's list; its tab is `task:termote:update`. An `audit: task-run` line names the
  kind and the name (or the user task's id), never a command. **State** (`GET
  /api/mux/tasks/runs/{runId}`, same-site, `no-store`): runs live in memory only (at most 200, 24
  h; a restart forgets them: 404 `run_not_found`), checked at most every 2 s whoever asks; a
  shell still running something is `running` without its text being read; else the last 400
  lines are searched for the run's end marker (`exited` with its code); a shell back at its prompt
  for 2 s without it (the screen cleared) is `ended`, a closed pane `gone`, and so is a pane now
  running another shell than the run's (both pids known: a restarted tmux gave its id to another
  pane), so Run opens a new tab at once instead of 409 `task_running`. The markers are a hint:
  a program in the same terminal can print one. **Send to agent** has no route of its own: the PWA
  reads the task pane through `panes/{id}/text` (at most the Settings line count, 100-5000, default
  400) and sends through `agent/message` (with a cursor from the transcript, `session_changed`
  retried once), so both routes' invariants hold. It sends the run's output only: up to its end
  marker (none: nothing is sent), from its last start marker before it, or, when that is past the
  lines read, from the first line read with "(earlier output cut)"; never what was in the tab
  before the run or typed after it. Characters that change or hide text without showing (controls
  other than tab and newline, format characters but the joiners, tags) become `⟨U+XXXX⟩` (the cases
  of `server/testdata/template-hidden-chars.json`); the output is fenced, introduced as terminal
  output that is not to be trusted, and cut from its start to 16 KiB. Send is offered whatever exit
  status the markers claim. The agent pane picked is kept per group in `localStorage`
  (`termote-task-agent:<groupId>`), a pane id only, shared with Review comments' Send (picking in
  either changes the other's default). **User tasks** (`/api/mux/tasks*`): a store
  of its own, `<stateDir>/tasks/tasks.json`, kept as the prompt templates' (dir 0700, file 0600,
  symlinks refused, `.tasks-*.part` removed, `tasks.lock` 2 s then 503 `busy`, read again before
  every write, a corrupt or oversized file never written over: 503 `tasks_unavailable` at start,
  500 on a later write; `v` above 1 read only, 409 `newer_format`); `GET` is same-site; writes
  `writeGuard`, `requireWriteRole`, a 16 KiB body (413 `too_large`). Limits: 100 tasks (409
  `too_many`), a name of 1–64 characters unique case aside (409 `name_taken`), a command of
  1–4096 bytes on one line with no control or invisible character (400 `invalid_task` with
  `field`); `PUT`/`DELETE` name the `updated` they read (409 `conflict` with the task as it is,
  404 `not_found`). Errors carry a fixed code and message, never OS, backend or path text; no
  name or command is logged
- **Review comments** (`pwa/src/utils/review-draft.ts`, `review-message.ts`,
  `components/review-panel.tsx`): no route of its own. A comment on lines of a diff (Changes) or a
  file (Files, the editor) is a draft per pane in `sessionStorage` (`termote-review:<paneId>`,
  `{v:1, comments}`; anything else read as empty, never written over until the review changes),
  following its pane when ids shift and cleared on sign-out here or in another tab; a storage that
  refuses it keeps it in memory, said once. A file that may contain secrets (its status says so, or
  it was shown after the ask) is commented on with its path and line numbers only: the lines are
  never quoted, neither in the message nor in storage (`addReviewComment` drops a `quote` given
  with `sensitive`). Send goes through `agent/message` (cursor from the transcript, `session_changed`
  retried once), so that route's invariants hold (`requireWriteRole`, 16 KiB, control characters
  filtered). The message names the root, says the quoted lines are file content, not instructions,
  and shows each path as inline code and each quote in a fence longer than any backtick run in it;
  characters that change or hide text become `⟨U+XXXX⟩` in the root, paths, quotes and comments.
  Limits: 50 comments a pane, 4 KiB a comment, 60 lines or 4 KiB quoted a comment (the rest
  counted); a message over 16 KiB is not sent (the size is shown), never cut. The comments sent are
  removed only after a 204 or 202, by id (one added meanwhile stays); a refusal keeps them all. The
  receiver is the pane's own agent (Claude Code, Codex), else the pane picked for its group
  (`termote-task-agent:<groupId>`, as Tasks). None of it is offered to a view-only client (which
  could not send it) or in a window of its own (which keeps nothing on the device)
- **Agents CLI** (`termote agents list|read|send|wait|answer|stop|diff|start`, `server/cli_agents*.go`):
  every command calls a route the PWA uses (`snapshot`, `overview`, `activity`, `agent/transcript`,
  `agent/message`, `agent/prompt`, `agent/answer`, `agent/interrupt`, `tabs`, `agent/start`,
  `files/changes`, `files/diff`, `files/branch`, `files/branch/diff`, `worktrees`, `worktrees/open`)
  over the local socket only (`socketRequestWithin`),
  never TCP: no password is read, sent or printed, and the routes keep every guard and check of their
  own entries (the request carries no `Origin` or `Sec-Fetch-Site`, so it is the CLI the guards
  already let through). In container mode it refuses before sending anything. A pane is named by its
  id or by a name (its own, else its tab's, or `workspace/name`) that exactly one pane has: a name two
  panes share is refused with both ids, there is no pattern, and a command that writes reaches one
  pane; only `wait` reads several (32 at most, each name resolved before it starts). A turn whose
  last word is assistant text ending in `?` (`endsWithQuestion`, `server/cli_agents_question.go`) is
  only marked: `read` from the transcript it already read, `wait` and `wait --job` from one more
  `agent/transcript` read of each pane reported done (a read the server refuses marks nothing);
  the exit status, the job's state and its read mark stay as they are. `read`,
  `send`, `answer`, `stop` and `wait` refuse a pane that runs no agent, before any request to it. `wait` follows
  the activity ring after a mark of each pane's own (`pane@seq`: `send` and `start` print it for the
  pane they gave work to, `wait` for each pane it did not report; `--after` is the mark of a pane
  named without one, the latest seq when neither is given; a pane named twice with marks of its own keeps the older;
  a mark past the newest seq the server has (one from before a restart) resets as an old one does;
  the CLI reads a mark only as a non-negative integer after the name's last `@`, anything else stays
  part of the name, and the server answers a bad `after` `invalid_after`), reading the ring from the
  oldest mark and counting for each pane only its changes after its own, the snapshot read first so
  the changes are recorded with no page open; a status shown before a pane's mark ends nothing, a
  reset ring exits 7 rather than guess. It exits 6 only when, past `agentsWaitGrace` from its start
  and from the last time one was busy, no pane works nor shows background work its ended turn left
  running (`busyPanes`: a Claude Code pane not blocked whose `agent/prompt` activity names it). Its `next` line always names each pane left with its own
  mark, or says none is left; a pane reported on a dialog stays in it with the latest mark, so the
  wait after an answer reports what follows (the next question, the turn's end). A Claude Code pane that went to working after its mark and is still
  working, but whose screen (`agent/prompt`'s activity) shows its answer written and only background
  work left ("Waiting for 1 background agent to finish"), ends the wait once (exit 0) and stays in
  the `next` line with the latest mark, past that start, so the next wait reports the turn's end
  rather than the same state again (a turn started before its mark is followed to its end only); `list`
  shows that state (`background`, read from `agent/prompt` for each Claude Code pane not blocked).
  `list --json` carries `latest` (read after the snapshot listed; absent when the server cannot say)
  and `self`, the pane the CLI runs in only when its environment matches the snapshot for sure,
  never guessed: Herdr's `HERDR_WORKSPACE_ID`, `HERDR_TAB_ID` and `HERDR_PANE_ID` all three the ids
  of one pane; Zellij's `ZELLIJ_SESSION_NAME` and `ZELLIJ_PANE_ID` a pane of that session; tmux's
  `TMUX_PANE` (with `TMUX` set) a pane id of the snapshot whose window id and session name, read
  from the tmux `TMUX` names with `tmux display-message` (argv only, the pane id checked against
  `tmuxPaneIDRe` first), are its tab's key and workspace's name; nothing for psmux or herdr-core.
  `send`, and `job add`/`job set` with `--pane`, refuse that pane before any request
  (`agentsOtherPane`), and let a pane through when `self` is unknown; the server does not refuse
  it (a PWA's job may name any pane). It follows each pane by its activity key
  (`activityKey`, computed from the snapshot's tab `key`), not its id, so a tmux tab that moves
  (a pane whose id is its window's) is still the same agent, and prints the id the pane has now. `stop` requires `--cursor` (no cursor, no request),
  sends the cursor `read --json` printed and is never retried, a `session_changed` least of all. `diff` never sends `reveal`: a sensitive file
  is printed by name only; every file's text is printed after a fixed line saying it is data, in a
  fence longer than any run of backticks inside it, through `cleanOut`, 64 KB at most; the `root`
  the change list was read in goes with each later read, so a pane that moved is refused. `start
  --worktree` checks `agentStart`, `agentStartCodex` for Codex and `worktrees` before any request
  that makes something, and refuses a prompt on Windows there (every shell is refused one,
  `startShellOK`; the local socket puts the server on the CLI's OS), before a worktree or a tab is
  made; a pane's shell (pwsh) is known only once its pane is open; a branch with a worktree is opened again (`worktrees/open`), one that
  exists without one is refused, and so are the main worktree's branch and a worktree the server
  says cannot be opened, all before any request that makes something; `busy` is retried for 90 s at most, a create that answered
  `unknown` or not at all is followed in the list for 60 s and never sent again; run again while that first
  pane already runs an agent (the task's own, from a run before), nothing is started: an idle agent
  of the same kind gets the prompt through `agent/message` as `send` sends it (with its checks:
  `input_has_draft`, readiness), and the worktree's unfinished job is made active again on that
  agent; one that works or waits on a dialog, or is another kind, is refused before any request with
  the pane and its job named, what stays named too; a
  `pane_busy` answer to a pane a run before opened reads the snapshot again and says the same when an
  agent runs there; after a start it names a lockfile (`pnpm-lock.yaml`, `package-lock.json`,
  `yarn.lock`, `bun.lock`, `bun.lockb`, a regular file by `Lstat`, never read) at the root of the
  worktree directory the server listed when that directory has no `node_modules`, to say its git
  hooks are skipped until its dependencies are installed; the agent starts
  only in the first pane of the worktree's own workspace (a workspace of its own, not a tab of the
  one named by `--workspace`), once its directory is the worktree's (`sameDirPath`, through
  symlinks); nothing it makes
  is ever removed, and every failure after the worktree exists names it (`worktreeStays`, then
  `startTarget.note`): its branch with its directory, or, before the directory is read again, its
  branch and the PWA's worktrees, whatever failed (an open refused, a 200 it cannot read, the list
  read after it); a refusal before anything is made says nothing stays.
  `send` reads the transcript's cursor and sends once more only on `session_changed`, as the PWA's
  `sendToAgent`; an answer that may have been applied (`socketMaybeSent`) is never sent again.
  `answer` sends the `promptId` the server issued with the choice (a number, `cancel`, `next` or
  `{"text"}`), so the server's dialog checks decide; over the socket the server refuses a permission
  dialog's option that stops it asking (see Dialog delegation), and `answer --delegated` sends the
  `promptId` and `delegated: true` only, never an option (exit 9 when no grant covers the dialog).
  `stop` follows the pane after its 204 (snapshot and `agent/prompt` each second, 8 s at most) and
  exits 8 when the agent still works; it never sends a second Escape. Every command that reaches a
  pane notes what it did on the active job of that pane (`POST /api/mux/jobs/{id}/event`, see Job
  ledger): the first 200 characters of a message, an answer's option and label (never typed text),
  a stop's result, `diff --stat`'s counts, and for `read` the transcript's last entry time read
  before the transcript and the cursor read with it; a ledger that cannot be read or written is a
  warning on stderr, never the command's failure, and `--json` output stays clean. A job a start gives
  to its new agent is written again every 0.5 s for 10 s while the server answers `job_no_agent`
  (Herdr reports a new Claude Code session late, Codex has none before its first message), then
  without the pane and its state, with `job set <id> --pane <pane> --state active` printed; the agent
  is never recorded from anything but the server's own lookup. `wait --job`
  reads `GET /api/mux/jobs?all=1` on every poll (no mark), reports a job whose `live.unread` is set,
  a blocked pane whose dialog signature (`reportedSig`: kind, title, body, option labels, or
  `no-dialog-read` when the server reads none) with the agent's newest entry differs from the job's
  `reported` (then sends it as `reported`, so the same command asked twice is reported twice and a
  dialog kept open once), only background work once, and a job whose agent is gone; when every
  job's agent is idle with its last turn read and no `live.background` it exits 6 (after
  `agentsWaitGrace` from its start and from the last time one was busy, or at the timeout), and at the timeout it prints each job's state, never a guess; `jobs
  --mine` filters by the activity key of `self` and refuses when `self` is unknown rather than list
  nothing. `start` without `--worktree` opens a tab in the
  workspace (no directory from the client: `tabs` takes none), refuses and closes it when its pane's directory is
  not the one every pane of the workspace is in (the directory `list` shows, which the user agreed
  to), and starts the agent in its pane; a definite refusal or a command that ended closes the tab
  too. A prompt goes in `agent/start`'s body for every kind (the server hands it to the agent at its
  start, see Starting an agent), never through `agent/message`; an answer without `prompt: true`
  (an older server) is reported as a start without it. Text from the server
  is printed without control, hidden or bidi characters (`cleanOut`, `plainText`)
- **Job ledger** (`/api/mux/jobs*`, `server/job_store.go`, `server/job_routes.go`,
  `server/job_identity.go`): `<stateDir>/jobs/jobs.json` (dir 0700 checked by `checkPrivateDir`,
  a symlink refused), written as the tasks file is (`jobs.lock`, read again before each change,
  `writeStateFile`; a corrupt file is never overwritten, a newer format is read only). Lock order:
  `jobs.lock`, then the store's mutex; the store calls nothing outside it, and the routes read the
  tracker and agent sessions before or after a store call, never inside one. 200 jobs, a finished one
  not changed for 30 days dropped at the next write (finished ones make room first); title one line,
  200 runes, never taken from a prompt; prompt 16 KB, note 4 KB, 50 events of 200 runes; control,
  hidden and bidi characters removed on the way in; 32 KB bodies (413 `too_large`), errors as
  `codedError` codes (`job_not_found`, `job_conflict` with the job as it is, `too_many_jobs`,
  `job_invalid`, `job_no_agent`), anything else a logged 500. `GET` is same-site
  (`crossSiteRejection`) for every role; a view-only client gets `id, title, state, branch, live,
  updated` only (never the prompt, note, directory, agent record, grants or history); `live`
  carries the pane's folder now to a full client only, and the branch the overview's background
  read found, which a view-only client does not get for a home dir (`viewHidden`), as the
  overview's changes; the route never runs git itself. A job's worktree is its branch and folder
  (a view-only client's `branch`) only while its agent's pane is in it (`dirInTree`, through
  symlinks) or the agent has no pane; otherwise `live.outsideWorktree` (full clients only) is set
  and the pane's are shown, the worktree record kept. Writes:
  `requireWriteRole` first; a browser's `PATCH` and `DELETE` need `updated` (a stale one is 409
  `job_conflict`); `/event` is the local socket's alone (403 `socket_only`), takes a fixed list of
  kinds, and `read` moves the read mark only forward (`tsAfter`, or another conversation) and only
  with a cursor that verifies (`decodeCursor`). A browser's job is always `createdBy: "pwa"`; a
  `worktree` in a request is ignored unless it comes over the socket, and then only names the source
  workspace and branch: the directory is the one the server's own worktree list
  (`worktreeMux.ListWorktrees`) gives for that linked branch, never a path from the request, refused
  at or above the home dir (`jobDirTooWide`). A job's agent is recorded by the server from the
  pane's agent lookup (`jobAgentOf`: activity key, kind, pid and process start time, session id);
  it is the same agent only while the key, kind, pid and start time all match, or, where the backend
  finds no process (pid 0), the session id (`jobAgent.matches`): an agent at a reused tmux `%N`
  after a restart reads `gone`. What the agent does (`live`) is computed per request from the
  tracker's last snapshot (the CLI reads the snapshot before each ledger read, so it is fresh with
  no page open), the cached agent lookup, the overview's screen read for background work (for an
  idle Claude Code too: `background` then names what its ended turn left running, its status stays
  idle) and the agent's newest transcript entry or subagent write (`summarizePane`'s `agentTS`; a
  message of the user's is not one), so `unread` (a later one, or another conversation, than the read mark, only
  while the agent is idle: one that only waits on background work is reported as that, once) survives a restart and needs no hook into the tracker; a `read` from the PWA's Chat
  view does not move it. Giving the job another agent (`pane`) or finishing it
  ends every grant it has. Moving a job to `review` queues a Web Push of kind `job_review` with the
  job id only (never its title or prompt), only while a device can be sent one
  (`notifyJobReview`), whether the job moved there or was made in it. Zellij renames move the
  ledger's ids as the tracker's (`renameGroup`). In container mode the ledger exists but only the
  PWA writes it (`termote agents` does not run there).
- **Dialog delegation** (`server/job_grants.go`, `server/agent_delegate*.go`, `handleAnswer`):
  a grant is made and revoked (`POST /api/mux/jobs/{id}/grants`, `DELETE .../grants/{gid}`) only by
  a browser signed in with the password or as a full paired device (`canGrant`: `authSession` or
  `authDevice` with role full, not the local socket); the CLI, the bridge (`machineForbiddenPath`),
  Basic auth and a server without sign-in get 403 `grant_pwa_only`, and there is no CLI command that
  makes one. This is the user's say given where the user reads the job, not a wall against a process
  of the same OS user (which can read the password). A grant is pinned when made to the job's agent
  as recorded (`jobAgent`) and, to edit, to the job's worktree directory, refused with 409
  `grant_outside_worktree` while the agent's pane is outside it (`live.outsideWorktree`, a job
  moved to a pane elsewhere); it is a bash prefix the
  command rules accept or "edit", lasts 1 minute to 24 hours, and ends when revoked, expired, the job
  finishes or gets another agent, or the pane no longer runs that agent; 20 per job, 50 uses kept on
  each. `answer` with `delegated: true` is the socket's alone and names no option (400 otherwise);
  under the pane's lock it reads the session again (`sessionNow`) and the screen, requires the
  `promptId` to be the dialog on screen now (`promptIs`), then refuses with 409
  `delegation_out_of_scope` and a `reason`, sending no key, unless all hold: the agent is Claude
  Code; the dialog is a permission dialog with its header (a dialog cut above it is `unparsed`) and
  exactly one option labelled `Yes`; no subagent of the session runs (`subagentTree`); the main
  transcript's last 4 MB hold exactly one tool call without a result (sidechain rows left out;
  Claude Code 2.1.330 writes a call 50 to 110 ms before it draws its dialog, and two calls of one
  message only once both are done, so their dialogs find none and are refused); the header names the
  call's tool (`Bash command`/`Run command`: `Bash`; `Edit file`: `Edit`, `MultiEdit`; `Write
  file`, `Create file`, `Overwrite file`: `Write`). Bash: the input has only `command`,
  `description`, `timeout` (`run_in_background` and anything else: `input_keys`); the command is
  printable ASCII with single spaces, none of ``;&|$(){}*?[]~\'"`><!#``, tab or line break
  (`chars`), its first word (base name, lowercased, a Windows extension such as `.exe` dropped) is
  no shell, interpreter, wrapper or versioned interpreter (`python3.12`) of the one list
  `delegateInterpreters`, which holds `git` too (its options and config run any program:
  `--upload-pack`, `-x`, `difftool`, `bisect run`), and a package manager's second word is no
  runner (`pnpm dlx`, `npm exec`) (`interpreter`); the words between the two dashed rules under the header (a wrapped row's leading `│`
  dropped) are the command's words, in order (`mismatch`); it equals a grant's prefix or starts with
  the prefix and a space (`no_grant`). Edit: the file path is absolute, inside the grant's directory,
  shown on the row under the header as its path relative to that directory (`mismatch`), every
  component printable ASCII without `~`, `:` or `\` and not ending in a dot or a space (no Windows
  short name or stream, nothing case folding or Windows maps onto another name), not a
  denied name or directory whatever the user wrote (`.git` anywhere, `.claude`, `.codex`,
  `.opencode`, `.agents`, `.husky`, `.githooks`, `.lefthook`, `.vscode`, `.idea`, `.cargo`,
  `node_modules`, `.github/workflows`, `.github/actions`, `.mcp.json`, `CLAUDE.md`,
  `AGENTS.md`, `.envrc`, `.env*`, `package.json`, lockfiles, `Makefile`, hook configs, sensitive
  names by `isSensitive`: `denied_path`), and no component on the way, the last included, is a
  symlink or a file with more than one link, read through `os.OpenRoot` with `Lstat` (`symlink`);
  between this check and Claude Code's write a link can still appear, which an agent that can run
  commands there could make anyway. The option sent is the `Yes` one, through the same `answer` path
  (the dialog's signature checked again before the key). The use is kept on the grant and as a
  `delegated` event on the job (the command or path), and logged as `audit: dialog_delegated` with
  the grant, job, pane, path and the command's SHA-256, never the command. Over the local socket and
  the bridge, `answer` refuses (403 `answer_always_refused`, checked when the `promptId` is taken,
  before any key) every option of a permission dialog of any agent, also when another
  termote forwards its own CLI's answer over the bridge (an origin other than `password`, `device`
  or `none`, `browserOrigin`), except cancel, one whose label
  is `No` or starts with `No` and a comma or a space, and the first option when it reads exactly `Yes`, `Yes, proceed` or
  `Yes, once` (`cliMayChoose`): what is not known for sure is refused; a browser's answers, here
  or through another termote's Machines, are unchanged. A grant revoked in the milliseconds between the grant check
  and the key still lets that one answer through. Every answer to a permission dialog over the socket or the bridge is logged as
  `audit: dialog_answer` (pane, agent, dialog title, option label, delegated, grant, by).
