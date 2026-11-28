# Security invariants: Agent chat

Part of the [security invariants](README.md): the Chat view of Claude Code, Codex and OpenCode.

- **Agent chat** (`/api/mux/panes/{id}/agent/*`): for Claude Code on tmux the server reads only
  the transcript in the Claude config dir of the process found in the pane (`CLAUDE_CONFIG_DIR`,
  else `~/.claude`; Windows: `CLAUDE_CONFIG_DIR` from the process's PEB environment block, read with
  `PROCESS_QUERY_INFORMATION | PROCESS_VM_READ` and at most 1 MiB, a value only on a drive letter
  (no UNC or device path), else the server user's `%USERPROFILE%\.claude` when the block cannot be
  read), and only for a process whose start time
  matches its session file's `procStart`; Herdr reports the session id itself, read from the
  config dir of the Claude Code found under the pane's `shell_pid` (`pane.process_info`, Herdr
  0.9.3+, same checks, `paneClaude`) only when its session file names that id, else the server
  user's config dir (`defaultClaudeDir`; also while a Herdr without `pane.process_info` is left
  alone, `herdrProcRetry`). The session id must be a UUID (OpenCode: see OpenCode chat). Every write (Claude Code, Codex
  or OpenCode, whose writes go through its service: see OpenCode chat)
  takes a lock on the pane, waiting for it at most `agentRequestMost` (7.5 min) less the write's own
  bound and only while the client is there, else 409 `input_busy` with nothing sent (so a write
  over a machine ends before its hub's `machineResponseHeaderWait` and is never delivered after
  the hub answered 502; a test checks both bounds); it re-checks the process, session and screen, and sends nothing unless
  the screen shows the expected state (an empty input box, the dialog the client saw with a
  single-use `promptId`). The dialog card shows every text it reads off the screen (title, body,
  option labels and details, tab labels) with its hidden characters as `⟨U+XXXX⟩` (`visibleUnsafe`,
  the body keeping its line breaks), so a bidi override in a proposed command cannot make it read as
  another one before the user approves it. The one row left out is Claude Code's countdown to refusing
  the dialog by itself (`withoutBlockCountdown`: its exact wording, followed by a blank row, the question and
  option 1), whose time would make every poll another dialog: the card states it without the time
  (`autoBlock`); the same words inside a command are kept and shown. A Claude Code dialog taller than the pane, its top
  edge off the screen, is answerable only as a `permission` dialog (`findCutDialog`: no rule at
  column 0 above the footer), its body opening with a `…` row so the card never passes a command's
  visible tail for the whole of it. A box that already holds this very message as text (an earlier send
  refused `paste_not_confirmed` whose paste showed later) gets no second paste: it is submitted
  as it is. Any other draft, a long-paste token (it carries a count, not the text) or a message
  with images is refused 409 `input_has_draft` with no key sent, unless the body asks
  `replaceDraft` (the user's button on that refusal): then one C-c clears the box, sent only to the
  same agent, idle (C-c interrupts a working one: 409 `input_not_ready`) and with the box still
  holding a draft (on an empty box C-c arms the exit), and the paste waits for the box to show
  empty (else 409 `input_has_draft`). A message also goes while the agent works (status `working`): the
  agent takes it into its own queue (Claude Code: Enter; Codex: Tab, since its Enter steers the
  running turn), and the route answers 202 instead of 204; an agent waiting on a dialog
  (`blocked`) or of unknown status still gets nothing, and so does a `/` command to a working
  Codex (Tab would take the popup's pick). Under the pane's lock the screen is read again right
  before each paste (`noDialog`): a dialog that opened since the last read (its status not yet
  `blocked`) gets no paste, 409 `input_not_ready` (`partial_paste` after an earlier part landed), so
  text such as `2` never answers a permission dialog past `cliMayChoose`
  (`TestMessageRechecksDialogBeforePaste`); a dialog opening in the milliseconds between that read
  and the paste is not caught. Clearing a failed paste (C-c) still needs the agent
  idle, since C-c interrupts a working one: a working agent's box is left as `partial_paste`. A
  transcript read the read cache (`readCached`) does not answer waits for one of 4 slots
  (`transcriptReads`): each holds a file's tail, and every signed cursor a client paged through is a
  read of its own, from any role. Claude Code writes its transcript only with the first message: until
  then `transcript` answers an empty conversation whose cursor names the session, so the Chat
  view can send it. A Claude Code started with `--resume <id> --fork-session` (read from its own argv
  with the process, `claudeForkOfArgs`; on Herdr only from the process whose session file names
  Herdr's id) is until then the conversation of `<id>`: `Locate` looks it up in the same config dir
  with the same checks, never from a name the client gives, and the fork's own file replaces it
  (another file identity, so the read starts over). A Codex thread a user forked (session_meta
  `thread_source` `user` with `forked_from_id`; `server/agent_codex_fork.go`) holds only what is
  said after the fork: its transcript (and its images) read the parent's rollout up to the fork,
  then its own, as one stream. The parent's id comes from the fork's own rollout, never from the
  client; it is looked up only in the same `CODEX_HOME/sessions` (day dirs from the fork's back, at
  most 2000 rollouts), opened as the history opens a file (resolved inside it, regular), and taken
  only when its name and its session_meta name that id; it is cut at its first row written after
  the fork's session_meta, so what the parent says later is not shown. Up to 8 ancestors, no id
  twice. The cursor's file identity names every part with its cut: a part replaced since (another
  identity, or shorter than its cut) reads the fork as itself and starts over.
  `GET agent/prompt` also returns `activity`, the agent's working line read off the same capture
  (`server/agent_activity_line.go`: Claude Code's spinner row just over the input box, blank rows
  passed over (at most `claudeBlankRows`, a screen not yet filled) and the nearest row at column 0
  deciding, so an earlier turn's line is never read; Codex's
  `esc to interrupt)` row over the composer; once a Claude Code turn is done, its end line only
  while it names what still runs, read into `background`; with neither line in view, the mode row
  under the input box's bottom border, only the item after its last `·` or the whole row, and only when that
  is a count and a kind of background work (`claudeFooterWorkRe`: "1 shell", "1 shell, 1 monitor"),
  read into `background` alone), `null` when there is none. It adds no capture and
  no write, takes nothing from the client, and holds only that line's own words (each field
  stripped of control characters and cut to 80 runes): a status line, no file content or
  command output, and less than the transcript and dialog card title a view-only client already
  reads for every pane, so both roles get it.
  `GET agent/prompt` also returns `suggestion`, the message Claude Code proposes in its empty input
  box, read off the same capture (`readInputBox`: the box's text when every character of it is
  faint, never a fresh session's `Try "…"` example, a known placeholder or text while a working
  line shows). It adds no capture and no write and takes nothing from the client; the PWA only
  shows it as the box's placeholder and puts it in the draft on Tab or its **Use the suggestion**
  button, never sends it by itself.
  View-only clients get it as they get the screen's other text; their composer ignores it.
  `agent/message` may carry `images`: at most 5 upload ids, each resolved through the upload
  store (a path is never taken from the client; unknown ids → 400 with the bad ids, no store →
  503 `uploads_unavailable`). Each path is pasted alone and the draft must show that many
  `[Image #N]` tokens (11s wait each) before the next; `at` (byte offsets, checked: one per
  image, in order, on a character boundary) puts parts of the text between them, each pasted
  and confirmed on its own, then Enter, with the process and session re-checked between
  pastes and before text pasted first. Text starting with `!` always goes after every image,
  so it is never a shell escape; a `/` command keeps its images in its arguments, and is refused
  while Codex works as a command without images is (an image before it makes it text, queued). If a step fails after the first paste, the box is cleared with one `C-c` only when
  the same idle agent shows nothing but one of the states this request pasted; otherwise 409
  `partial_paste` and nothing is touched.
  `GET agent/image?src=` (`server/agent_image.go`) serves an image the user pasted into a Claude
  Code or Codex message, shown again from its `[image]` chip in the Chat view (numbered by the
  message's `[Image #N]` tokens when there is one per image, else by order when there are several). `src` is a reference
  the transcript read gave the part, HMAC-signed with the cursor key under its own `image\x00`
  domain (a cursor never passes for one): session id, file identity, row offset and the image's
  place in the row; nothing else is taken from the client. The server re-locates the pane's own
  session (`Locate`, as `transcript`), needs the same file identity, an offset at a line start and
  a whole row within 32 MiB. Claude Code: only a `source.type: base64` block of that row (never a
  URL source or a tool result's image), and only of a user row holding text the user typed (not a
  notice): the read lists no image of another row, so a tool's image set at the top of a row (beside
  its result, a notice or nothing) never gets a reference; an image pasted with no words at all is
  not listed either. A message the user sent while Claude Code worked is written only as an
  `attachment` row (`queued_command`): the read shows it as the user's, and serves its images from
  its `attachment.prompt`, only when its `commandMode` is `prompt` and its `origin.kind` is `human`
  (`claudeQueuedPrompt`), so a queued task notification or a subagent's hand-back (`peer`) is never
  shown as the user's words nor gets an image reference. A slash command's images are in the `isMeta` row that
  expands it: the read lists them on the command only from the row right after it whose
  `parentUuid` is the command's, and the reference names that row's offset. Codex: the row must be a `UserMessage` item, and the bytes
  come only from the row right before it, which must be the model's user input (`response_item`
  `message`, role `user`) holding exactly as many `input_image`s as the item has images (so a file
  Codex could not read moves no image onto another's chip), each a base64 `data:` URL; the file a
  `local_image` names by path is never opened, nor any other URL. Either way the bytes must sniff
  (`http.DetectContentType`) as PNG, JPEG, GIF or WebP and as the declared type (never SVG);
  anything else is 404 `not_found`. At most 2 reads at once (else 429 `busy`); a slot covers the
  read and decode only and is given back before the answer is written, under a 2-minute write
  deadline, so a client that stops reading holds none. Same-site only
  (`crossSiteRejection`), GET only, both roles (the view-only client already reads the
  conversation's text); the reply has `nosniff`, a `sandbox; default-src 'none'` CSP and
  `Cache-Control: private`. OpenCode (`server/agent_opencode_image.go`): the reference names the
  session, the message (`ocm:<id>`, the id checked as `msg_…`) and the file's place in it, and is
  given only to a file whose `source.type` is `inline` (another kind keeps its chip, no
  reference). The image is read again through the service (`GET
  /api/session/{id}/message/{msg}`, 72 MB at most, two such reads at once, the slot given back
  before the answer is written as above; the service answers 404 for a message of
  another session), never from a file, and only for the pane's own session or a session the
  history of the pane's directory lists (`findHistorySession`, after `historyRoot`, so a
  view-only client is refused a root Files refuses it); any other session is never asked for.
  The file must be that message's, `inline`, of an `image/*` type, its base64 at most 10 MB
  decoded, and its bytes sniff as an accepted type and as that type; anything else, and every
  service error, is 404 `not_found`.
  Markdown images in the Chat view never load (shown as links), and raw HTML is not rendered;
  its code blocks and Mermaid diagrams use the preview's (see Mermaid diagrams in [`files-read.md`](files-read.md)). A file path in
  it (a file tool card's input, inline code naming a file, a relative link) opens on a click
  only in the pane's Files view, through the files routes like any other open; a path outside
  the pane's root, or one whose `..` leaves it, is never requested, and none is a link
  without `caps.files`. A relative path starts from the pane's directory: `files/tree` names it
  (`dir`, relative to the root, only when under it), and a view-only client gets `dir` only when
  its tracked list holds that directory.
  A tool call carries `detail` for its card: the model's description, a Bash/Codex command whole
  (8 KiB) and an Edit/MultiEdit/Write's old and new text (16 KiB per call); the edits of a file
  `isSensitive` names are left out (`hidden`), as its diff is in Changes. A Claude Code tool result
  carries `artifact` (`claudeArtifactRef`, `server/agent_claude.go`) only from its row's
  `toolUseResult` publish record (`updated` or `created_from_type`), in a row of one successful
  result, and only for a `url` matching `https://claude.ai/[code/]artifact/<id>` whole; the card
  draws it as a link (new tab, `noopener noreferrer`) only on an `Artifact` call and only for
  `https:` host `claude.ai`, so a forged record links nowhere else. A view-only client reads
  the transcript as text only (`viewTranscript`, `server/agent.go`, on a copy of the cached read
  every client shares): the user's and the agent's `text` and `thinking` parts and the `image`
  parts of images the user pasted, and of a compaction summary (Claude Code's quotes what tools
  read, which the terminal never shows) only `Context compacted`, as Codex writes it; never a `tool` part, so no tool's name,
  input, result or `detail`, whatever file, command or argument shape (an object, a JSON string, an
  array of paths, a symlink under an innocent name) it involves, and no result read apart from its
  call; no note either (the output of a command the user ran with `!`, of a slash command,
  a hook's text, an envelope Claude Code wraps whole in a tag termote does not know yet, and a
  Codex user message or block wrapped whole in a tag, as Codex writes a `!` command's output:
  `wholeEnvelope`; the command line the user typed is their words and stays), neither a `note` entry
  nor a text part classified as one beside the user's words in a row of several blocks (the part's
  `note` flag, never sent); an entry left with no
  part is dropped. Nothing is decided per file, so a new tool of an agent is covered as it appears.
  What the agent itself writes in its reply or its thinking about a file it read is its words, and
  a view client reads it (accepted, as the terminal), as it reads an open dialog's card
  (`agent/prompt`, read off the screen) and a running subagent's description and last tool name.
  A full client's transcript is unchanged. Over a machine (`/api/machines/<id>/mux/*`) the role
  goes with the request and the machine applies its own rule: a machine running a release from
  before this rule still gives a view client the tool results it did not mark sensitive (not
  covered).
  `agent/commands` (the composer's `/` suggestions; Codex: its skills, see Codex chat; OpenCode:
  its service's lists, see OpenCode chat) returns
  only names, descriptions, sources and kinds of `.claude/commands`/`.claude/skills` under the
  pane root and `commands`/`skills`
  in that config dir (for a view-only client the pane root's as Files shows them: nothing under a
  root with no repo or holding home, else only what git tracks; the narrowed list is cached apart),
  read through `os.Root` (first 8 KB per file; a file that is a symlink, under
  a denied dir or with a sensitive name is never read; every file and every dir listed is opened
  nonblocking, so a FIFO in its place never holds the cached walk), with the same
  `Sec-Fetch-Site`/`Origin` check as the files routes. A symlinked skill dir is followed only
  into that config dir, the pane root or `~/.agents/skills`. A plugin bundle in the config dir's
  `skills` (`server/agent_commands_bundles.go`: an entry, dir or link, holding
  `.claude-plugin/plugin.json` and no `SKILL.md`, as some kit installers lay it out)
  lists its `commands`/`skills` as `<manifest name>:<name>` (source `plugin`); the bundle, those two
  dirs and each skill dir in `skills` may be links into the dirs above or into a hidden dir right
  under the user's home (`~/.<kit>`, where a kit keeps its store; never `~/Documents` or another
  visible dir, whose `.md` first lines would otherwise reach a view-only client; none when home
  is a filesystem root), each opened as an `os.Root` of its own with the skip check made from
  every allowed dir and home. Only the manifest's `name` is read (a regular file of at most 1 MB,
  the `SameFile` check; a name with `:` or not a valid command name: no bundle). All bundles share
  one visit budget (5000 entries) and one cap (500 entries), at most 50 bundles; they come before
  the enabled plugins, so a bundle named like one shadows its entries (names only). Never in the
  pane root: a cloned repo cannot widen where links lead. Accepted gap, as for linked skill dirs: a
  path component swapped for a link between the containment check and `os.OpenRoot`. On Windows a directory junction
  (mount-point reparse point) there is followed like a symlinked skill dir, and every containment
  check here (allowed dirs, linked skill dirs, plugin base, `installPath`, `projectPath`) compares
  real paths from `GetFinalPathNameByHandle` (`resolveLinkedDir`; `filepath.EvalSymlinks` no longer
  resolves junctions since Go 1.23); other reparse tags are never followed, and a junction's own
  target must be a drive-letter path (not UNC, `\\?\`, `\\.\`, a volume GUID) before anything follows it.
  A resolved path not on a drive letter is refused, so an allowed dir on a UNC share or a mapped
  network drive (it resolves to UNC) no longer follows links into it. Accepted gap: a chain
  through a real symlink to a UNC path is opened by Windows before that refusal (an SMB
  connection, as the symlink path already did); creating such a symlink needs symlink privilege
  or Developer Mode. Plugin commands come from the
  plugins `installed_plugins.json` lists and `enabledPlugins` (user, project, local settings)
  turns on; an `installPath` is read only when it resolves inside `<config dir>/plugins/`
  (at most 50 plugins, JSON files capped at 1 MB)
- **Agent interrupt** (`POST /api/mux/panes/{id}/agent/interrupt` `{cursor}`,
  `server/agent_interrupt.go`): `requireMethod(POST)`, `requireWriteRole` before anything is read,
  a 1 KB body, refusals through `fail()`/`writeFailure` only (no OS or service text). The cursor
  must verify (`decodeCursor`, else `session_changed`), and its session must be the pane's, read
  again bypassing every cache (`sessionNow`); under the pane's lock (`lockPane`), Claude Code and
  Codex get exactly one `Escape`, and only when the pane is not in copy mode, the screen shows no
  dialog (`agent_blocked`: Escape is a dialog's cancel) and the agent works by its status or its
  screen (`agentWorking`, else 409 `agent_not_working`); Claude Code only while its screen also
  shows the working line (`claudeActivity` without `Background`), else 409 `agent_no_turn`: with its
  answer written and only background agents left ("Waiting for 1 background agent to finish",
  Claude Code 2.1.330) its session file stays busy and Escape stops nothing, so nothing is sent and
  the route never answers 204 for it; the session is read once more right before
  the key (`sameAgent`: same process, start time and session, else `session_changed`). A pane takes
  no second interrupt for 3 s (409 `interrupt_pending`, nothing sent: a second Escape opens Claude
  Code's rewind or Codex's backtrack); a key that failed does not count. OpenCode gets no key: the
  route calls its service's `POST /api/session/{id}/interrupt` (OpenCode 2.3.2), whose
  `interrupted: false` answers `agent_not_working`. It answers 204 once the key is sent, never
  waiting for the status; `agent_no_turn`'s message says the agent may only wait for background work
  or that this Claude Code version draws its working line differently, and the newest recorded
  screen of each state must parse (`TestClaudeActivityNewestScreens`), so a version that draws it
  otherwise fails a test rather than every Stop. The overview card and the Chat composer hide Stop
  while the pane only waits for background work (`background`), and `termote agents stop` follows
  the pane afterwards (exit 8 when it still works). Under `panes*`, it goes through the Machines proxy as every pane route.
- **Codex chat**: a rollout is read only when a process whose executable is named
  `codex`, without `app-server` in its argv, holds it open for writing as a regular
  `rollout-*-<uuid>.jsonl` inside its own `CODEX_HOME/sessions` (resolved), of a user thread;
  its dev:inode (Windows: volume serial and file index) is checked again after opening. When the
  process holds several (after `/new` or `/resume`), the one read is picked among those only
  (`pickCodexRollout`: the one file on a new fd or handle, then the latest write since the last
  lookup of that process, then the previous pick; no previous lookup, several new opens or a pick
  no longer held are refused until Codex writes again, never guessed, since a message sent from
  the view goes to the file picked). Herdr's session id is trusted only when such a process holds that rollout, and
  the rollout shown is then that same process's pick (the reported id when it refuses). A pane
  Herdr says runs Codex with no such id (none before the first message after `codex resume`) is
  looked up only through the process tree under that pane's own `shell_pid`, with the same checks,
  never among all processes (`paneCodexSession`). So only
  `codex --no-daemon` has a Chat view (the shared daemon writes every pane's rollout; on Windows
  0.162.0 runs it as a child of the first TUI, refused by its `app-server` argv). On Windows (#295; psmux, Herdr) the holder comes from the system handle table
  (`NtQuerySystemInformation`, one query cached 1 s, `server/agent_proc_handles_windows.go`):
  only File handles with write or append access (Codex opens its rollout append-only) of a
  `codex` process the server's user can open with `PROCESS_DUP_HANDLE` and whose token's user SID
  is the server's own (`isServerUser`, checked before any `DuplicateHandle`, as Linux relies on
  `/proc`'s owner check; another user's process under the pane is skipped even where an
  administrator's server could open it) are duplicated, with
  `FILE_READ_ATTRIBUTES` only, never read or written and always closed; only a disk file on a
  drive letter with an identity counts (no UNC path is ever stat'ed), never `NtQueryObject`; one
  kept must still allow writing in a table read after the duplicate (the cached one can be 1 s
  old; the kernel hides the object addresses that would tie the two), and a listing past 2 s
  gives nothing (logged once; no other starts while one is stuck). The argv comes from
  `NtQueryInformationProcess` (command line class) and `CODEX_HOME` from its PEB environment block
  under the same rules as `CLAUDE_CONFIG_DIR` above (else the server user's `%USERPROFILE%\.codex`),
  so another user's Codex has no Chat view, nor (expected, not checked live) an elevated one. `message` and `answer` write under the Claude Code rules: the
  pane lock (keyed by the pane address alone), then the process, session, rollout (path and
  dev:inode) and screen read again right before each write. A message is pasted (bracketed)
  only onto an empty composer with status idle/done/working (status working, or a working line
  above it right before the key, looked for above the queued messages, submits with Tab: queued
  for after the turn), and must show in the
  composer (`[Pasted Content N chars]` over 1000 characters) before Enter. psmux sends Chat
  messages: its `paste-buffer -b` finds no buffer (3.3.8), so `Paste` there types the bracketed
  paste (`ESC[200~` … `ESC[201~`, LF sent as CR) as hex bytes through `send-keys -H -t <exact
  target>`, in chunks of at most 4096 bytes cut at rune starts (`send-keys -l` turns a line break
  into the text `\n`); a chunk failing after the first, or the first cut short by the deadline,
  is followed by a best-effort end marker, never split across chunks. Accepted gap: unlike tmux's
  single paste-buffer write, psmux types the paste in up to 5 `send-keys` calls (about 0.2 s
  each), so stream input from another device can land inside it, and an agent exiting between
  chunks leaves the rest typed into the shell.
  The wait for the text to show after its paste is 2 s + 6 ms a character, at most 30 s, for
  Codex and for every agent on psmux (Claude Code on tmux and Herdr: 2 s), still polling. Past
  it, the poll goes on only while the box's draft changed within the last 2 s, up to 2 s + 20 ms
  a character (16 KB: about 330 s): a paste still arriving is waited for, the pane lock held, and a
  stalled one is refused 409 `paste_not_confirmed` as before (#410). The message route's budget
  and read deadline grow with that limit. An approval dialog
  (run a command, make edits) is answerable only on Herdr, where Herdr reports the agent
  blocked: the option goes as its digit, Cancel as Escape. On tmux the rollout records no
  approval request, so `prompt` answers `unsupported` with no options or `promptId`
  (`AgentSession.DialogsReadOnly`), as it does for any other Codex dialog. The screen reader
  (`server/agent_codex_prompt.go`) never takes text the model printed above the composer for a
  dialog, and reads a card as read only when two approval titles sit in its stretch. A list,
  picker or other dialog screen (`/model` and its effort step, a rate-limit or new-model prompt: a
  selected numbered `› N.` row, the options after it numbered on, and a footer of key hints like
  `enter select · esc back` or `enter/esc confirm · ^c quit` as the last row or two; herdr draws
  the row in colours, not reverse video) reads as a read-only dialog, never as a composer draft,
  so `/model` is confirmed submitted and a message onto an open dialog gets 409
  `input_not_ready`. A typed draft such as `1. foo` has the composer's hint rows under it, never
  such a footer, and stays a draft.
  `commands` (`server/agent_commands_codex.go`) lists skills only, suggested after `$` at the
  start of any word (`/` offers Codex 0.162.0's built-ins from the PWA's static list, `/exit` and
  `/logout` confirmed; a message ending with `$name` is sent with a trailing space, else Codex's
  own list takes the Enter), as Codex 0.164.0 loads them. The roots: `.codex/skills` and
  `.agents/skills` of the pane root and, when the root is a repo holding the pane's directory
  (`filesRoot.Dir`, settled with the root), of each dir down to it, at most 32, none at or below
  a `.git` or inside the repo's git dir, each opened through an `os.Root` of the root and refused
  when it resolves outside it (`project`; Codex's trust is not looked at, it does not gate
  skills); `CODEX_HOME/skills` and `~/.agents/skills` (`user`); `CODEX_HOME/skills/.system`
  (unless `[skills.bundled] enabled = false`) and `/etc/codex/skills` (`system`). A project dir
  that resolves to a user one is read once, as the user's. Each root is walked breadth first
  (`walkCodexSkills`, `server/agent_commands_codex_walk.go`): a `SKILL.md` regular file at most
  6 dirs down (the root's own too), hidden dirs and anything the files routes' skip refuses left
  out, a dir of more than 4096 entries skipped whole; at most 2000 dirs and 20000 entries per
  root (every project root sharing one budget, every plugin a budget of its own), 64 followed
  links per walk, 2000 skills per reply, and 2 s for the whole listing, which then returns what
  it read. A symlinked dir (a Windows junction too, with the Windows rules above) is followed,
  through an `os.Root` of its target, only into the dirs of its own scope (the pane root; the two
  user dirs; `/etc/codex/skills`; a plugin's dir), never into `CODEX_HOME/plugins` or
  `CODEX_HOME/skills/.system` nor to a target behind a hidden dir, never twice; the system root
  follows none. Only the first 8 KB of a `SKILL.md` is read (no file symlink, the `SameFile`
  check); a skill without Codex's front matter (`---` lines, a description) is left out. A plugin
  manifest above a skill (`.codex-plugin`/`.claude-plugin`/`.cursor-plugin/plugin.json`, a real
  dir and a regular file of at most 1 MB, through the same `os.Root`) names it `<plugin>:<skill>`;
  above the root, it is looked for no higher than the dir the root belongs to (the pane root,
  home, `CODEX_HOME`, `/etc/codex`). Plugin skills (`plugin`,
  `server/agent_commands_codex_plugins.go`): only the plugins `CODEX_HOME/config.toml` enables,
  every `openai-*` marketplace left out. `config.toml` is opened nonblocking, a regular file of
  at most 1 MB, a symlink allowed, decoded with `BurntSushi/toml` into plain values whose keys
  are matched exactly, as serde does (`Enabled` is not `enabled`); a file that does not decode,
  `[features] plugins = false` or a plugin entry of the wrong type → no plugin. Keys are checked
  as `validate_plugin_segment`; the install is a version dir under the resolved
  `CODEX_HOME/plugins/cache/<marketplace>/<name>` that is a real directory (no symlink, no
  junction), resolves inside the cache, and whose listing did not fill the 5000-entry visit
  budget shared by every plugin's listing; its manifest is read through an `os.Root` of it, never
  through a symlink (a symlinked manifest or manifest dir ends the search: no skill), with the
  skip, a 1 MB cap and the `SameFile` check, its keys matched exactly (a Legacy manifest naming a
  key twice is refused); manifest `skills` paths start with `./`, have no `..`, are not absolute
  and stay inside the plugin (sorted, deduplicated, at most 8); a Legacy plugin's are walked 6
  dirs down without nested manifests, an Agent Plugin's one level; at most 50 plugins. Names must
  be `[A-Za-z0-9_:-]`, at most 64 runes before the namespace and 129 with it. `[[skills.config]]`
  (at most 1000 entries, else none applies; any value of the wrong type → none applies) turns
  skills off by name or by `SKILL.md` path, before names are deduplicated; a rule's path is
  expanded (`~`, relative to `config.toml`'s dir), cleaned, and its links resolved only when it
  lies in a dir listed here, never opened. A skill named as a plugin's is left out. Nothing from
  `config.toml` or a manifest but these names and the skills' descriptions leaves the server,
  and their errors are not returned. Custom prompts (gone from Codex), the project's
  `.codex/config.toml`, profiles, `-c`, `project_root_markers` and `agents/openai.yaml` are not
  read
- **OpenCode service client** (`server/agent_opencode_client.go`): termote reads OpenCode 2.x
  only through the user's own background service, never `opencode.db`, the TUI's screen or the
  `opencode` CLI (`opencode api` and the TUI start the service when none runs; termote never
  starts one). Where it listens is read from `$XDG_STATE_HOME/opencode/service.json` of the server
  user (else `~/.local/state/opencode/service.json`), at most 64 KB; its `url` must be
  `http://<loopback IP>:<port>` with no user, path, query or fragment (a name such as `localhost`
  is refused, never resolved), else no request is made. The password goes only into the
  `Authorization: Basic opencode:<password>` header of requests to that address: never into argv,
  a log, an `audit:` line, an error or a reply. Before a byte is sent on a new connection, the
  socket at the other end must belong to the server's own user (`peerOwner`, the tables the
  local-user check reads; waits up to 100 ms for the service to accept), so a port another user
  took after the service died never gets the password; macOS cannot tell a socket's owner and
  skips this (accepted gap). The HTTP client follows no redirect and uses no proxy. The service
  counts only when `/api/info` answers with the pid and version the file names and a version of
  at least 2.0.0 (kept 30 s; a 401 or 403, or a connection to it that fails (refused, timed out
  dialing, or its port now another user's), drops it at once so a restarted service's new port and
  password are read; another HTTP error (a 404, a 5xx, a reply over its limit) keeps it; a failed
  check is repeated at most every 2 s). Every reply is read up to a limit (1 MB, a page of
  messages 24 MB, one message read alone for its images, or the Chat view's page of one message
  after a larger page was over 24 MB, 72 MB (five images of 10 MB as base64; at most two such
  page reads at once), the list of models 8 MB; every reply allowed over 1 MB, whatever asks for it,
  is read and decoded at most four at once, `opencodeLargeReads`, a read waiting for a slot giving up
  with its context before it sends anything) and decoded into the fields used (of
  `/api/model` only `providerID`, `id` and `limit.context`); the service's own text (its error bodies,
  `/api/info`'s hostname, `/api/model`'s provider settings with their API keys) never reaches a
  client or a log. The usage reads (see Agent usage and cost in [`agents.md`](agents.md)) and the files a session touched (see
  Files a session touched in [`agents.md`](agents.md)) go the same way. Writes (a message, a command, a permission or form reply, a form's cancel, a fork) go the same
  way, with the same header and checks, a JSON body termote builds itself and at most 15 s; their
  reply is drained up to 64 KB, never decoded or logged, except a fork's, read up to 1 MB for the
  new session's `id` only. Errors reach the client as `transcript not
  found`, `no agent session`, or for a write a code only (`agent_unavailable` 502,
  `input_not_ready`, `prompt_expired`, `invalid_choice`); the service's error is logged without
  its body.
- **OpenCode chat**: the session of a pane is the `--session`/`-s` id of the OpenCode TUI process
  found under the pane's shell (executable named `opencode`, argv not a subcommand, not
  `--standalone` or `--server`), or on Herdr the id Herdr's OpenCode integration reported for the
  pane, else that TUI's `--session` found under the pane's shell through `pane.process_info` (as
  for Codex; a TUI termote starts or resumes always has one); never one a client names. The id must match `^ses[A-Za-z0-9_]{1,64}$` and goes into a
  service URL path only after that check; message, permission and form ids are kept only when
  they match `msg_`/`per_`/`frm_` plus up to 64 alphanumerics (a message id `_` too: a fork's copies end in `_<n>`), and a pending request only when its
  `sessionID` is the pane's session. A TUI without such an id, or with no usable service, is
  shown as OpenCode with status `unknown` and every `agent/*` route answers 404. The status comes
  from one shared `/api/session/active` read and the session's pending permissions and forms
  (500 ms caches). Only settled messages are sent (an open answer, compaction or `!` command is
  held until an `idle` message follows it), since the client appends rows; a page over 24 MB is
  asked again with fewer messages, down to one message, read up to 72 MB; a cursor read then asks
  the older pages with as few, at most 175 messages in 16 requests, and for 30 s starts that
  session's next cursor reads with one message. A read has 4 s in all. A turn that did not succeed is a note (`Interrupted`, or `Turn
  failed` with the error's `message` on one line, at most 200 bytes); the provider's raw response
  body in that error is never read. Cursors are the signed `agentCursor`: a forward one names the last message sent
  (`oc:`), a before one carries the service's own page cursor (`ocb:`, at most 1 KB), so a client
  never makes the server pass its own words to the service; a cursor of another session starts
  over. A view-only client gets `viewTranscript` as for Claude Code (no tool call, no note,
  compaction summaries as `Context compacted`, and no text of a user message: OpenCode stores a
  custom command's expanded template, with the output of every `` !`cmd` `` it ran, as the user's
  text and marks nothing, so a view-only client sees only a user message's image chips). Writes never send a key to the pane: `message` is
  `POST /api/session/{id}/prompt` with `delivery: "queue"` (OpenCode's default `steer` would put it
  into the running turn; 202 while the session works or waits on a dialog), to the session read
  again right before the write (`sessionNow`, no cache), and only when it is the session of the
  client's signed cursor (else 409 `session_changed`); a session not yet made (a `--session` id
  before the TUI's first message) is 409 `input_not_ready`. Its images are only the server's own
  uploads (`imagePaths`, an id, never a path), read up to 10 MB each and sent inline as `data:`
  URIs of the type their extension names; the text goes without them, the white space where each
  was made one space (a line break or a blank line when it held them), and a `/name` before the
  first image is read from that same text (a message of images only, with empty text, is taken by
  OpenCode 2.3.0). A message whose text before any image starts with `/name` reads the session's
  directory (`GET /api/session/{id}`) and `command.list` for it again right before the write (no
  cache), and is `POST /api/session/{id}/command` (`name`, the rest of the message as `text`,
  `delivery: "queue"`, its images) only when that list holds the name; any other `/name`, and a
  listed one the service then answers 404 for, is a prompt with the message as its text. Each
  `@name` word (at the start or after a space) whose id is in `skill.list`, read the same way,
  attaches that skill by id (`skills: [{id, mention}]`, each once, at most 16); OpenCode reads the
  skill's file itself. A command list that cannot be read (a 404 included) is 502
  `agent_unavailable` with nothing sent; a skill list that cannot be read attaches no skill and the
  message still goes (`@` also names people, files and addresses). Spaces around `/name` and
  `@name` include Unicode ones, as the PWA reads them.
  `agent/commands` for an OpenCode pane is those two lists for the session's directory (500 each at
  most, 5 s cache per session, no file opened): names checked as Claude Code's, descriptions on one
  line cut to 200 runes, and for a skill a source from its `path` (`system` for `skill://`,
  `project` under the session's directory, else `user`). `skill.list` carries each skill's whole
  file (`content`, up to 16 MB in all): it is not a decoded field, and neither it nor a `path`
  reaches a client or a log. A view-only client gets an empty list without the service being asked;
  a session not made yet, or a list that fails, is an empty list too. The `prompt` card is the first pending permission
  (title `Allow <action>?`, its resources as the body, cut to 4 KB, the options once, always (with
  the patterns it saves) and reject; `action`, the permission's action cut to 1 KB, lets the PWA
  word the title and options in its language and is shown with `visibleUnsafe`) or else the first form; a view-only client gets it as `viewCard`
  makes it (no `promptId`, body or options; a form's fields by title only). A form's card carries its fields (string, number, integer, boolean, multiselect; a
  hidden one is left out, OpenCode fills it); one with a link to open (`external`), a field of
  another kind, a key with a control character or `__proto__`, an option value no answer could
  send back (over 1 KB or with a control character), a condition (`when`) on a field the card
  leaves out, over 32 fields or 64 options is `unsupported` (answered in the terminal); a default
  no answer could send back is dropped. Every title, label and description on the card is cut to
  1 KB and shown with `visibleUnsafe`. `answer` takes the single-use `promptId` as for Claude Code, re-reads the pane's
  session (another one: 409 `target_changed`), then the session's own pending list: a request no
  longer in it (answered in the terminal, or of another session) is 409 `prompt_expired` with no
  reply sent. A permission takes an option's number (`"cancel"` rejects it); a form takes
  `{"answer": {...}}` (`"cancel"` deletes it), each value checked against its field before
  anything is sent: a field of the card (none other, no hidden one), of its type (never `null`; an integer
  whole, numbers finite and within the field's bounds, a multiselect a list within its item
  bounds), an option unless the field takes other text, and every string at most 1 KB with no
  control character (`invalid_text`, `text_too_long`); a required field without its conditions
  (`when`) must be there. The answer's body is at most 64 KB. An answer OpenCode refuses (400) is 400
  `invalid_choice`, and its `promptId` is made usable again (nothing was taken) unless a poll
  meanwhile issued another id for the same request; OpenCode's 404 or 409 is `prompt_expired`. A
  message OpenCode refuses (400) is 400 `invalid_request`. While a turn runs the working line is the time since the session's
  `time.busy`, `thinking` when the open answer ends in reasoning, and the provider error OpenCode
  retries after: the attempt and the error's `message` on one line, at most 80 bytes, never its
  response body.
