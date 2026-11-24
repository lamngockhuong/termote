# Security invariants: Mux backends and panes

Part of the [security invariants](README.md): tmux, psmux, Herdr, Zellij and herdr-core, panes, groups and worktrees.

- **Herdr guard**: `--mux herdr --no-auth` is refused unless `--allow-herdr-no-auth` is also
  given, since Herdr exposes every workspace on the host
- **Herdr autostart** (`server/herdr_autostart*.go`; the only place serve starts `herdr`): `GET
  /api/mux/snapshot` of a full client (not a view-only device, not `peek=1`) starts `herdr server`
  when nothing listens on Herdr's socket (Unix: `ENOENT` or `ECONNREFUSED`; Windows: pipe not
  found). Never from the stream route, `viewSnapshot`, `peekSnapshot`, the event subscription or a
  write route, never in a container (the entrypoint starts Herdr with a config dir serve does not
  know), and no flag turns it off. The request answers its old error at once; the start runs
  in the background, one at a time. argv is `[herdr|herdr.exe resolved through PATH, "server"]`,
  never a shell; Windows runs only an `.exe`, and a match through `.` in `PATH` (`exec.ErrDot`) is
  refused. Env is `terminalEnv()` (no `TERMOTE_*`) without any `HERDR_*` variable, plus
  `HERDR_SOCKET_PATH` = the socket serve dials. A Windows pipe served by another user, or on Linux
  and macOS a Unix socket whose peer (`SO_PEERCRED`, `LOCAL_PEERCRED`) is neither this user nor
  root (`dialHerdr`, as `HERDR_SOCKET_PATH` in a shared directory could let another user make it
  first), is never treated as missing: it writes an `audit: herdr pipe refused` line (once per reason) and never
  starts Herdr. Not
  within `herdrStartGrace` (15 s) after serve starts; a failed start (not started, no ping within
  `herdrStartWait` (10 s), exited before answering, exited within `herdrStableAfter` (1 min) after
  answering) backs the next one off 30 s, doubling to 10 minutes, reset by an answer only once the
  Herdr termote started has run `herdrStableAfter`; a Herdr that never answers is killed before the
  backoff, so tries never pile up; a Herdr that exits because another took the socket is not a
  failure. If `<herdr config dir>/session.json` existed before the start, snapshots answer
  "starting" until a workspace is back or `herdrStartWait` passes; the server creates no
  workspace. The process is detached (Unix `Setsid`; Windows `CREATE_NO_WINDOW |
  CREATE_NEW_PROCESS_GROUP`, first with `CREATE_BREAKAWAY_FROM_JOB`, again without it on
  `ERROR_ACCESS_DENIED`), so it outlives `stop`, `restart` and `update`. Its output goes to
  `<stateDir>/herdr-autostart.log` (0600; on Windows opened with `FILE_SHARE_DELETE`, so `logs clean`
  and `uninstall --purge` delete it while Herdr runs; a log that cannot be opened discards the output,
  Herdr still starts); errors are logged only, never returned. Windows flags are
  not yet verified on a real machine
- **Zellij sessions** (`server/mux_zellij*.go`, `server/zellij_*.go`; Zellij 0.45 or later,
  `newMux` and `start` check it; Linux and macOS natively, refused on Windows by `start`/`restart`
  and `newMux`, never by the shared `validateMux`, so `container up --mux zellij` works on any
  host): every running session of the server's user is a group (as tmux; no extra no-auth guard).
  Before every `zellij` command (listing, action, `attach`, `subscribe`) the socket dir
  (`ZELLIJ_SOCKET_DIR`, else `$XDG_RUNTIME_DIR/zellij` on Linux, else `$TMPDIR/zellij-<uid>`) is
  checked (`zellijCheckSocketDir`): made 0700 when missing, it must be a directory (not a
  symlink) of the server's uid that others cannot write; its group write (Zellij makes
  `$XDG_RUNTIME_DIR/zellij` 0775 under umask 002; `$TMPDIR/zellij-<uid>`, the socket dir on macOS,
  it sets to 0700 each time it runs) is then taken away (`zellijOwnSocketDir`: checked and changed through one
  descriptor opened with `O_NOFOLLOW`, then stat'ed again through it: a mount that takes the
  chmod but keeps the mode, some FUSE, SMB or vfat, is refused; logged), so another member of its
  group cannot swap the contract dir after the check; and its `contract_version_1`, where the
  sockets are, when there, must be one of that uid with no group or other access (Zellij makes it
  0700); else no command runs, 503 `zellij_socket_dir`, the reason logged once. Zellij 0.45 makes
  the socket dir only when it is missing and never loosens an existing one (it sets the contract
  dir and `$TMPDIR/zellij-<uid>` to 0700); a dir removed and made again by Zellij is caught by the
  check before the next command.
  Every `zellij` call is argv only, never a shell; a positional value goes after `--` (`attach`
  takes none: there `--` starts a command, so a session name is passed only when
  `zellijPassableName` holds: no leading `-`, not `help`/`options` in any case, no control or
  format character, no `/`, not `.` or `..`, no longer than sun_path (108 Linux, 104 macOS) less
  the socket dir; the same for a name decoded from a client's id, else 400); names Termote
  creates or renames also refuse a trailing `;` (400 `invalid_name`); tab names
  refuse control and format characters (Zellij stores them verbatim). Ids: group `z` +
  base64url(name), tab `<gid>:t<id>`, pane `<gid>:p<N>` (`terminal_N`), `Tab.key`
  `<gid>/terminal_<first N seen>`, kept while the tab id lives (Zellij reuses tab ids). Zellij
  0.45 gives a CLI call the lowest free client id and removes it twice when the call exits, so
  a call or client connecting in between is dropped: every call holds `zellijGate`'s read side,
  a client attaching holds the write side from 150 ms before it starts until it has drawn 1 KiB,
  and Termote's actions on one session run one at a time (two at once can swap outputs), under
  a per-session lock taken only for a session the last `list-sessions` showed running, else
  after one more listing finds it (a session nobody runs: no action, no retry, no lock kept; a
  session `attach -b` just started is waited for, up to 6 listings);
  listings are retried (empty, failed, or not the listing's shape: tabs need `tab_id`/`position`,
  panes `id`/`is_plugin`/`tab_id`) and never answered empty; `Capture` (the screen an agent write
  is checked against) is read twice and must match;
  repeatable actions are retried (`zellijRepeat`), others checked by listing (new tab, move,
  rename and delete session). Typed keys, pastes and Chat messages go only through a Termote
  client's PTY (the stream's, else a hidden one kept 5 s), never argv (`write-chars`, `paste`,
  `send-keys`, `write` are never run, a test checks). A client is placed on its pane (Zellij has
  no per-client CLI target; an action runs as the client that last sent a key): under the
  session's slot, the kitty key Ctrl+Alt+Shift+Pause (`ESC[57362;8u`, unbound, written to no pane
  outside kitty keyboard mode) into its PTY, then `focus-pane-id`; every other client is
  checked on every try, success included, and one moved by a user's key in that window is moved
  back and the try repeated (5, then 503 `busy`); then the no-op key again and at once
  `switch-mode locked` (only that client: the PWA's Ctrl combos reach the pane; the user's own
  locked-mode bindings still act). Dropped clients, empty listings and a session gone mid-write
  answer 503 `busy`. A stream whose client left its pane is
  closed at the next snapshot. The view role runs `subscribe --pane-id terminal_N --ansi -f json`
  (lines ≤ 1 MiB, rows ≤ 64 KiB, size from `list-panes` sent before renders at it; decoding that
  stops early kills it, an exit without `pane_closed` is code -1), never a
  client, and a view-only client's snapshot only peeks (`main` is made only for a full one).
  `SelectTab` and `MoveGroup` are `errUnsupported`, `Caps.Scroll` false (the viewport is shared
  by every client). New tabs need an attached client (409 `no_client`, upstream #5594); sessions
  of another `contract_version_*` running → 503 `zellij_version_mismatch` before creating.
  Closing a session runs `delete-session --force` (no resurrection entry). Children lose
  `ZELLIJ`, `ZELLIJ_SESSION_NAME`, `ZELLIJ_PANE_ID` (`terminalEnv`); `ZELLIJ_SOCKET_DIR` stays,
  and `serviceEnv` passes it with `XDG_RUNTIME_DIR` (and `TMPDIR` on macOS). A `TERMOTE_*`
  variable in a Zellij server's environment is logged at start (it cannot be unset). The Chat
  view finds a pane's shell only among the children of the one same-uid `zellij --server`
  holding the session socket (Linux: `sock_diag` `UNIX_DIAG_VFS` matches the socket file's
  inode, so a rename keeps it; macOS: `lsof -U` by the bound path, so a renamed session is not
  found) with exactly one `ZELLIJ_PANE_ID=<N>`, failing closed; the pane command is cut to its
  first word. The reaper matches only `zellij attach <name> options --show-startup-tips false
  --show-release-notes false` and the exact `subscribe` argv. New sessions get their floating
  plugin panes (setup wizard, release notes, tips) closed for 1.2 s after `attach -b`.
  Pane layout (`server/mux_zellij_layout.go`, Zellij 0.45.1 or later, the version checked; else
  501): each action runs once, never through `zellijRepeat`, on the `terminal_N` the listing
  confirmed. Zoom and swap read the pane and act under the session's slot, so no client
  positioning runs in between (its `focus-pane-id` onto another pane of a zoomed tab ends the
  zoom, and `move-pane` in a zoomed tab moves nothing). A client Termote attaches to a zoomed
  pane can land on another pane of the tab, which ends the zoom: once it is placed, a tab listed
  with no fullscreen pane left gets `toggle-fullscreen --pane-id` on that pane again (a failure is
  logged only). Zoom is `toggle-fullscreen --pane-id` only when the listing's `is_fullscreen`
  differs (another fullscreen pane of the tab put back first), checked again after for up to 1 s,
  as the listing can lag the toggle (503 `busy` otherwise, never toggled twice); Zellij moves every client of the tab onto that pane. Swap is `move-pane` (next) or
  `move-pane-backwards` (prev) `--pane-id`: it turns the panes around on screen, the strip keeps
  its id order, and it wraps (never 409). Resize is `resize increase <dir> --pane-id`, one round
  per 5 cells asked, at most 5, under the session's slot. Split has no pane target: under the
  slot, the session's hidden client is positioned on the pane as for a write, the no-op key goes
  to it and `new-pane --direction right|down` follows at once; the clients are listed before and
  after, any other moved is put back (else 503 `busy`), and exactly one new terminal pane in the
  pane's tab must be listed, else every new one is closed (`close-pane --pane-id`) and the split
  is 503 `busy`. Zellij 0.45.1 ignores `new-pane --cwd`, so the new pane starts in the pane's
  directory and another `cwd` is 501. A failed action with the pane gone is 404 `unknown_pane`
- **herdr-core** (`--mux hc`; `server/hc_*.go`, `server/mux_hc*.go`; hc 0.1.16 or later,
  protocol generation 1): termote is one more client of the core herdr-app talks to. **hc has no
  auth of its own**: whoever reaches its socket or pipe drives every terminal, so the trust
  boundary is this machine's user. `--mux hc --no-auth` is refused unless `--allow-hc-no-auth` is
  given (`validateMux`), and serve refuses `TERMOTE_NO_AUTH=true` with `TERMOTE_MUX=hc` without
  `TERMOTE_HC_ALLOW_NO_AUTH=true` (`validateConfig`); herdr's flag never allows hc, nor hc's herdr.
  A container never runs it: `container up --mux hc` is refused before anything starts, and
  `newMux` refuses hc when `runningInContainer()`. Remote machines' terminals (`m/t7`) are out of
  scope.
  - Connection: one `hc connect` child (argv `[<absolute hc path> connect]`, never a shell) in
    framed mode; every RPC, the events and each attach share it on credit-counted channels. The
    path is found by `start` through `PATH` (absolute only, so never a match through `.`), checked
    with `hc --version` against `hcMinVersion`, and saved in the config (`TERMOTE_HC_BIN`, Windows
    `HcBin`); `hello` with another generation or an older version refuses the backend. Its
    environment is `terminalEnv()` (no `TERMOTE_*`) without any `HC_*` variable (a pane's
    `HC_TERMINAL_ID` would make termote that terminal's caller), plus `HC_SESSION` and
    `HC_SOCKET` as saved in the config by `start` from its shell (`TERMOTE_HC_SESSION`,
    `TERMOTE_HC_SOCKET`; a shell without one keeps the saved value), never the service's own
    while a saved config exists. Only `serve` with no config file (`newServeConfigFromEnv`, a
    manual run or a test) takes `HC_SESSION` and `HC_SOCKET` from its own environment.
  - Typed allowlist: the params types are the only calls (`server.status`, `terminal.list`,
    `get`, `run`, `kill`, `label`, `read`, `attach`, `events.subscribe`, `doc.get`, `doc.set`; a
    test checks). No `terminal.on`, `send`, `keys`, `rm`. `doc.get` and `doc.set` name only the
    `herdr-app` document of this machine (no `on`). `doc.set` (`server/mux_hc_doc.go`) changes
    only a space's or a tab's `name` (`validHcName`: what the group routes accept, no control or
    format character) or the order of `spaces` or of one space's `tabs`: the document is read
    with `doc.get`, must parse within the snapshot's depth and node limits (else 409 `no_layout`,
    nothing written; an unwritten one too), is edited as generic JSON (numbers kept as read, every
    field termote does not know written back unchanged), and is written over the version read
    (`hcCheck`: a JSON object of at most 1 MiB, version above 0). A `conflict` (herdr-app wrote in
    between) reads and changes again, at most 3 times, then 503 `layout_busy`; an edit that
    changes nothing (the same name, a move to the place it holds) writes nothing. A list with an
    empty or repeated id is not moved (409 `no_layout`). The core's own text is only logged. `terminal.run` sends only `keep`, `cwd` (absolute) and the labels `herdr.space`,
    `herdr.tab` (checked: non-empty, bounded, no control or format character) and
    `herdr.seen=0`; never argv or env, so the core runs the machine's own shell. `terminal.label`
    writes only `herdr.seen` (below).
  - Addresses: every call naming a terminal takes a local id (`t` + id characters, at most 16;
    `validHcAddress`), checked in the params (`hcCheck`) before anything is sent; a name or
    `m/t7` never reaches the core. Every pane route goes through `requirePane`: the id must be a
    live terminal of the snapshot with a `herdr.space` label (`hcShown`), so a terminal of another
    app (no label) cannot be attached, read, killed or labelled. One exception, on purpose: closing
    a pane, a tab or a space (`kill`, a full client only) also kills the live terminals each of its
    panes started that carry no `herdr.space` label, and theirs, 17 generations deep (`children`),
    as herdr-app does, so its sub-agents do not run on alone. They are found through the core's
    `parent` field, never through an id the client sent.
  - Autostart (the only place termote starts the core): `hc connect` starts a core that does not
    run (`connect_or_start`), so it is spawned only when the core answers, or for a full client's
    page snapshot (`startingSnapshot`), never for a peek, a view-only device, the stream,
    `/health` or the push watcher. "Runs" is `HC_SOCKET`, else the endpoint the core wrote in
    `<state>/herdr-core/<session>/core.lock`, else (Windows, where a running core's lock on byte 0
    keeps `core.lock` from being read) what hc itself dials: `socket` in herdr-core's
    `config.toml` (`hcConfigSocket`: a regular file of at most 64 KiB, opened without blocking, the key
    matched exactly, a file that does not decode ignored), else
    `\\.\pipe\herdr-core-<USERNAME's ASCII letters and digits>-<session>.sock` (`hcDefaultEndpoint`),
    accepting a connection, and a probe starts nothing. The endpoint counts only when this user
    serves it (`dialHerdr`, as for Herdr): a Windows pipe whose server runs as another user, or on
    Linux and macOS a Unix socket whose peer (`SO_PEERCRED`, `LOCAL_PEERCRED`) is neither this user
    nor root (`HC_SOCKET` or `socket` in `config.toml` in a shared directory, or the pipe name every
    user shares, made first by another user), is never treated as missing: `hcCoreRunning` returns
    the refusal, and `hc connect` is neither spawned nor started for it; the client gets 503
    `unavailable` (`errHcRefused`, no OS text) and serve writes an `audit: hc socket refused` line
    (once per reason). hc connect dials the endpoint itself, so once it answers its hello the probe
    runs again before the connection is used; a refusal then closes it (ending `hc connect`)
    before termote sends anything through it. Left open: an endpoint swapped between hc's own dial
    and that second probe so that the two land on different servers (a pipe instance of another
    user under the same name, or a socket file replaced in a directory both users write), since
    termote cannot see whom hc connect reached. The second probe finding no core at all (an
    endpoint that answered hc connect's hello, then stopped listening) is a refusal too
    (`errHcGoneAfterConnect`): the core hc connect reached must still answer there. A
    core that stops between the probe and the spawn is started by `hc connect`: an accepted gap.
    A failed start backs off like Herdr's. A core termote starts inherits the service's
    environment, and the terminals herdr-app opens later inherit it from the core;
    `termote stop` and `uninstall` never stop it.
  - Snapshot: built from the events stream and herdr-app's document (parsed with depth and node
    limits; one that does not parse falls back to the labels). Names, titles, folders and agent
    words are cleaned (`cleanPaneName`; an unknown app is `other`); argv and pids never reach a
    client. The pane's pid is used server side only, for the Chat view.
  - Streams: a full client attaches as a viewer that may type, at the terminal's size (typing
    never resizes the desktop's pane; only drive does); a view-only device attaches with
    `observe` (the core lets it neither type nor resize). Input waiting for an attach is held up
    to 1 MiB. Pane layout routes other than split and close answer `unsupported`.
  - Scroll (`Caps.AltScroll`, `server/mux_hc_ops.go`): `/scroll` (write guard, `requireWriteRole`,
    `lines` within ±10000) types only SGR wheel reports, at most 50 per call (`wheelReports`), at the
    middle of the pane's own size, or Claude Code's Ctrl+End for a full scroll down when the
    terminal reports Claude; never the client's bytes. It goes through the pane's input attach, as
    keys do. The PWA calls it only while its xterm.js shows the alternate screen of a program that
    asked for mouse reports, so a plain shell never gets them at its prompt.
  - `herdr.seen` (`server/mux_hc_seen.go`): the stream's `visible` frame, from a full client
    only (a view stream drops it, and the stream ignores it for an observer), counts a viewer per
    terminal. The label is written only for an agent terminal with a local id, only to raise it
    (or when missing), once per turn; a viewer back within 10 s writes only a turn that ended
    meanwhile. A failed write is logged, never returned, and never holds the stream.
  - Errors: the core's text is logged only; clients get `codedError` codes (503 `unavailable`
    while the core does not answer).
- **Pane processes** (`server/mux_process.go`): the snapshot carries each pane's foreground
  process `{name, cwd}`; tmux tabs also carry every pane's in `processes` (on psmux the snapshot
  holds only the window's active pane). The name is the first word of what the OS reports (cut at
  whitespace, `=` or `:`, then after the last `/`; a process can set its own title), at most 32
  bytes, control and format characters (zero-width, bidi) removed; argv and the environment never
  leave the server. tmux: one `list-panes -a`, read by `#{n:}` byte lengths keyed by session id and
  window index (a path can hold `\n` or `:`; psmux numbers panes per session), with `-u` on
  tmux. psmux expands no `#{n:}`: it gets `psmuxPaneFormat`, one pane a line,
  `<nonce>|#{session_id}|#{window_index}|#{pane_index}|#{pane_active}|#{pane_current_command}|#{pane_current_path}`,
  the nonce 16 hex digits from `crypto/rand`, new for each call (psmux copies text outside `#{}` as
  it is; hex holds no `%`, which would make psmux run strftime over the line). A line runs from the
  nonce to the next line break followed by the nonce, or to the end of the reply, so a line break in
  a path the pane announced (psmux percent-decodes OSC 7, `%0A` included) stays in that path and can
  never start a pane of its own: the pane could not know the nonce when it printed. A path holding a
  control character is dropped (the pane keeps its process name); a line not led by the nonce, of
  fewer than 6 fields or with a control character before the path stops the read, as a bad length
  does on tmux. Herdr: `pane.process_info`, decoding only pids and names (never `argv`, `argv0`,
  `cmdline`), through a 5 s cache with one refresher, 4 calls at once within 1.5 s, never under
  `fetchMu` and never into the cached view; a name whose reads failed for 15 s, or any while an
  `invalid_request` turned the calls off for 5 minutes, is not served. macOS names are the kernel's short name. The
  snapshot is a same-site read (`crossSiteRejection`, `Sec-Fetch-Site: none` included). The PWA
  shows names in the sessions list and pane strip and adds "Running: …" to the close
  confirmations, each with its hidden characters as `⟨U+XXXX⟩` (`visibleUnsafe`), since a process
  names itself; the cwd is not shown
- **Host stats** (`server/system*.go`, `GET /api/mux/system`, the PWA's Host chip and sheet,
  `termote status`): `requireMethod(GET)`, `crossSiteRejection`, no parameters, no role check: a
  view-only device reads it by design, as it holds only load and capacity figures (CPU and memory
  shares, load averages, byte counts, battery state) and names no pane, person or path. One sampler
  (`systemSampler`, started by `runServer` and stopped, waiting for a sample in progress, before the
  CLI socket's cleanup: a macOS sample forks `ps`, whose child holds that socket until it execs) reads the host every 5 s and
  keeps 180 points of CPU and memory in memory; requests answer from it and never read the host,
  except one read before the first sample. A disk is labelled with a fixed word (`home`, `windows`),
  never its path. A failed reading is `null` and its error is logged once until it works again, never
  sent. The only commands run are `ps -A -o %cpu=` and `pmset -g batt` on macOS, by argv with a 2 s
  timeout and `LC_ALL=C`; their output is parsed into numbers and never returned or logged. In a
  container the battery is never read (its `/sys` is the VM's); its memory limit is read from its own
  cgroup files (`/sys/fs/cgroup`, fixed paths, numbers only). `termote status` asks the route the
  way it asks health (local socket, else TCP to a trusted listener) and prints only parsed numbers.
- **Pane text** (`GET /api/mux/panes/{id}/text?lines=N` → `{text, lines, truncated, more}`,
  `server/mux_pane_text.go`, `caps.paneText`: tmux, never psmux, Herdr and Zellij): a same-site read
  (`crossSiteRejection`, `Sec-Fetch-Site: none` included, as the snapshot), `requireMethod(GET)`,
  then `requireWriteRole` (a view-only client gets 403 `view_only`: its role shows the screen,
  never the history; the PWA copies it from the xterm.js buffer). `lines` 1–5000, default 1000,
  else 400 `invalid_lines`, checked before the backend is called. tmux: `capture-pane -p -J -S
  -<lines> -t` the exact window target (no `-e`, so no escapes), a missing window → 400; psmux →
  501 `unsupported` (its targets never match exactly). Herdr: `pane.read` `{pane_id, source:
  recent_unwrapped, lines, format: text}` after `requirePane`, `invalid_request` (an older Herdr)
  → 501. Zellij: `dump-screen --pane-id terminal_<n> --full` after `requirePane`, wrapped rows
  joined, its last `lines` rows kept. `more` (history rows past `lines`: tmux `#{history_size}`, Herdr `pane.get`) offers Load
  more. The output is kept to its last 2 MiB while read (`tailBuffer`; Herdr's reply itself is
  bounded by `herdrMaxReply`), cut after a line break (`truncated`, then never `more`); control characters other than tab and line feed, CR and invalid UTF-8 are
  removed, trailing spaces and the blank rows at the bottom dropped; format characters (bidi,
  zero-width) stay, and the Select text sheet shows them as `⟨U+XXXX⟩` while copying the
  character itself. `Cache-Control: no-store`, `muxTimeout`, internal errors logged only. The
  history can hold secrets a program printed: the same a signed-in user saw on the stream
- **Pane layout** (`POST /api/mux/panes/{id}/split` `{direction, cwd?}` → `{ok, id}`, `zoom`
  `{mode}`, `swap` `{direction}`, `resize` `{direction, amount}` → `{ok}`;
  `server/mux_pane_layout.go`, `caps.paneLayout`: Herdr 0.9.3 or later and not on Windows, tmux
  (never psmux), Zellij 0.45.1 or later): auth, `hostGuard`, `writeGuard` (same-site JSON), 8 KB
  body, `requireWriteRole` first (a view-only client gets 403 `view_only`), then
  `requireMethod(POST)`, `muxTimeout`. Every argument is one of a few words, read before the
  backend is asked: `direction` `right|down` (split), `prev|next` (swap), `left|right|up|down`
  (resize), else 400 `invalid_direction`; `mode` `toggle|on|off`, else 400 `invalid_mode`;
  `amount` a whole number of cells 1–50 (1.5, 0, 51 or missing: 400 `invalid_amount`). A
  non-empty `cwd` goes through the groups' `resolveGroupCwd` (absolute or `~/…`, existing directory,
  symlinks resolved, the files deny list: 400 `invalid_cwd`/`not_found`, 409 `not_directory`, 403
  `not_allowed`, 503 `busy` when the directory does not answer in time); an empty one stays empty and the new pane starts in the pane's own directory
  (never the home a new group gets). It is no boundary: the shell can `cd` anywhere. A pane id
  that names no pane (or no longer does) is 404 `unknown_pane`, as on every `/api/mux/panes/{id}`
  route (an id of the wrong form is 400, and the stream keeps 400); a backend or version
  without the action, or an argument it cannot honour (Zellij's `cwd`), 501 `unsupported`; a swap
  past either end 409 `no_neighbor` (tmux, Herdr); a tmux window too small for another pane 409
  `no_room`; anything else is logged and answered 500. The snapshot's `tab.layout` (Herdr) carries
  numbers and pane ids only, sent to a view-only client like the rest of the snapshot. Herdr's
  layout view never drives a pane's size (no `drive`, no `control`), and picking a pane in it never
  calls `pane.focus`. Hiding the layout view from a view-only device is UI behaviour; the
  invariant stays 2 streams per view device and a view stream dropping input
  without the backend's text. No lock of their own and no cap on the number of panes, as new
  tabs. A split never moves the focus; a zoom may, for every client (tmux, Herdr, Zellij), and
  the commands each backend runs are in its entry (tmux panes, Zellij sessions; Herdr
  `pane.split` with `focus:false`, `pane.zoom`, `pane.swap` with the neighbour in the strip's
  order and its `reason` mapped, `pane.resize` with `amount` cells as a share of the tab from
  `pane.layout`)
- **Pane names and Herdr metadata** (`PATCH /api/mux/panes/{id}` `{name}` → `{ok}`,
  `server/mux_pane_name.go`, `caps.renamePane`: tmux 3.0 or later (the server's version, never
  psmux), Herdr 0.9.3 or later, Zellij 0.45.1 or later; `Pane.Name`, `Pane.Meta`, `Group.Meta` in
  the snapshot): auth, `hostGuard`, `writeGuard` (same-site JSON), 8 KB body, `requireWriteRole`
  first (403 `view_only`), `muxTimeout`; `DELETE` on the same path still closes the pane, any
  other method is 405 with `Allow: PATCH, DELETE`. `validPaneName` runs before the backend is
  asked: `""` clears the name, else at most 64 bytes of valid UTF-8 with no control or format
  character (`unicode.IsControl` or `Cf`: C0, C1, bidi, zero-width), no leading `-` and no
  trailing `;`, else 400 `invalid_name`. A pane that names no pane is 404 `unknown_pane`; a
  backend or version without names 501, nothing run; anything else is logged and answered 500.
  Herdr: `pane.rename` `{pane_id, label}` after `requirePane` (`label: null` clears),
  `*_not_found` 404, `unknown_method` or an `invalid_request` naming `` `pane. `` 501. tmux: the
  pane is read as `tmuxPaneRef` (`resolveTmuxPane`; a tab id names the window's active pane),
  then `set-option -p -t %N @termote-name <name>` (`-u` to clear) as argv. Without `-F`,
  `set-option` stores the value verbatim, so the name does not go through `tmuxLiteral` (which
  would double its `#`): an exception to the rule for names in tmux formats, as nothing expands
  it. `select-pane -T` is not used: what runs in the pane overwrites its title. `no such pane` is
  404. The names are read back with one `tmux -u list-panes -a -F
  '#{pane_id}:#{n:@termote-name}:#{@termote-name}'` per snapshot (only where names are offered),
  by the byte length `#{n:}` gives, never split into lines: any process on the server can set
  the option to a value holding `:` or a newline, and a forged entry stays inside the name;
  `-u` keeps the lengths right without a UTF-8 locale. A reply that cannot be read keeps the
  names before it; a failing one shows no names, never fails the snapshot. Zellij:
  `rename-pane --pane-id terminal_N -- <name>` or `undo-rename-pane --pane-id terminal_N`
  after `requirePane`; `list-panes -j` has no name field, so the server keeps the names it set
  in memory and shows one only while the pane's title still is that name (a program that sets a
  title read more than 2 s after the rename, a session rename or a restart of the server forgets
  it). Every name a backend reports (another process
  can set Herdr's label over its socket, or the tmux option) is `stripUnsafeRunes` and capped
  at 64 bytes (`cleanPaneName`). So is every tab and group name (tmux window and session, Herdr tab
  and workspace label, Zellij tab), which a pane's output can set through a terminal title, but
  not trimmed (`cleanLabel`). Metadata is read only, never written by termote: Herdr's
  `panes[].tokens` and `workspaces[].tokens`, which any process that reaches Herdr's socket
  can report, go through `cleanMeta`: keys outside `^[A-Za-z0-9_-]{1,32}$` dropped, values
  `stripUnsafeRunes`, trimmed, cut to 64 runes, empty ones dropped, at most 8 per pane or
  workspace, in key order. `workspace.metadata_updated` is subscribed only from Herdr 0.9.3
  (an older one refuses the whole subscription for a type it does not know); a pane's
  metadata and rename come as `pane.updated`. A view-only client gets the names but no
  metadata (`viewSnapshot` returns a copy through `withoutMeta`, never changing the backend's
  cached snapshot) and `caps.renamePane` false. The PWA shows names and tokens as text only
  (`visibleUnsafe`, never markup or a link); a token is a chip with a dashed border, unlike
  termote's own badges, titled "Reported by a Herdr plugin", three at most and `+N`. Existing
  limit, not addressed here: a token of several MB still makes `session.snapshot` exceed
  `herdrMaxReply` (16 MiB), which fails the read as before
- **Groups** (`POST /api/mux/groups` `{name, cwd}` → `{ok, id}`, `PATCH /api/mux/groups/{id}`
  `{name}`, `DELETE /api/mux/groups/{id}`; `server/mux_groups.go`, `caps.groups`): auth,
  `hostGuard`, `writeGuard` (same-site JSON), 8 KB body, `requireWriteRole` first (a view-only
  client gets 403 `view_only`), `muxTimeout`; creates, renames and closes run one at a time
  (one mutex), with no cap on the number of groups. Errors the handler or backend raises carry a
  `code` (`invalid_name`, `invalid_cwd`, `not_found`, `not_directory`, `not_allowed`, `busy`,
  `invalid_group_id`, 404 `unknown_group` also when the group vanishes between check and command,
  409 `exists`/`default_session`/`has_worktrees`, 501 `unsupported`), through the shared
  `codedError` (also the uploads' and `files/raw`'s); guard and JSON errors keep `{error}` without
  one. The name is 1–64 bytes, no control character, no trailing `;`; tmux also refuses `:` `.`
  `*` `?` `[` `\` (stored escaped) and a leading `=` or `-` in a new session's name. The `cwd` check is against
  mistakes, **not a security boundary** (the shell that opens can `cd` anywhere; signing in is
  the boundary): empty or `~` → the server user's home, `~/dir` (Windows also `~\dir`) → `dir` under it (`~user` is refused, no shell expands anything), otherwise absolute only, on Windows only `X:\…` (a UNC
  `\\host\share`, `\\?\` or `\\.\` would make the stat send the NTLM hash to that host),
  `EvalSymlinks` + `Stat` in a goroutine bounded by `muxTimeout` (a hung mount → 503 `busy`; a local symlink to a UNC path still reaches it, an accepted gap:
  only someone with the host can make one), and
  neither the path nor its resolved form under the files deny list (`files.deny`); the resolved
  path goes to the backend through argv/RPC, never a shell. tmux expands formats in
  `new-session -s`, `-c` and `rename-session`, running `#()` through `/bin/sh`: name and `cwd` go
  through `tmuxLiteral` (`#` doubled), and the new session's name and `session_path` are read back
  (anything else → `kill-session`, 500); psmux, unchecked, refuses `#` in both. A new session gets
  `terminalEnv()`, is checked to be free by exact name in `list-sessions`, and is addressed by its
  `$N` (`-P -F '#{session_id}'`); close and rename find it by exact id/name first. The default
  session cannot be renamed (409 `default_session`); closing it is allowed (the next snapshot
  makes it again, empty, and the PWA's confirmation says so). Herdr: `workspace.create`
  `{label, cwd, focus:false}`, `workspace.rename`, `workspace.close` without `close_group` (linked
  worktrees → 409 `has_worktrees`, closed in Herdr), `workspace_not_found` → 404 (Herdr answers a method it lacks with
  `invalid_request`, so an older Herdr gets a 500, not 501). A request that waited past
  `muxTimeout` for another group change gets 503 `busy`. hc: a new group takes no name (one sent
  is dropped; herdr-app names a space after its folder, and the PWA asks for none), it is a
  `terminal.run` with new space and tab labels, and it is recorded in the recent groups under its
  folder's name. Renaming writes the space's `name` into herdr-app's document (`doc.set`, above;
  `caps.renameGroup` only once a document is read, a space not in it → 404 `unknown_group`). A group created with a directory is
  recorded in the recent groups (below), after the mutex is released. Closing a group ends every process in it
- **Reordering** (`POST /api/mux/tabs/{id}/move` and `POST /api/mux/groups/{id}/move`, both
  `{index}` → `{ok, id}`; `server/mux_reorder.go`, `caps.reorderTabs`/`caps.reorderGroups`):
  `writeGuard` (same-site JSON), `requireWriteRole` first (a view-only
  client gets 403 `view_only`), `requireMethod(POST)`, the cap checked before the 8 KB body (501 `unsupported`, nothing
  sent). `index` is the final 0-based position (a tab among its group's tabs, a group among the
  movable ones), a JSON integer with `0 <= index < n`, else 400 `invalid_index` (also a list that
  changed under the move); the current place is 200 with nothing done. One slot for both routes
  (`reorderLockWait`, `muxTimeout`, then 503 `busy`); once held, the backend runs under
  `WithoutCancel` for `muxTimeout`. Malformed ids 400 `invalid_tab_id`/`invalid_group_id`,
  unknown 404 `unknown_tab`/`unknown_group`. Herdr (≥ 0.8.0 from `ping`, never on Windows until
  checked): the order is read after `invalidate()`; `tab.move` with `insert_index` (`index + 1`
  moving down; only the canonical `wN:tX` id, never Herdr's positional forms);
  `workspace.move_block` with the workspace plus every other one of its `repo_key` (as Herdr's
  drag sends it), before the movable workspace at `index`; a linked worktree → 409
  `linked_worktree`; `tab_not_found` → 404, `tab_move_failed`/`workspace_not_found` → 400
  `invalid_index`, `invalid_request` naming the method → 501, else 500 (Herdr's text logged,
  never returned). The snapshot keeps Herdr's tab order (`number` is a creation number); its group
  order lists a repository's linked worktrees after its checkout, so a move reads the view's order, never
  the snapshot's. hc (`caps.reorderTabs`/`reorderGroups` only once herdr-app's document is
  read): the snapshot gives which tabs or spaces show and checks `index`; the move is made on the
  order of herdr-app's `tabs` or `spaces` as read for the write (`doc.set`, above), so a move
  herdr-app made meanwhile is kept: the shown ones in their new order in the places they held,
  the others (a tab without a terminal) left where they are. One placed by labels alone (not in
  the document; the snapshot lists those last) → 404 `unknown_tab`/`unknown_group`, and an
  `index` among them lands last among the document's. The id never changes. tmux
  (the server's version from `display-message -p '#{version}'`, ≥ 3.2 for `-b`, cached once
  parsed, a failed read retried after 30 s; psmux never, its `move-window` ignores `-s`):
  `list-windows -t <session>`, one `move-window -b|-a -s <exact> -t <exact window at index>`,
  `-d` only for a window that is not current, then the window found again by `@N` and checked
  like `tmuxWindow.matches`; the answer is its new id. The ids of the shifted run change:
  `Tab.key` (tmux `@N`, Herdr the id) lets every device follow them (`pwa/src/utils/pane-remap.ts`:
  drafts, attachments, file edits, the Files/Changes stores and the page's last agent statuses
  move; transcript, prompt and command caches of a shifted id are dropped; rename form and close
  dialog follow the key), and the push watcher
  keys statuses by the pane's `%N`. `DELETE /tabs/{id}?key=` and `PATCH /tabs/{id}` `{name,
  key}` act on `@N` only while it sits at the id's index, else 409 `changed` (Herdr and hc: key ≠
  id → 409); without a key, as before. `CloseTab` has a second caller, job finish, which passes the
  key its snapshot read. Herdr's `confirmation_required` for `tab.close` (the last tab of a workspace
  with `ui.confirm_close` on; its API takes no confirmation) is 409 `tab_confirm_required`, the user
  closing it in Herdr; the other replies map as before (`herdrInputError`). hc renames a tab by writing its `name` into herdr-app's
  document (`doc.set`, above; `caps.renameTab` only once a document is read; a tab placed by its
  labels alone → 404 `unknown_tab`). Accepted gaps: deep links and saved selections to a shifted
  index open another tab; `send-keys` and the stream carry no key, so keys typed on another
  device within one poll of a move can reach the window that took the id
- **Worktrees** (`GET /api/mux/worktrees?groupId=` → `{repoName, worktrees, branches}`,
  `POST /api/mux/worktrees` `{groupId, branch, base, label}` → `{ok, id}`, `POST
  /api/mux/worktrees/open` `{groupId, branch}` → `{ok, id, alreadyOpen}`, `DELETE
  /api/mux/worktrees/{id}` `{force, path, branch}`; `server/mux_worktrees.go`, two
  implementations behind `worktreeMux`, picked by `worktreeMuxFor`). `caps.worktrees`: Herdr ≥
  0.9.2 from the `ping` version, on every OS; tmux and psmux, Zellij and hc through termote's own
  git (`gitWorktreeBackend`), on every OS they run on; any other backend 501 `unsupported`.
  Shared route rules: writes go through `writeGuard` (same-site JSON), `requireWriteRole` first (a
  view-only client gets 403 `view_only`), the 8 KB body; the GET through `crossSiteRejection` (so
  `Sec-Fetch-Site: none` too). Everything is checked before the slot: `branch` by
  `validBranchName` (git's `check-ref-format --branch` rules, 1–255 bytes, no leading `-`, not
  `HEAD` or `@`, and no Unicode control, format or space character, which git accepts and would
  let a name pose as another in the Remove confirmation), `base` empty (HEAD), `HEAD` or the same
  check (Herdr passes it to git positionally without `--`), a non-empty `label` by
  `validateTmuxTarget`. No path comes from the client. Creates, opens and removes take one slot (a
  one-slot channel, `worktreeSlot`, waited for at most `muxTimeout`, then 503 `busy`; `termote agents
  job finish` takes the same slot for its remove, see Finishing a job in agents.md); once held, the read deadline
  grows and the change runs under `WithoutCancel` for 60 s (open: `muxTimeout`), so a client
  leaving never cuts git short; past that 504 `unknown` (the change may still finish; the PWA
  treats its own 75 s abort the same). Create with a non-empty `base` first runs `git show-ref
  --verify refs/heads/<branch>` on the repository root the list names: an existing branch is
  checked out as it is, so that is 409 `branch_exists`. Every create (`createChecks`) then refuses
  with 409 `branch_clash` a name git would refuse as a folder of another local branch's or the other
  way round (`test` and `test/x`): `show-ref --verify` of each prefix and `for-each-ref --count=1
  refs/heads/<branch>/` (the name passed `validBranchName`, so it holds no pattern character), and
  Herdr's `worktree_create_failed` with git's `cannot lock ref ... exists; cannot create` maps to it
  too; a list or git failure there leaves the create to say what is wrong. The DELETE needs all three fields (400
  `invalid_request`; only a JSON `true` forces) and lists again under the slot: unless the entry
  whose group is the id is linked with that path and branch → 409 `changed` (`not_linked` for the
  repo's own). Codes: `unknown_group`, `not_found`, `not_git`, `linked_source`, `not_linked`,
  `ambiguous`, `create_failed`, `open_failed`, `dirty` (the PWA asks again, then sends `force`),
  `in_use` (409, git backend on Windows, below), `busy`, `unsupported`, else 500 `worktree_failed`; the backend's or git's message (git's stderr,
  with paths) is logged, never returned. The GET's `branches` come from the files routes'
  `gitRunner` (`for-each-ref --count=500`, heavy, no backoff, 160 KiB, the last line dropped when
  cut, names failing `validBranchName` dropped, `[]` when git refuses). A remove deletes ignored
  files too; the branch is kept.
  - _Herdr_ (`server/mux_herdr.go`): on Windows Herdr ends the panes before git runs even without
    `force`, and reports `dirty` itself. Herdr codes map to the list above (`unsupported` also for
    `invalid_request` naming a `worktree.` method). Herdr never gets `trust_repository`, `path`,
    `cwd` or `close_group`. Create and remove run git with the user's config (hooks, LFS
    filters), as typing the command would; with `force` (on Windows always) the panes end first.
    The snapshot's `worktree: {linked, branch?, parent?}` comes from `session.snapshot`'s
    membership (kept across a Herdr restart); the branch from a cache apart from the view
    (`herdr_worktree_branches.go`): served stale while one background `worktree.list` per
    repository refreshes it (10 s fresh, 1.5 s budget, 30 s kept after failures, 5 minutes off
    after `worktree_busy`/`invalid_request`), never filled by `peekSnapshot` (push watcher,
    `snapshot?peek=1`). The `worktree.*` event types are subscribed only when the gate holds (an
    older Herdr would refuse the subscription); an event or a change makes the branches stale.
    Closing a workspace with worktrees stays 409 `has_worktrees`.
  - _git, for tmux/psmux, Zellij and hc_ (`server/git_worktrees.go`, `server/git_worktree_mux.go`): a
    group's repository is the one its first pane (first tab) works in, resolved through the files
    routes' `rootResolver`; on Windows a folder off a drive letter outside a Place is never looked up
    (409 `not_git`), as the psmux paragraph below says. A new checkout's path is built by the server only:
    `<base>/<main checkout's base name>/<branchSlug(branch)>`, base fixed per backend
    (`worktreeBase`: hc `~/.herdr/worktrees`, tmux and Zellij `~/.termote/worktrees`, in the
    container under `/workspace`); refused (`create_failed`) when the repository name is not one
    clean path element, the target exists, or it (as given, or resolved for the part that exists)
    is under a files deny dir (on Windows a junction on the way is resolved too, `resolveLinkedDir`
    through an open handle: `filepath.EvalSymlinks` leaves one as it is), when a folder between the
    trust root and it is a symlink, a junction or not a plain directory (`checkWorktreeTarget`; the
    trust root is `/workspace` in the container, where the base is inside a repository the user did
    not write and one committed as a link would send the checkout to its target, and natively the
    base itself, which may be the user's own link), or when it leads into the repository's git
    directory or common dir (a checkout among its config and hooks); the folder made for the
    repository is the user's only (`makeWorktreeParent`: mode 0700, on Windows a protected
    owner-only DACL its checkouts inherit, `D:P(A;OICI;FA;;;<user SID>)`, since traverse checking
    is off there; no ACE for SYSTEM or Administrators; a folder whose ACL could not be set is
    removed again, never reused); the slug refuses, on Windows, one ending in `.` or naming a
    device (`deviceName`), and everywhere a name left empty, dots only or a git directory's name
    (`invalid_name`). On tmux and Zellij the new group's name (the label, else the slug) is checked
    with the backend's own name rule before `git worktree add` (`invalid_name`); hc ignores the label.
    The group opens through `resolveGroupCwd` with the same deny list. A create or open from a
    linked worktree is 409 `linked_source`. git runs only through the files routes' `gitRunner`
    (hooks, fsmonitor off; `GIT_*`/`TERMOTE_*` stripped; `safe.directory` from the resolver):
    `worktree list --porcelain -z` (newline form on a git without `-z`; output capped, a cut list
    is an error; an entry whose `.git` does not lead back to the repository is dropped, and on
    Windows one off a drive letter, so a UNC path is never resolved, as `validCwdForm`),
    `worktree add --no-checkout [-b]`, then `reset --hard --no-recurse-submodules` run in the new
    worktree, and `worktree remove --force` (`write`, `--` before the path, filters off, so Git LFS
    gives pointer files). The checkout runs in the worktree, never inside `worktree add`, and the
    remove always takes one `--force` (after the dirty check below, which also counts a submodule),
    so git never checks out or runs `status` in a child process: `gitRunner` lists the filters to
    turn off from the config read in its own root, and a filter the repository declares for its
    worktrees only (an `includeIf` on `gitdir:worktrees/`, a `config.worktree`) is listed only in
    the worktree. A failed checkout removes the new worktree again. `ls-files --stage -z` (the index only;
    a gitlink or a list cut at 16 MiB is `dirty`, as is an initialized submodule, `gitDir/modules`),
    then `status --porcelain -z --untracked-files=normal --ignore-submodules=all` (filters off, and
    never entering a submodule, whose own config can define filters `gitRunner` does not know of;
    any output or a cut one is `dirty`; on Windows, unless the user's or the repository's config
    sets `core.autocrlf`, status runs with `-c core.autocrlf=true`, as Git for Windows' system config,
    which `gitRunner` never reads, checked the worktree out (Herdr's or the user's own `git worktree
    add`): only a change of line endings reads as none, `windowsCheckoutEOL`), `show-ref
    --verify`, `symbolic-ref -q --short HEAD`, and `rev-parse --show-toplevel --absolute-git-dir`
    (the resolver). Remove re-derives the path from git's own list for the group's work tree,
    never from the body; the main checkout is `not_linked`; without `force` a dirty one is 409
    `dirty` and nothing changes (the check is termote's own, since git's is skipped by `--force`); a
    locked one is refused (500) before anything closes, and one `--force` still refuses a lock. Every group
    whose first pane works in that worktree (the remove may name any of them) is closed, its
    processes ended, before `git worktree remove`, so nothing runs in a deleted folder; a remove
    git refuses after that leaves the checkout and the groups closed. On Windows (psmux, hc) git
    deletes file by file and stops at the first one a process holds, the `.git` file usually gone
    by then, which leaves a checkout git no longer removes: so after the close termote waits up to
    10 s for the folder to be free (`waitWorktreeFree`: renaming it to a random sibling and back,
    which Windows refuses while a file in it is open or a process works there; the move back is
    retried for 30 s, past a scanner's look, and failing that the log names where the whole
    checkout was left), and answers 409 `in_use` with nothing deleted when it does not get free,
    with or without `force` (a permission error on the rename reads the same as a held file, and so
    does a request cancelled during the wait). The
    `dirty` check still runs before anything closes. Accepted gap: a program (a scanner, an
    editor) opening a file between the probe and git's delete still makes git stop halfway. The route's branch list and
    existing-branch check pass the resolver's `safe.directory` too. On tmux and Zellij a group name taken already is
    `open_failed` with the checkout kept. `RemoveWorktree` has a second caller, job finish, always
    without `force`; once a finish's remove failed after its workspace closed, a finish again removes
    the checkout with git alone (`removeUnopenedWorktree`: only a worktree git lists as linked and
    unlocked at the ledger's folder, made by the job, clean and pushed or merged), opening nothing.
    Nesting (`server/git_worktree_nest.go`): the snapshot
    route nests by a cache only; lookups run in the background (at most 4 at once, `muxTimeout`
    each, 10 s fresh, 30 s after a failure, 512 folders, cleared after every worktree change),
    started only by a full client's non-peek read; a view-only or peek read uses what is cached.
    A repository's key (its shared git dir) ignores case on Windows and macOS, as `underDir` does.
    hc's `MoveGroup` reads the same nested view: a linked worktree alone is 409
    `linked_worktree`. Closing a repository's group with linked worktrees open is not refused.
- **tmux sessions**: every session on the tmux server is a group, the user's own ones made
  outside Termote included, so anyone signed in sees, switches to and types into them (as Herdr
  exposes every workspace; accepted). `TMUX_SESSION` (default `main`; no `:`, `.`, leading `=`
  or `$`) keeps group id = its name and bare tab ids (`0`), so links, saved selections and E2E
  keep working; any other session is tmux's own session id: group `$3`, tab `$3:1`, which
  a rename keeps and a tmux server restart changes. A window name is never an id. A window
  index shifts with a move or `renumber-windows`, so each tab also carries `Tab.key`, tmux's
  window id `@N` (read in `tmuxListFormat` before the names; psmux keys a tab by its id until
  its window ids are checked to be unique on the server).
  Every command
  targets exactly: `$N:=i`, or `=<TMUX_SESSION>:=i` (each `=` turns off tmux's prefix and
  pattern matching, so `ma` never reaches `main` nor a missing index 9 a window named `9x`), and
  `new-window -t <session>:`; psmux (Windows, `tmuxIsPsmux`) has no `=` before an index and
  never matches a window name, so it gets `$N:i`/`=<TMUX_SESSION>:i`, `SelectTab` checks the
  window with `display-message` first (psmux's `select-window` exits 0 on a missing one), and
  the agent routes read and type into that window (`$N:i` from psmux's reply, so one window has
  one pane lock) instead of `%N` (psmux numbers panes per session, `-t %1` reaches the most
  recent one); the default session's existence is checked by exact
  name in the `list-windows -a` reply, and `ensureSession` uses `has-session -t =<name>`.
  `display-message` (agent routes, Files) asks for `#{session_id}`/`#{session_name}` with the
  window index and refuses a reply that is not the window asked for: tmux answers a missing
  target with another window or nothing. A stream runs `attach -E -t <$N|=name>`; the macOS
  reaper matches exactly that, plus `attach -t <TMUX_SESSION>` left by older releases, never a
  user's own `tmux attach`
- **tmux panes** (`server/mux_tmux.go`, `tmuxPaneRef`): every pane of a window is a pane, its
  id tmux's own `%N`, unique on the server and kept through a kill, swap or window move, so an
  old id reaches no other pane; psmux keeps one pane per window with the tab's id (its pane ids
  are per session). Every pane route and the stream also take a bare tab id (`0`, `$3:2`) for
  the window's active pane (`parseTmuxPaneID`; the stream, task runs and the overview through
  `findSnapshotPane`, only where tabs are selected on the server), so links, notifications and
  older clients keep working; the tab routes (`parseTmuxID`) never take `%N`. The panes come
  from one `list-panes -a` per snapshot, never cached (fields that cannot hold a `:`); a window
  with a line that cannot be read, or an index or id listed twice, keeps its active pane only,
  as every window does when the command fails (logged once a minute). Commands target `%N`
  exactly, and a reply naming another pane (tmux answers a missing `%N` with nothing, exit 0)
  or `can't find pane` is 404 `unknown_pane`. Picking a pane is `POST /tabs/{id}/select` with
  its `%N` (`select-window -t %N`, then `select-pane -t %N`): a write (`requireWriteRole`) that
  moves the focus every client of the session shares, so the PWA's pane strip only shows the
  panes to a view-only device, and the pane it shows follows that focus; opening a given pane
  (Overview, a task, a link) selects its `%N` the same way, refused as `view-only` to such a
  device. `DELETE /panes/{id}`
  reads the pane's `%N` and `#{window_panes}` with `display-message`, checks the reply, then
  runs `kill-pane -t %N`; a window's last pane is 409 `last_pane` (closing the tab is
  `CloseTab`); psmux 501. Accepted gap: a pane closed elsewhere between that check and the kill
  makes it close the window's last pane, which closes the window too. The layout actions
  (`layoutPane`, never on psmux: 501) read the pane the same way first, then target its `%N`
  only, argv through `tmuxCmd`: `split-window -d -h|-v -t %N -c <dir> -P -F '#{pane_id}'` (`-d`
  keeps the focus; without a cwd `<dir>` is the format `#{pane_current_path}`, which tmux
  expands, else the checked directory through `tmuxLiteral`, so tmux expands nothing in it; the
  reply must be a `%N`); `resize-pane -Z -t %N` once or twice from the reply's
  `#{window_zoomed_flag}` and `#{pane_active}` (zooming focuses the pane, for every client);
  `list-panes -t %N` for the order and the focused pane, `swap-pane -d -s %N -t <neighbour>`
  with the neighbour found there (tmux's own `-U`/`-D` wrap around: past either end is 409
  `no_neighbor`, nothing run), then `select-pane` back to the pane that had the focus;
  `resize-pane -t %N -L|-R|-U|-D <1..50>`. `can't find pane` from any of them is 404
  `unknown_pane`
- **Recent groups** (`GET /api/mux/recent-groups` → `{groups:[{id,name,cwd}], readOnly}`,
  `DELETE /api/mux/recent-groups/{id}`; `server/recent_group_store.go`,
  `server/recent_group_routes.go`, `caps.recentGroups`; PWA `group-dialog.tsx`): the groups created
  last with a directory, which the New group dialog fills in on a tap (the user still presses
  Create). Only the server writes the list: `POST /api/mux/groups` records `{name, cwd, real}`
  after the group was made and after it released the group mutex (the file lock never holds up
  another group change, and a panic in the backend still releases it); an empty `cwd` (home), a
  refused create, or an entry the reply would hide (below) records nothing, and a failed write is
  only logged. No route takes a path. `cwd` is the directory as typed (`filepath.Clean`),
  shown and filled in; `real` is it resolved by the create's own check, used to merge two
  spellings of one directory (`EqualFold` on Windows) and never sent to a client. One file
  `<stateDir>/recent-groups/recent-groups.json`, at most 20 entries, newest first (dir 0700
  through `checkPrivateDir`, file 0600 through `writeStateFile`, a symlinked file or dir refused,
  stale `.recent-groups-*.part` removed; `recent-groups.lock` around every write, 2 s then logged
  `busy`; a read never waits for it, its prune only takes a free lock). Unlike the templates these are suggestions: a file that
  cannot be read (corrupt JSON, no `v`, larger than 1 MiB) is renamed
  `recent-groups.json.bad-<unix ns>` under the lock and the list starts again, never written
  over; `v` is read first, and a `v` above 1 is read only (also when its list does not decode) (`record` and the prune skip it silently, `DELETE` 409
  `newer_format`, `readOnly` hides the remove buttons). An entry whose id is not 16 hex digits,
  whose name fails `validateTmuxTarget` or whose `cwd`/`real` fails `validCwdForm` is left out of
  the reply (kept in the file), so a hand-edited file shows no control character. Both routes are
  a full client's only (`requireWriteRole` first, before the method, 403 `view_only`; `caps.recentGroups` false for
  `view`, without a store or without `caps.groups`): the list names projects. `GET` also goes
  through `crossSiteRejection`; `DELETE` through `writeGuard`, no body, a bad or unknown id 404
  `unknown_recent`. `GET` never stats: each entry is checked as strings against the same
  `files.deny` slice the create uses (`underDirName` on `cwd` and `real`: case-folded on Windows
  and macOS, exact on Linux, where `underDir` would stat), a denied one is left out and pruned from
  the file when the lock is free; a directory gone since is listed and Create answers `not_found`, so a hung
  mount cannot hold the list up and on Windows no symlink is followed to a share outside a
  create. Without a store every route is 503 `recent_unavailable`. Not under
  `/api/mux/groups/`: `/api/mux/groups/recent/{id}` would clash with `/api/mux/groups/{id}/move`.
  Names and directories are shown through `visibleUnsafe`; a name an open group uses is filled in
  as `name-2`, `name-3`… Errors carry their code, anything else is a logged generic 500. Plain
  `uninstall` keeps the list and says where; `--purge` removes it with the state dir. Native and
  container keep separate lists
