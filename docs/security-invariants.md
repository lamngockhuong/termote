# Security invariants

What each server route, guard and CLI command must keep true, for maintainers changing them. Read the
entry of the code you touch before changing it, and update the entry in the same change. What this
protects for a user, and what it does not: [`security-model.md`](security-model.md). How the pieces fit:
[`system-architecture.md`](system-architecture.md).

- **Service reads the saved config, ignoring the environment**: when `~/.config/termote/config`
  exists, `termote serve` reads it and ignores every `TERMOTE_*` variable; only without a saved
  config (the container, a manual `go run`/`termote-dev serve`) do `TERMOTE_*` variables
  configure it. `serve` also strips every `TERMOTE_*` variable from its own environment, so no
  terminal it opens inherits one.
- Basic auth enabled by default (use `--no-auth` to disable for local dev); an empty saved
  password no longer disables auth — `start` generates and saves a new one instead
- **Logout** (`POST /api/mux/logout`, handled in `basicAuth`): a JSON write under `writeGuard`;
  removes the cookie's session from the store and expires the cookie (204), needs no
  credentials and counts as no failed login. The snapshot's `caps.auth` (set from the request
  `basicAuth` let through) tells the PWA to offer Log out. A cookie is never bound to a port:
  every service on the same host name receives it, so the docs tell users to give Termote a
  host name of its own (accepted risk; no `__Host-` prefix, which would not change that)
- Basic auth over HTTPS required for production
- **Sign-in form** (`/login`, `server/login.go`): a browser page load without a session gets
  a 401 with a plain HTML form (no script) and no `WWW-Authenticate`, since an iOS home-screen
  app never shows the Basic prompt and the prompt would otherwise sit on top of the form; only a
  client without `Sec-Fetch-Mode` (curl) is still challenged. The form POST must be urlencoded,
  at most 8 KB, not cross-site (`Sec-Fetch-Site`, or an `Origin` off the allowlist other than
  `null`, which the form itself sends under `no-referrer`), shares the Basic auth rate limiter and sets
  the same session cookie; `next` is kept only as a path on this server. The PWA opens `/login`
  when the snapshot or health read answers 401, and the service worker never serves its shell
  for `/login`
- termote binds to `127.0.0.1` by default; only `--lan` makes it listen on `0.0.0.0`
- **Host allowlist** (`hostGuard`): requests with an unrecognised `Host` header get a 403; the
  allowed set is loopback + (with `--lan`) the address the request arrived on, so it keeps
  working as the LAN IP changes + the Tailscale name + `--allow-host` entries, with no
  wildcard to disable the check
- **Write/CSRF guard** (`writeGuard`): state-changing `/api/mux/*` requests must be
  same-site (`Sec-Fetch-Site`/`Origin` on the allowlist) with `Content-Type: application/json`;
  only the paths `/api/mux/uploads` and `.../files/image` (`isFilesImagePath`, anchored, on the
  decoded path) take a raw `image/png|jpeg|gif|webp` body instead (their handlers take POST only),
  any other type there → 415 `unsupported_image`; and `.../files/upload` (`isFilesUploadPath`,
  anchored) without `check=1` takes a raw `application/octet-stream` body only, any other type
  there (a form's `multipart/form-data`, `text/plain` or urlencoded, which need no preflight) → 415
  `unsupported_type`
- **Terminal stream** (`/api/mux/stream`): same Origin check plus a single-use, 30s-TTL token
  fetched via `/api/mux/stream-token`, consumed on WebSocket upgrade. Every paste into the
  terminal (native paste events are taken in capture phase, ahead of xterm) goes through
  `cleanPaste` in `terminal-view.tsx`: end-of-paste markers and control characters other than
  tab and line breaks removed, since xterm brackets a paste without removing a marker inside it.
  The hub holds 16 streams server-wide on Herdr outside Windows (`maxStreamsFor`, its layout view
  streams up to 4 panes of a tab), 8 on every other backend (`maxStreams`); past it a full stream
  evicts the oldest view stream first, then the oldest stream (4001). A stream closed with 4001
  never reconnects by itself, a pane of the layout view included: that pane shows Reconnect in
  its own box, the layout stays, and no other stream opens (two devices never evict each other
  in a loop). The `{"type":"layout"}` frame carries nothing but its type
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
  `HERDR_SOCKET_PATH` = the socket serve dials. A Windows pipe served by another user is never
  treated as missing: it writes an `audit: herdr pipe refused` line (once per reason) and never
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
- **Pane processes** (`server/mux_process.go`): the snapshot carries each pane's foreground
  process `{name, cwd}`; tmux tabs also carry every pane's in `processes` (on psmux the snapshot
  holds only the window's active pane). The name is the first word of what the OS reports (cut at
  whitespace, `=` or `:`, then after the last `/`; a process can set its own title), at most 32
  bytes, control and format characters (zero-width, bidi) removed; argv and the environment never
  leave the server. tmux: one `list-panes -a`, read by `#{n:}` byte lengths keyed by session id and
  window index (a path can hold `\n` or `:`; psmux numbers panes per session), with `-u` on
  tmux. psmux expands no `#{n:}`: it gets `psmuxPaneFormat`, one pane a line,
  `#{session_id}|#{window_index}|#{pane_index}|#{pane_active}|#{pane_current_command}|#{pane_current_path}`
  (a Windows file name never holds `|`; a line without 6 fields or with a control character stops
  the read, as a bad length does on tmux). Herdr: `pane.process_info`, decoding only pids and names (never `argv`, `argv0`,
  `cmdline`), through a 5 s cache with one refresher, 4 calls at once within 1.5 s, never under
  `fetchMu` and never into the cached view; a name whose reads failed for 15 s, or any while an
  `invalid_request` turned the calls off for 5 minutes, is not served. macOS names are the kernel's short name. The
  snapshot is a same-site read (`crossSiteRejection`, `Sec-Fetch-Site: none` included). The PWA
  shows names in the sessions list and pane strip and adds "Running: …" to the close
  confirmations, each with its hidden characters as `⟨U+XXXX⟩` (`visibleUnsafe`), since a process
  names itself; the cwd is not shown
- **Agent activity** (`server/agent_activity.go`, `GET /api/mux/activity`): the tracker is fed
  only by snapshot reads that already run (the snapshot route, a stream attaching, the push
  watcher's tick); it never reads tmux, Herdr or Zellij itself and never runs a command, so
  `/activity` costs no mux call. Each read takes a generation number before it starts and a read
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
  read it; nothing from a transcript or a screen
- **Agent overview** (`server/agent_overview.go`, `GET /api/mux/overview`): `requireMethod(GET)`,
  `crossSiteRejection`, `requireAgentRead`; internal errors are logged only. It summarizes the
  panes with an agent in the activity tracker's last snapshot (64 at most) and never reads the
  panes itself: per pane only `AgentSession` and the transcript's tail, through the Chat view's
  read cache (`readCached`), 4 at a time within 3 s (late ones answer `unavailable:
  ["transcript"]`); the whole read is shared for 2 s. It returns ids, the last assistant text
  (280 runes, never a tool result, never a sidechain row), the last row's time, the context size,
  window and share (Claude: tokens and model; Codex: its `token_count` rows), and a branch and
  changed-file count; never a cwd, a root, a transcript path or a file name. The Claude window comes
  from the transcript's last model row (`claudeModels`: the same file `Locate` found, opened
  nonblocking, scanned forward from where the last scan ended, lines over 64 KiB skipped
  undecoded; only the model id is kept), else from the agent process's argv (`--model`),
  read with the process during the walk that finds it (`claudeProcOf`); only the window is kept,
  argv is never returned or logged. `accounts` are the
  Codex rate limits (`primary`/`secondary`, `plan_type`) of the `token_count` rows already read,
  keyed by an HMAC of the `CODEX_HOME` with the process-lifetime cursor key (`accountKey`, 12 hex),
  never the path; `limit_id`, `credits` and the rest are not sent. No file beyond the transcript is
  read for any of it, and nothing is written. `?pane=<id>` (the header's usage chip) reads
  that pane alone and queues no changes for it; only an id the last snapshot shows with an agent
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
- **Agent subagents** (`server/agent_subagents.go`, `GET /api/mux/panes/{id}/agent/subagents`):
  `requireMethod(GET)`, `crossSiteRejection`, `requireAgentRead`; internal errors are logged only.
  Only the pane's own Claude session (`AgentSession`, as the transcript): another agent, no
  transcript or no subagents directory answers `{nodes: []}`. Nothing comes from the client but the
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
  every file is opened nonblocking. The overview reads only the new transcript rows and the listing.
  Memory: per session asked for in the last 10 minutes, the ends, meta and file facts of the subagents
  listed. Limits: 200 nodes (the newest), 4 levels, a parent loop dropped, `truncated` set. It
  returns agent ids, the type, the description (200 runes), status, times and the last tool's name;
  never a prompt, a tool input or result, a path or a file name, so view-only may read it; the PWA
  shows the type, the description and the tool's name through `visibleUnsafe`, as the overview's text. The
  newest write of a running subagent becomes the overview's `lastTs`
- **Paired devices** (`server/device_*.go`, `server/pair_page.go`, `server/cli_devices.go`,
  `caps.devices`): a device signs in with a one-time code instead of the password and gets its own
  cookie `termote_device_<8 hex of the store id>` (`HttpOnly`, `SameSite=Strict`, `Secure` on HTTPS,
  400 days, never reissued; the id keeps two servers on one host name from clearing each other's).
  The token is 32 random bytes, `tmd_` + base64url, shown once; only its SHA-256 is stored, in
  `<stateDir>/devices/` (0700; `key.json`, `devices.json` 0600, owner-only ACL on Windows), at most
  50 devices (409 `too_many_devices`), name 1–64 bytes. Each record carries `gen` = HMAC(store key,
  user + password): another password makes a record ignored in memory, never deleted (a manual
  `serve` with another password must not end every device); only `start --fresh` removes them from
  disk. Every write rereads the file and applies one operation, holding an exclusive lock on
  `devices.lock` (0600, not a symlink; `flock`, `LockFileEx` on Windows) from the read to the rename,
  waiting at most 2 s (then the write fails and is logged), so another process (the CLI, a second
  `serve`) never writes back a revoked device. The process's own writes queue on `writeMu` before
  it, and the `lastUsedAt` flush made under `mu` by a lookup only tries both, leaving the uses for
  the next flush (shutdown waits). A file system that cannot lock (`ENOLCK`, `ENOTSUP`) writes
  unlocked and logs it once. A lookup stats the file at most each second, so a second process sees
  a revoke, and a reload ends what every device it no longer finds live holds (`onGone`, on its own
  goroutine: the hub's lock comes before the store's); `lastUsedAt` reaches disk each 5 minutes. `--no-auth`
  or an unusable dir: the store is not loaded, the routes answer 501 `unsupported`, `caps.devices`
  false. `basicAuth` order: public → `/login` → `/pair` → `/logout` → session cookie → device
  cookie → Basic; a session wins over a device cookie, and a cookie naming no record is cleared.
  Codes (`POST /api/mux/devices/pair` `{role, name?}`, full only, `writeGuard`) are 10 Crockford
  base32 characters shown `XXXXX-XXXXX` (typed `O`/`I`/`L` read as `0`/`1`), 5 minutes, once, in
  memory only, at most 5 waiting (409 `too_many_codes`); a revoked device's waiting codes go with
  it. `termote pair` calls the same route over the local socket (else with the saved password through
  the listener-owner check)
  and builds the link and QR as `url` does; `--role` defaults to `view`. `GET /pair[?code=]` only
  shows a script-free form; `POST /pair` (urlencoded, 8 KB) is checked like `/login`
  (`isCrossSiteLogin`, `writeGuard`'s `loginPath || pairPath`), with no code waiting → 401 at once
  and not counted, wrong codes counted by a limiter of its own (5/min per IP, 20/min per /64, so a
  typo never locks the password login; behind a proxy every client shares one address). A browser
  already signed in as a session or full device → 409, never downgraded; a view-only device paired
  again has its old record revoked. `safeNext` never returns `/pair…` and the service worker's
  `navigateFallbackDenylist` has `/pair`, so a code never reaches `next` or the history;
  `/login?next=/pair?code=…` (where an app page an older service worker served at `/pair` sends
  the browser) shows the pairing form with that code. The code's reply carries `expiresIn`
  (seconds) so the PWA counts down without trusting its own clock. Revoke
  (`DELETE /api/mux/devices/{id}`, `GET /api/mux/devices`, full only; Log out on a device revokes
  it): record written first, then its stream tokens dropped and its streams closed (a stream
  mid-handshake rechecks `alive`); a running request finishes. Container: the state dir is the
  volume `termote-state-<uid>` (kept by `container down`, removed by `uninstall --purge`);
  `container status` says when pairing is off. Time limit: `{validFor}` on the pair route (seconds,
  3600 to 400 days, absent or 0 = none, else 400 `invalid_validity`) becomes the record's
  `validUntil`, counted from the pairing; a maker with a limit must give one (400) and gets it cut
  to what it has left, and `add` cuts it again, so a device never outlasts its maker. Such a record
  stores its hash as `v2:<sha256>`: an older release never matches it (downgrade fails closed), and
  a `v2:` hash without `validUntil` is expired. Past it (`now >= validUntil`) `lookup` refuses and the
  cookie is cleared, `alive` is false, and one `time.AfterFunc` per process (re-armed through the
  store's `onReload` after each change or reload) closes its streams, stream tokens and codes. That
  timer runs on the monotonic clock and fires late after the host slept, so each open stream also
  asks `alive` (wall clock; it stats the file at most each second, like a lookup) at every 15 s ping
  (`streamHub.recheck`, outside the hub's lock): a stream of a device past its limit, or revoked by
  another process, closes within one ping, before or after a sleep; expired
  records stay listed (`expired`) until revoked; the cookie's `MaxAge` stays 400 days. Lineage:
  `pairedBy` (`password`, `session:<id>` or the maker's id; absent in older records, listed `unknown`); only the
  password (session, Basic: the CLI) makes a `full` code, a device gets 403 `full_needs_password`
  (also with Basic credentials as well: the device cookie is tried first). The maker must be live
  and valid in the very write that adds the device (`errCreatorGone`; `/pair` says "This code is no
  longer valid", not counted), and `codes.create` refuses a maker no longer `alive`. The DELETE
  route revokes the device and every live record it paired in one write (`revokeCascade`, one
  level) and answers `{ok, revoked}`; Log out and a view device paired again revoke only it. Audit:
  `auditf` (`server/audit_log.go`) logs `audit: <event> k="v"` (values `strconv.Quote`d, never a
  token, code, password or cookie) for `pair-code`, `pair`, `revoke` (`by`, `via`, `cascade`),
  `device-expired` (once per id and process), `device-gone via=reload` (a device another process
  revoked, ended by a reload) and `login via=form`; Basic sign-ins are not logged.
  What this does and does not protect: `docs/security-model.md`
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
- **View-only role** (`server/auth_role.go`, `caps.role` = `full|view`, `caps.viewStream`): Basic,
  session and `--no-auth` are always `full`; a device carries its role, and a role other than
  `full` (empty, unknown) reads as `view`. `basicAuth` refuses every
  non-GET/HEAD/OPTIONS method of a view-only client on any path (403 `{"error", "code":
  "view_only"}`) before a handler runs, except `POST /api/mux/logout`; handlers repeat it with
  `requireWriteRole`, so a route added later is closed without remembering to. Reads: transcript,
  commands, snapshot (`viewSnapshot`: no tmux default session, and Herdr is not started), push key and `worktrees` GET are allowed; `agent/prompt` carries no
  `promptId` (its `activity` is the same as for `full`); `GET agent/start` and `files/content?hash=1` are 403; a Place never (`place=` → 403
  `view_only` before the root is resolved, `files/places` lists none, `caps.places` false); Files/Changes routes only when
  the pane root is a git toplevel that is neither the server user's home dir nor above it (through
  symlinks; `$HOME`, else the user database, else every root counts as one; in the container also
  `/workspace/<TERMOTE_WORKSPACE_HOME>` (a local relative path, `.` for `/workspace`), which
  `container up` sets to where the host home sits in a workspace at or above it, matching names as
  `underDir` does: without case on macOS and Windows, and on Linux when the folded path is the same
  directory (WSL `/mnt/c`, casefold, vfat), so `--workspace /users/a` with the home
  `/Users/a` sets `.`, and a path that only matches without case keeps the home's own spelling;
  `container up` first spells each existing name of `--workspace` as its directory lists it
  (`diskSpelling`), since a runtime's VM shares `/Users` and compares names with case), never with `reveal=1` (`requireFilesRead`), `files/find` ignores `fresh=1` and
  `ignored=1`, and `files/search` searches exactly that tracked list and ignores `fresh=1`. Tree, content, raw and diff (and `files/tree`'s `dir`, the pane's directory) serve a view-only client only the paths of the root's
  tracked list (`git ls-files -c`, the `committed` list of `findLists`, Find's cache: a file
  just added shows once the index or a directory above it changes, at the latest 30 s later; a file git does not track, ignored or not, is never in it: a
  repo under a dotfile dir or a secret nobody added stays hidden) and the directories above them,
  by the path and by where its symlinks lead (a diff or a version from git status: where it leads
  only, so a deleted file's diff shows, but never the entry of an untracked file: `diff` and
  `serveImageVersion` refuse it, `trackedOnly`, from the entry they read); `files/changes` leaves out, for a view-only client, every untracked entry and
  every entry `viewHides` would refuse; names match
  exactly as git lists them (never folded: a case-sensitive volume on macOS keeps an ignored
  `notes.md` beside a tracked `Notes.md` hidden); anything else is 404 as if missing, a list cut
  short (`findMaxPaths`, git's output cap) refuses what it lacks, and a list that cannot be read
  refuses the request. The snapshot uses `peekSnapshot` (tmux does not recreate the default session).
  A view stream drops every input frame, `resize` and `drive`; tmux attaches `-E -r` to the
  session's active window only (another `pane` → 403; tmux ≥ 3.2, older tmux and psmux → 501,
  `caps.viewStream` false), Herdr only `observe`s. Limits: 2 streams and 4 waiting stream tokens
  per view device; a view stream or token never evicts a full one (full evicts view first; a full
  hub with no view stream to evict → "too many viewers"). The PWA hides every write control and
  shows "View only" (`caps.role`); tmux follows each session's active window, Herdr selects tabs
  client-side but cannot scroll history. No Web Push. A view client reads whatever the agent
  printed (accepted), except a sensitive file's tool results in the transcript (see Agent chat)
- **Pane layout** (`POST /api/mux/panes/{id}/split` `{direction, cwd?}` → `{ok, id}`, `zoom`
  `{mode}`, `swap` `{direction}`, `resize` `{direction, amount}` → `{ok}`;
  `server/mux_pane_layout.go`, `caps.paneLayout`: Herdr 0.9.3 or later and not on Windows, tmux
  (never psmux), Zellij 0.45.1 or later): auth, `hostGuard`, `writeGuard` (same-site JSON), 8 KB
  body, `requireWriteRole` first (a view-only client gets 403 `view_only`), then
  `requireMethod(POST)`, `muxTimeout`. Every argument is one of a few words, read before the
  backend is asked: `direction` `right|down` (split), `prev|next` (swap), `left|right|up|down`
  (resize), else 400 `invalid_direction`; `mode` `toggle|on|off`, else 400 `invalid_mode`;
  `amount` a whole number of cells 1–50 (1.5, 0, 51 or missing: 400 `invalid_amount`). A
  non-empty `cwd` goes through the groups' `resolveGroupCwd` (absolute, existing directory,
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
  at 64 bytes (`cleanPaneName`). Metadata is read only, never written by termote: Herdr's
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
  the boundary): empty → the server user's home, absolute only, on Windows only `X:\…` (a UNC
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
  `muxTimeout` for another group change gets 503 `busy`. A group created with a directory is
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
  the snapshot's. tmux
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
  key}` act on `@N` only while it sits at the id's index, else 409 `changed` (Herdr: key ≠ id →
  409); without a key, as before. Accepted gaps: deep links and saved selections to a shifted
  index open another tab; `send-keys` and the stream carry no key, so keys typed on another
  device within one poll of a move can reach the window that took the id
- **Worktrees** (`GET /api/mux/worktrees?groupId=` → `{repoName, worktrees, branches}`,
  `POST /api/mux/worktrees` `{groupId, branch, base, label}` → `{ok, id}`, `POST
  /api/mux/worktrees/open` `{groupId, branch}` → `{ok, id, alreadyOpen}`, `DELETE
  /api/mux/worktrees/{id}` `{force, path, branch}`; `server/mux_worktrees.go`, `caps.worktrees`:
  Herdr ≥ 0.9.2 from the `ping` version, never on Windows until checked there; tmux has none, 501
  `unsupported`): writes go through `writeGuard` (same-site JSON), `requireWriteRole` first (a
  view-only client gets 403 `view_only`), the 8 KB body; the GET through
  `crossSiteRejection` (so `Sec-Fetch-Site: none` too). Everything is checked before the slot:
  `branch` by `validBranchName` (git's `check-ref-format --branch` rules, 1–255 bytes, no leading
  `-`, not `HEAD` or `@`, and no Unicode control, format or space character, which git accepts
  and would let a name pose as another in the Remove confirmation), `base` empty (HEAD), `HEAD`
  or the same check (Herdr passes it to git positionally without `--`), a non-empty `label` by
  `validateTmuxTarget`. Creates, opens and removes take one slot (a one-slot channel, waited for
  at most `muxTimeout`, then 503 `busy`); once held, the read deadline grows and the change runs
  under `WithoutCancel` for 60 s (open: `muxTimeout`), so a client leaving never cuts git short;
  past that 504 `unknown` (Herdr may still finish; the PWA treats its own 75 s abort the same).
  Create with a non-empty `base` first runs `git show-ref --verify refs/heads/<branch>` on the
  repo root `worktree.list` names: Herdr ignores the base of an existing branch, so that is 409
  `branch_exists`. The DELETE needs all three fields (400 `invalid_request`; only a JSON `true`
  forces) and lists again under the slot: unless the entry whose `open_workspace_id` is the id is
  linked with that path and branch → 409 `changed` (`not_linked` for the repo's own). Herdr codes
  map to `unknown_group`, `not_found`, `not_git`, `linked_source`, `not_linked`, `ambiguous`,
  `create_failed`, `open_failed`, `dirty` (the PWA asks again, then sends `force`), `busy`,
  `unsupported` (also `invalid_request` naming a `worktree.` method), else 500
  `worktree_failed`; Herdr's message (git's stderr, with paths) is logged, never returned. Herdr
  never gets `trust_repository`, `path`, `cwd` or `close_group`. The GET's `branches` come from
  the files routes' `gitRunner` (`for-each-ref --count=500`, heavy, no backoff, 160 KiB, the
  last line dropped when cut, names failing `validBranchName` dropped, `[]` when git refuses).
  Create and remove run git with the user's config (hooks, LFS filters), as typing the command
  would; a remove deletes ignored files too and, with `force`, ends the panes first; the branch
  is kept. The snapshot's `worktree: {linked, branch?, parent?}` comes from `session.snapshot`'s
  membership (kept across a Herdr restart); the branch from a cache apart from the view
  (`herdr_worktree_branches.go`): served stale while one background `worktree.list` per
  repository refreshes it (10 s fresh, 1.5 s budget, 30 s kept after failures, 5 minutes off
  after `worktree_busy`/`invalid_request`), never filled by `peekSnapshot` (push watcher,
  `snapshot?peek=1`). The `worktree.*` event types are subscribed only when the gate holds (an
  older Herdr would refuse the subscription); an event or a change makes the branches stale.
  Closing a workspace with worktrees stays 409 `has_worktrees`
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
- **Agent chat** (`/api/mux/panes/{id}/agent/*`): for Claude Code on tmux the server reads only
  the transcript in the Claude config dir of the process found in the pane (`CLAUDE_CONFIG_DIR`,
  else `~/.claude`; psmux: `%USERPROFILE%\.claude`), and only for a process whose start time
  matches its session file's `procStart`; Herdr reports the session id itself, read from the
  server user's config dir. The session id must be a UUID. Every write (Claude Code or Codex)
  takes a lock on the pane, re-checks the process, session and screen, and sends nothing unless
  the screen shows the expected state (an empty input box, the dialog the client saw with a
  single-use `promptId`). A message also goes while the agent works (status `working`): the
  agent takes it into its own queue (Claude Code: Enter; Codex: Tab, since its Enter steers the
  running turn), and the route answers 202 instead of 204; an agent waiting on a dialog
  (`blocked`) or of unknown status still gets nothing, and so does a `/` command to a working
  Codex (Tab would take the popup's pick). Clearing a failed paste (C-c) still needs the agent
  idle, since C-c interrupts a working one: a working agent's box is left as `partial_paste`. Claude Code writes its transcript only with the first message: until
  then `transcript` answers an empty conversation whose cursor names the session, so the Chat
  view can send it.
  `GET agent/prompt` also returns `activity`, the agent's working line read off the same capture
  (`server/agent_activity_line.go`: Claude Code's spinner row just over the input box, Codex's
  `esc to interrupt)` row over the composer; once a Claude Code turn is done, its end line only
  while it names what still runs, read into `background`), `null` when there is none. It adds no capture and
  no write, takes nothing from the client, and holds only that line's own words (each field
  stripped of control characters and cut to 80 runes): a status line, no file content or
  command output, and less than the transcript and dialog card a view-only client already reads
  for every pane, so both roles get it.
  `agent/message` may carry `images`: at most 5 upload ids, each resolved through the upload
  store (a path is never taken from the client; unknown ids → 400 with the bad ids, no store →
  503 `uploads_unavailable`). Each path is pasted alone and the draft must show that many
  `[Image #N]` tokens (11s wait each) before the next; `at` (byte offsets, checked: one per
  image, in order, on a character boundary) puts parts of the text between them, each pasted
  and confirmed on its own, then Enter, with the process and session re-checked between
  pastes and before text pasted first. Text starting with `/` or `!` always goes after every
  image. If a step fails after the first paste, the box is cleared with one `C-c` only when
  the same idle agent shows nothing but one of the states this request pasted; otherwise 409
  `partial_paste` and nothing is touched.
  Markdown images in the Chat view never load (shown as links), and raw HTML is not rendered;
  its code blocks and Mermaid diagrams use the preview's (see Mermaid diagrams). A file path in
  it (a file tool card's input, inline code naming a file, a relative link) opens on a click
  only in the pane's Files view, through the files routes like any other open; a path outside
  the pane's root, or one whose `..` leaves it, is never requested, and none is a link
  without `caps.files`. A relative path starts from the pane's directory: `files/tree` names it
  (`dir`, relative to the root, only when under it), and a view-only client gets `dir` only when
  its tracked list holds that directory.
  A tool call carries `detail` for its card: the model's description, a Bash/Codex command whole
  (8 KiB) and an Edit/MultiEdit/Write's old and new text (16 KiB per call); the edits of a file
  `isSensitive` names are left out (`hidden`), as its diff is in Changes. A view-only client also
  gets no result of a Claude Code tool call on such a file (the call's `file_path`/`notebook_path`/
  `path`, or the result row's `toolUseResult` file path; a result read after its call, whose id the
  server keeps, last 4096, since a failed edit's row names no file but quotes its `old_string`):
  `Result` emptied and `hidden` set, on a copy of the cached read; the same for a Codex
  `FileChange` part (its diff) whose path or move path is such a file. A Grep over a directory,
  Bash and a Codex command's output that prints one is not keyed (accepted).
  `agent/commands` (the composer's `/` suggestions; Codex: its skills, see Codex chat) returns
  only names, descriptions, sources and kinds of `.claude/commands`/`.claude/skills` under the
  pane root and `commands`/`skills`
  in that config dir, read through `os.Root` (first 8 KB per file; a file that is a symlink, under
  a denied dir or with a sensitive name is never read; every file and every dir listed is opened
  nonblocking, so a FIFO in its place never holds the cached walk), with the same
  `Sec-Fetch-Site`/`Origin` check as the files routes. A symlinked skill dir is followed only
  into that config dir, the pane root or `~/.agents/skills`. On Windows a directory junction
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
- **Starting an agent** (`POST /api/mux/panes/{id}/agent/start` `{kind}`, `GET` of the same path,
  `server/agent_start.go`, `caps.agentStart`: Herdr ≥ 0.8.2 from the subscription's `ping`, on
  every OS; `caps.agentStartCodex`: also Codex has a Chat view on this OS, `codexProcSupported`):
  `writeGuard` (same-site JSON), `requireWriteRole`
  (a view-only client gets 403 `view_only`, also on `GET`), 8 KB body. Only `kind` is decoded (`claude` → no arguments, `codex` →
  `--no-daemon`, else 400 `invalid_kind`; `codex` where Codex has no Chat view
  (`codexProcSupported` false) → 501 `unsupported`, checked before the pane is resolved, nothing
  sent to Herdr; the PWA then offers only Claude Code); arguments and the Herdr alias
  (`termote-<kind>-<8 hex>`, one retry on `agent_name_taken`) are the server's. The pane is
  resolved (`requirePane`) before the pane lock, the one message/answer take, so the locks map
  holds only existing panes (404 `not_found`). Under it: a start of this server still running
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
  Each Herdr call has its own `muxTimeout`; the whole start runs without the request's
  cancellation once begun. Herdr answers at once (`launch_pending`): 200 `{ok, state:
  "starting"}`; `agent.start` timing out → 504 `start_unknown`, followed as if typed. Herdr's
  `agent_pane_busy` → 409 `pane_busy`, `agent_pane_not_found`/`agent_pane_unavailable` → 404,
  `unsupported_agent_kind` and an older Herdr's `invalid_request` naming `agent.start` → 501
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
  view asks for that message in the terminal
- **Codex chat**: a rollout is read only when a process whose executable is named
  `codex`, without `app-server` in its argv, holds it open for writing as a regular
  `rollout-*-<uuid>.jsonl` inside its own `CODEX_HOME/sessions` (resolved), with exactly one
  such rollout of a user thread; its dev:inode (Windows: volume serial and file index) is checked
  again after opening. Herdr's session id
  is trusted only when such a process holds that rollout. So only `codex --no-daemon` has a Chat
  view (the shared daemon writes every pane's rollout; on Windows 0.162.0 runs it as a child of
  the first TUI, refused by its `app-server` argv), and `/new` gives 404 on tmux until Codex
  restarts. On Windows (#295; psmux, Herdr) the holder comes from the system handle table
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
  `NtQueryInformationProcess` (command line class) and `CODEX_HOME` is the server user's
  `%USERPROFILE%\.codex` only (no PEB read), so a pane-only `CODEX_HOME` or another user's Codex
  has no Chat view, nor (expected, not checked live) an elevated one. `message` and `answer` write under the Claude Code rules: the
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
  dialog, and reads a card as read only when two approval titles sit in its stretch. A list or
  picker screen (`/model` and its effort step: a selected numbered `› N.` row, a footer like
  `enter select · esc back` as the last row or two; herdr draws the row in colours, not reverse video)
  reads as a read-only dialog, never as a composer draft, so `/model` is confirmed submitted and
  a message onto an open picker gets 409 `input_not_ready`.
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
- **Files/Changes** (`/api/mux/panes/{id}/files/*`): GETs that also check
  `Sec-Fetch-Site`/`Origin` (and the writes below; none is read-only any more, Changes included: `POST files/changes/apply` writes the index); every path is opened through `os.Root` under the pane's root (its
  git toplevel when a `.git` sits at it, else its directory) or a Place's (see Places); the server
  user's `~/.ssh` and `~/.gnupg` (in every root, a pane at `~` included), termote's config/state dirs, the
  upload store and the trash (a pane in the home dir would otherwise serve a deleted `.env` under
  its random name),
  `/proc`, `/sys`, `/dev`, `.git` and the repo's git dir (`--separate-git-dir`) are never served
  (on Linux a path differing only in case is denied when its directory is the same one: WSL
  `/mnt/c`, casefold, vfat);
  sensitive names (`.env`, keys, ...) return contents or a diff only with `reveal=1`.
  `GET files/content` takes an `encoding` of a fixed set (`utf-8`, `utf-16le`, `utf-16be`,
  `shift_jis`, `euc-jp`; another → 400, ignored by `?hash=1`) or detects one
  (`server/files_encoding.go`: a BOM, then valid UTF-8, then Shift-JIS/EUC-JP only when the
  bytes are valid in it and enough of the result is kana and kanji, a half-width katakana
  counting as kana only next to another; UTF-16 without a BOM is never guessed); its `hash` is
  the sha256 of the bytes read, never of the decoded text. A sensitive name without `reveal=1` is
  answered before anything is decoded; a read as another encoding than UTF-8, or one that
  detects the encoding of bytes not valid UTF-8, takes one of 2 server-wide slots (429 `busy`);
  a UTF-8 read none. It reads at most 4 MiB (`maxViewSize`, past it `previewable: false`,
  `too-large`); a save, a discard, content search and a whole-file diff stay at 1 MiB
  (`maxPreviewSize`), so a file shown past that is `editable: false`, `notEditable: too-large`.
  A read past 1 MiB (by its size before the read, or the bytes read) takes one of 2 server-wide
  `largeReadSlots` (429 `busy`), held until the answer is written under a 2-minute write deadline
  (its JSON escapes `<`, `>`, `&` and control bytes to six bytes each); a sensitive name not
  revealed takes none.
  The answer is gzipped when `Accept-Encoding` takes gzip (`jsonOKGzip`, `Vary: Accept-Encoding`):
  it holds a file's text and hash but no session token; a browser request from another site carries
  no session (`SameSite=Strict` cookies) or is refused by `Sec-Fetch-Site`/`Origin`, and the PWA
  reads a file again only when the user asks, so nothing makes the many requests a compression
  oracle (guessing a file's secret by the answer's length) needs.
  Content search and git diffs stay UTF-8 only. git runs
  without a shell, with `GIT_*`/`TERMOTE_*` stripped, hooks (`core.hooksPath` to the null
  device), index refresh on diff, fsmonitor, filter drivers, external diff and textconv off,
  submodules ignored, 10s timeout, 2 at a time (a command that writes the index runs under the
  same `-c` overrides but another timeout and cancellation: Staging and discarding a change).
  `files/raw` serves an image's bytes (Files: the worktree file, streamed from the open handle;
  Changes: `side=old|new` of an entry git status lists, picked like `diff`, never a client rev):
  the index is always `:0:<path>` (git reads `:1:a.png` as stage 1), `HEAD:<orig‖path>` for the
  staged old side, read by one `git cat-file --batch` (no filters, not `heavy`: no status/diff
  slot, no backoff; a name with `\r` or `\n` → 400, missing → 404 `no_version`, time out → 503). The type
  comes from the first bytes through `imageTypeOf` (shared with uploads: PNG/JPEG/GIF/WebP), plus
  SVG only for a `.svg` path whose first element is `<svg`; 10 MiB (413 `too_large`), 40 MP
  (PNG/JPEG header, a GIF's largest frame with its offset, a WebP's first chunk; 413
  `too_many_pixels`), else 415 `not_image`, a Git LFS pointer 415
  `lfs_pointer`, a sensitive name without `reveal=1` 403 `sensitive`. 4 at a time server-wide
  (429 `busy`), of which a view-only client never takes the last free one (`takeRawSlot`;
  downloads and hashes, full only, share them), 2-minute write deadline, `Cross-Origin-Resource-Policy: same-origin`,
  `Cache-Control: no-store`; an SVG also gets a second CSP
  (`sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:`) and
  `Content-Disposition: attachment`.
  The last commit (`files/commit`, `files/commit/diff`, `server/files_git_commit.go`) reads `HEAD`
  only: `rev-parse --verify --quiet HEAD^{commit}`, then `log -1` and `diff-tree` of that hash
  against its first parent (`--root` for a root commit), never a client rev. `commit/diff` takes
  the hash the client saw only to compare: another one than the current `HEAD` is 409
  `head_moved`, before any path reaches git. The path (and a rename's source) must be one that
  commit's `diff-tree` lists, under the same deny lists and `reveal=1` for a sensitive name, then
  goes in as `:(literal)` after `--`; a view-only client goes through `viewHides`. A commit's
  file list is kept 30 s per root and hash (a hash never changes what it names); a sensitive name
  is checked again when its diff is read. Message and author are shown with `visibleUnsafe`.
- **Places** (`--allow-path`, `server/cli_allow_path.go`, `server/files_places.go`): folders the
  operator names on the host with `termote start --allow-path <dir>` / `--remove-path <dir>`
  (saved like `--allow-host`, `TERMOTE_ALLOWED_PATHS` `:`-separated on Unix, refused by the Unix
  encoder when a path holds `:`; `AllowPath` in the Windows JSON) or `container up` (its own list).
  No route adds, removes or widens one: the client only picks one by an opaque id, `place=<id>`
  (the first 16 hex of the sha256 of the host path; the container passes the host ids), and an id
  not in the list is 404 `unknown_place`, never a path lookup. `validateAllowPath` refuses, on the
  path as typed and on its `EvalSymlinks` form: not a directory; a volume root, the home dir or one
  above it; a path at, inside or above `~/.ssh`, `~/.gnupg`, termote's config, state, data and cache
  dirs (the cache holds the trash and uploads), `/proc` `/sys` `/dev`, and on Unix the dirs holding
  the host's control sockets (`/tmp`, `/run`, `/var/run`, `$TMPDIR`, `$XDG_RUNTIME_DIR`: mounted in
  the container they would let a terminal drive the host's tmux or docker) (so `~/.config`,
  `~/.cache` and `~/.local` are refused, `~/.config/fish` is not); a
  component matching `isGitDirName`, or a dir git (through `gitRunner`) calls a git dir or a bare
  repo; a quote, line break or NUL; an unknown home (fails closed). `start` refuses a new path that
  fails (exit 2, nothing saved or stopped) and re-checks every saved one, printing a failing one as
  skipped with the `--remove-path` that drops it; `serve` checks each again against its own user and
  dirs and skips a failing one with a log line. Each request re-resolves the Place (1 s cache) and
  refuses one that leads elsewhere than when `serve` started (403 `place_moved`, logged). The root is
  the Place itself, never a repo around it (`isRepo` only when the git toplevel is the Place), and an
  enclosing repo's git dir stays a deny extra. From there every Files check of a pane root applies
  unchanged (`os.Root`, deny lists, `reveal=1`, trash, `writeDeny`, `requireWriteRole`). Full role
  only (see View-only role). Changes stays pane-scoped: `changes`, `changes/apply`, `diff`,
  `commit`, `commit/diff` and `raw` with `side=` refuse `place` (400 `place_not_supported`). A
  file's write lock is keyed by its absolute path and a write drops the find/status caches of every
  root that holds it or lies in it, so a pane root and a Place inside it never interleave saves of
  one file (the per-root lock of creates, deletes and renames is still per root string: a create
  in one and a rename in the other are not serialised, each still checked on its own handles).
  The PWA sends no `place` from a view-only client, and a Place refused (`view_only`,
  `unknown_place`, `place_moved`) sends the view back to the pane's folder.
  `GET /api/mux/files/places` (`requireMethod` GET, `crossSiteRejection`, `requireFilesRead`)
  lists `id`, `name` and the resolved path. In the container each Place is mounted at
  `/places/<id>-<name>` (`[A-Za-z0-9._-]`), refused with `,` or overlapping the workspace, a saved
  one failing on the host is not mounted; `TERMOTE_PLACES` (JSON id, name, container path) goes by
  name with `-e`, is in `termoteEnvKeys`, and `trustRepo` trusts these mounts like `/workspace`.
  `start` warns when the backend has no Files (psmux on Windows). A Place on another file system
  than the trash gets permanent delete only (`cross_device`).
- **`<details>` in a previewed Markdown file** (`detailsBlocks` in
  `pwa/src/utils/markdown-safety.ts`, Files/Changes only): raw HTML is never parsed or passed to
  React. A remark plugin, run before `htmlAsText`, folds an html node that is exactly a
  `<details …>` (optionally with `<summary …>…</summary>`) up to its matching `</details>`, at
  block level only, into a `details` node built from markdown nodes: no attribute but `open` is
  kept, the summary is a text node (its inline tags dropped), the body stays markdown under the
  same link and image rules. Tags are paired in one pass per level and nesting past 32 levels
  stays text, so a crafted file cannot stall the page. Anything else, an unclosed `<details>`
  included, stays text.
- **Mermaid diagrams** (`pwa/src/utils/mermaid-render.ts`, `mermaid-sandbox.ts`, `mermaid-worker.ts`,
  `mermaid-block.tsx`, through `fenced-code.tsx`): a `mermaid` fenced block of a previewed Markdown
  file or of a Chat view message (agent text, as untrusted as a file) is drawn in the PWA
  only, by Pele (pinned to an exact version) in a worker that a hidden
  `<iframe sandbox="allow-scripts">` of `/assets/mermaid-sandbox-<hash>.html` starts from a `blob:` URL, so code
  a flaw in Pele lets a diagram run lives in an opaque origin: it reads no cookie (and none of
  the server's goes with its requests), nothing of the app, and its page's own policy (see
  Content-Security-Policy) refuses every connection; the page treats each message of the frame
  as untrusted (only from `frame.contentWindow`, objects only, an unknown error read as
  `render_failed`), posts to it with `'*'` (its origin is opaque) and the frame relays only from
  its `parent`, copying the three request fields. The sandbox page is one inline script (built by
  `pwa/vite.config.ts`: the relay with the worker's IIFE bundle, every diagram type of Pele, as a
  string; `</script` and `<!--` escaped inside it), since an opaque origin can load nothing from
  the server; named by its content, it is cached as an asset (a year, immutable) and by the
  service worker at runtime (`mermaid`), left out of the precache and never the navigation
  fallback (`/assets/` is on its denylist).
  Shown as an `<img>` whose
  `src` is a `data:image/svg+xml` URL, so no script runs, no link navigates and nothing it names
  loads; the SVG string never enters the DOM, and nothing is added to `body`. The worker gets the
  source and the page's font list only; its render options are fixed there and never taken from
  the file: `links: false`, `images: false` (a shape's `img:` is drawn without the image, nothing
  fetched), no `icons`, `math` or `config` (Pele inserts icon and math markup unfiltered), `limit`
  50 000 characters, `maxEdges` 500. A `%%{init}%%` directive or front matter `config:` changes
  only Pele's own layout settings; HTML labels, `click` callbacks and `javascript:` links are not
  drawn, and a `style`/`classDef` holding `url(...)` or `@import` is refused (a syntax error) or
  dropped, depending on the diagram type. Only
  `PeleError.code` leaves the worker, never its message (it quotes the diagram). Dark colors go
  into the SVG's root `style` as `--pele-*` values (an `<img>` sees no page CSS). Never rendered
  (shown as code with a reason): over 50 KB (checked before the worker is asked) or over Pele's
  limits; a syntax error; a diagram type Pele does not know; 10 s past the moment drawing started
  (the iframe is removed, which ends its worker; the next diagram starts a new one); the sandbox
  saying it is broken (its worker failed to start or load), not ready 2 s after its page loaded
  (an error or sign-in page), or not ready and answering within 30 s. One diagram in the sandbox
  at a time, only near the viewport, 50 results cached by source and theme. Export (`utils/mermaid-export.ts`, `mermaid-export.tsx`): the PNG
  is that same `data:` URL decoded into an `Image` and drawn on a detached canvas (filled with
  the theme's background, at most 2×, 16 M pixels and 16 384 px a side), the SVG file that URL
  decoded in JS: Pele's output under the fixed options above as `svgToDataUrl` writes it,
  plus `background:<theme color>` in its root `style` (opened on its own, outside an `<img>`,
  it holds no script, link, image or external `url()`); nothing is fetched (`connect-src` has no `data:`), no CSP source added, and the
  SVG never enters the DOM. Share and Copy image only in a secure context (Web Share,
  `ClipboardItem`), the SVG download through a `blob:` link revoked after 60 s (the share sheet
  in the iOS Home Screen app). The saved name is the Markdown file's base name less its extension
  and `UNSAFE_CHARS`, plus `-mermaid-N`
- **Full-screen image viewer** (`pwa/src/components/image-viewer.tsx`, lazy chunk, mounted only
  while open): a Mermaid diagram, an image in Files and each side of an image in Changes open in
  a modal `<dialog>` showing the same URL already on screen (`data:`/`blob:`; nothing is read
  again, no request is made); a `blob:` URL replaced (and revoked) while it is open closes it.
  It pushes one history entry at the same URL (`history.state.termoteViewer`, a random id, no
  hashchange) so Back closes it; X, Escape and Android's `cancel` pop that entry
  (`use-history-close.ts`: one `back()` at a time, none while another is pending); `App.tsx`
  does not replace the address on that entry and drops a mark a reload left. Zoom/pan is Pointer
  Events and `transform` (`use-zoom-pan.ts`, `utils/zoom-pan.ts`; 0.5×–8× of fit, panning keeps
  the image on screen), `touch-action: none` on its stage, wheel listener non-passive; an SVG is
  drawn again at its zoomed size once a gesture ends. Its title is the app's name for the image
  (`visibleUnsafe` path, or "Mermaid diagram N"), never text from the file. Extra bar buttons
  (`actions`) are opt-in, given by a Mermaid block only, in a bar below the stage; their
  messages are the app's own text, in a `role="status"` node there, the dialog's name staying
  the title
- **Saving a file** (`PUT files/content?root=`, `server/files_write.go`): replaces the whole text
  of an existing file (a new one comes from `POST files/create`, see Creating a file). `writeGuard` (same-site JSON) plus the handler's own cross-site check and
  `requireWriteRole`; the `root` query is required (400, 409 once it moved). Body
  `{path, baseHash, text, reveal, encoding?, saveAs?}`: `encoding` (what GET `content` read the
  text as) from the fixed set of Files/Changes, `saveAs` only `utf-8` and only with `encoding`
  (else 400). Bytes on disk that already equal what the text encodes to are 200 (a repeated save
  is no conflict, a save as UTF-8 sent again too, with either line breaks), checked with
  `encoding` before anything about those bytes, without it after the checks of the file and its
  text; otherwise bytes other than `baseHash` (GET `content`'s `hash`, sha256 of the raw bytes) → 409
  `changed` (with `encoding`, before any fault of the text they decode to); never an overwrite. The read's path checks plus a write-only deny list (the
  install's data dir, the upload store); a sensitive name needs `reveal: true` (403
  `sensitive`). No component of the path may be a symlink; the parent is opened once through
  `os.Root` and used for every step. The file must be regular, one link, owned by the server user
  (Unix), owner-writable, without NUL once decoded from `encoding`, line breaks all `\n` or all
  `\r\n`, every byte valid in `encoding` (`invalid-encoding`, a save as UTF-8 too: those bytes
  would be lost) and encoding back to the very bytes read (`lossy-encoding`, not asked of a save
  as UTF-8) (422 `not_editable` + `reason`, or 403 `permission`; writing the new text on a read-only mount → 403
  `read_only`, on a full disk or quota → 507 `storage_full`, as a create); GET `content` reports the same check as
  `editable`/`notEditable`. Without `encoding` (a client or a kept draft from before encodings)
  the file must be valid UTF-8 whose BOM the text keeps (text starts with U+FEFF exactly when the
  file starts with `EF BB BF`), else 422 `not_editable` + `encoding-required`: no such save
  writes UTF-8 over a Shift-JIS, EUC-JP or UTF-16 file or drops a BOM. Text arrives with `\n` (a
  `\r\n` file gets them back), NUL or a lone `\r` → 422 `not_text`. It is encoded strictly, in
  `encoding` with the file's BOM, or as UTF-8 without one for `saveAs`: for Shift-JIS and EUC-JP
  a fixed table of characters an Apple keyboard types (〜 − ‖ ¢ £ ¬ — ¥) is first replaced by
  their full-width forms, and a character still not held → 422 `unencodable` + `line` and `char`
  (from the client's text, never the file's), never a `?`. At most 1 MiB once encoded (413
  `too_large`); body limit 6 MiB + 64 KiB, unchanged: a 1 MiB file decodes to at most 3 MiB of
  UTF-8 (half-width katakana) and JSON spells a control character in 6 bytes. 2 saves at a time
  (429 `busy`), read deadline 5 minutes once authenticated with a slot. A release from before
  encodings has none of these checks: a draft of a non-UTF-8 file kept on a device and saved
  after `termote update --version` back to one is written as UTF-8. Written to
  `.termote-edit-<random>` in the same directory (`O_EXCL`, mode set on the handle, `fsync`),
  the file read again, then renamed over it; the temporary file goes on any failure, ones older
  than 10 minutes are swept (only names of that exact form), every `.termote-edit-*` name is
  sensitive, and a save drops the root's cached git status. Saves of one file are serialised; an agent writing between the last read and the rename still loses its change (no
  compare-and-swap), and the rename drops ACLs/xattrs. A view-only client gets 403 `view_only`. The draft is kept in browser storage only as
  "Files/Changes state kept on the device" allows, never a sensitive file's
- **Desktop editor** (`pwa/src/components/code-editor.tsx`, CodeMirror 6, lazy chunk; languages
  and Vim mode in `assets/cm/`, never precached): shown only where `(pointer: fine)`; it edits
  the same draft as the textarea and saves through the same `PUT files/content` (Ctrl+S, and `:w`
  in Vim, only when there is something to save). No CSP source added: CodeMirror and
  `@replit/codemirror-vim` run no `eval` or `new Function`, and their styles are inline
  (`style-src 'unsafe-inline'`). Its `aria-label` is the app's text with the path, never the
  file's. Vim keeps its registers and search and `:` histories in module state shared by every
  editor: when the editor of a sensitive file the user chose to show (`reveal`) closes, they are
  dropped (`Vim.resetVimGlobalState_`). Escape is stopped at the editor while Vim is on, so the
  key that leaves insert mode does not restore a maximized panel
- **Files/Changes state kept on the device** (`pwa/src/utils/files-persist.ts`,
  `persisted-tabs.ts`, `pane-view.ts`; server `server/instance_id.go`): the snapshot's
  `instanceId` (16 random hex digits made once with `crypto/rand`, kept in `<stateDir>/instance-id`
  0600 through `writeStateFile`, made again when unreadable as one; not a secret, never logged;
  the state dir is in `FilesDenyDirs`) names the server. The PWA keeps in `localStorage`, under
  `termote-{files-tabs,changes-tabs,file-drafts,pane-view,recent-files}:<instanceId>:<pane key>[:<root>\0<path>]`
  with the pane's key and group name in each record: the open Files and Changes tabs (paths,
  scroll offsets, history, table layout), the Place the Files view shows (its id, kept even
  without a tab; one the server no longer offers falls back to the pane's folder), each pane's last view, the unsaved draft of a file
  (`root, path, baseHash, base, crlf, encoding, text, cells`; a draft whose `encoding` is not
  one of the fixed set of Files/Changes is not restored), and the files the user opened lately (at
  most 20 `root, path` pairs, written when the user opens a file from the tree, a search, a link
  or the command palette, never when tabs are restored or a file is created). Never kept: a tab
  or draft of a sensitive file the user chose to show (`reveal`/`revealed`: neither its name nor
  its text), nor such a file in a tab's Back history (an entry marked `reveal`, set by a link or
  a rename) or in the files opened lately (showing it, or a rename to it marked `reveal`, takes
  it out; a sensitive file not shown keeps its path, as its tab does), `intent`, the tree's open
  directories. A draft is written at once (never delayed) while it differs from
  the text read, removed at once on Save, Discard or back to that text; at most 1,000,000
  characters each and 1,500,000 for all, measured as stored JSON; too big, no room or a
  sensitive file's → in memory only, and `beforeunload` asks (it asks only for such drafts, for
  one another tab of the browser wrote or removed since, and for every one once this tab signed
  out).
  Drafts are written and read back only for a client that may write: a snapshot with
  `caps.role` `view` removes every kept draft. They come back once per pane in `applySnapshot`
  (`hydrateDrafts`), before any view reads a file, never over a draft in memory (one kept under
  the key of a version before Places, `:<path>`, is moved to its root's key; that read goes after
  one release); a record of
  another instance, or whose group name differs (a tmux `@N` used again after tmux restarted),
  is not read (a tab or view record is removed, a draft left to expire). A group renamed while
  the PWA is open (tmux, Herdr: the keys stay; Zellij: they move with it) takes its records
  along. Reading the file again: equal to the draft → the draft
  goes; another `hash` than `baseHash` → the `changed` banner (Save still never overwrites;
  Reload asks before dropping the draft); now sensitive → the draft goes; gone → a banner to
  copy or discard it. Restored tabs send their saved `root`: a pane that moved answers 409 and
  `rootChanged` closes clean tabs and asks about those with drafts. Records expire 14 days after
  they were written (a draft: after its text last changed), swept when the PWA loads. Log out,
  Clear cache & reload (before it ends the session, also when sign-in is off or the request
  fails), revoking this device in Devices and signing this browser out in Signed-in browsers remove
  every record, stop every later write in this tab (pending ones included) and set
  `termote-signed-out`, on which every other tab of the origin does the same and forgets its
  tabs and drafts; each write first checks that key, so a tab not yet told writes nothing back. Accepted gaps: a 401 (session expired, revoked from another device, server
  restarted) removes nothing, and `/login` runs no script, so a revoked device keeps its drafts
  until the PWA opens there again or 14 days pass; a non-sensitive file can still hold a secret;
  psmux keys panes by window index, so after windows are renumbered tabs and drafts may not come
  back; a group renamed while the PWA is closed (tmux, Herdr) leaves its records unread; another
  tab of the browser editing the same file: the last write wins
- **Command palette and app shortcuts** (`pwa/src/components/command-palette.tsx`,
  `shortcuts-section.tsx`, `pwa/src/utils/shortcuts.ts`, `app-commands.ts`,
  `pwa/src/hooks/use-shortcuts.ts`; desktop only: `(pointer: fine)` and not the phone layout):
  no server change and no route of its own. Files are found through `GET files/find` with the
  Files store's `root` (a 409 moves the store to the pane's root and searches again), and open
  through the same store as the tree. The keys the user set are kept in `localStorage`
  `termote-shortcuts` (`{v:1, keys:{<command id>:{key, inTerminal}}}`, one per browser like
  `termote-settings`, kept after signing out: it holds command ids and key names only, nothing
  of a server). Read back, an id is kept only when it is in the static list of command ids
  (`Object.hasOwn`, so `__proto__` and the like are dropped), a key only when it parses, holds
  Ctrl or Meta (or is F1-F12) and is not one the browser, the editor (Mod+S), the terminal
  (Ctrl+Shift+C, Ctrl+Shift+V) or text editing (Mod+A/C/V/X/Z) keeps; nothing is written back on reading. One
  listener on `window` (bubble phase, after the focused element's own handlers) runs a command:
  never from a dialog, menu or `inert` content (its key is only kept from the browser there),
  and in the terminal only a command marked to run there, which only a key xterm sends nothing
  for and the terminal does not use can be (Ctrl+Shift+letter but C and V; on Apple Cmd with a
  letter, digit or punctuation key, without Ctrl): no key the program in the pane would get is
  taken. A sensitive file shown (`reveal`) is not written to the files opened lately when its
  tab opens it again. An agent's command (`/name`, a Codex skill `$name`) is put in front of the
  Chat draft, or typed into the terminal without Enter only when the pane's command is that
  agent; nothing is sent, and a view-only client gets neither. A prompt template (the `Template:`
  entries, `caps.templates`) is filled in, then put in the Chat draft where the caret was, never
  sent nor typed into the terminal; disabled for a view-only client and a pane without the Chat
  composer. Tab, pane, file and template names are shown through `visibleUnsafe`
- **Focus windows and file links** (`pwa/src/utils/deep-link.ts`, `focus-mode.ts`,
  `open-window.ts`, `App.tsx`; desktop only for the action): no server change and no route of its
  own; the link is a hash, which never reaches the server. `file` and `orig` are dropped as a bad
  file (one short notice, "File not found or not allowed") when empty, absolute (`/`, a drive), or
  holding a backslash, NUL or an empty, `.` or `..` segment; otherwise the path is only a hint,
  opened through the Files store's `follow` (`GET files/tree` of its parent) or the Changes list
  (the side must be one git lists), so `os.Root`, the deny lists and `reveal` apply as to any
  other file. A failure shows the same notice, never the path or the server's text. A link only
  selects: it never sends keys, creates or closes anything. A focus window (`solo=1`, read once
  when the page loads) reads and writes none of the `files-persist.ts` records, nor the tab
  selection, tab metadata or sidebar folding, and sweeps nothing (this device's preferences, such
  as settings, theme, font size, keys and command history, are still saved); signing out from it
  still removes everything. It offers no new window of its own and no tab or pane to switch to
  (the palette's `@` rows are disabled), so it never leaves its target. **Open in new window** keeps the new window's `opener` (this app's own
  page); **Open in main window** drives an opener only when reading its `location.origin` works
  and equals this one, else it opens a new window. A stream closed with 4001 (evicted) shows
  `Disconnected by a newer window` and reconnects only when asked, each pane of Herdr's layout
  view on its own
- **Creating a file** (`POST files/create?root=`, `server/files_create.go`): an empty file and
  the directories missing above it (0666/0777 under the umask; directories made before a later
  failure stay, as with `mkdir -p`); the text then goes through `PUT files/content`. Same guards
  as a save (`writeGuard`, the handler's cross-site check, `requireWriteRole`, `root` required:
  400, 409 once it moved); the body (`{path, reveal}`, 8 KB) is read first, and its read deadline
  stays 60s; 201 `{root, path}`. The name is checked
  before the disk is touched (400 `invalid_name`): no empty component, at most 32 components and
  1024 bytes, 255 a component, none ending in a dot or a space, no control character, no
  `<>:"|?*` on Windows, not a temporary file's name (`.termote-edit-`, `.termote-rename-` or
  `.termote-upload-<16 hex>`, `tempName`), then `cleanRelPath`. Deny dirs, `.git`/the git dir and the
  write-only deny list → 403 `not_allowed`; a sensitive name needs `reveal: true` (403
  `sensitive`; the PWA asks once, then opens the editor without a Show). One lock per root, taken
  before one of the 2 write slots shared with saves (429 `busy`), so a create waiting on another
  holds no slot a save could use; each
  directory is opened from the one before (`Lstat`, `Mkdir` when missing, `OpenRoot`, then
  `SameFile` with what was checked): a symlink, a Windows junction (Go reports it irregular) or a
  directory swapped in → 403 `symlink`, a
  parent that is a file → 409 `not_directory`, EACCES → 403 `permission`, EROFS (Windows
  `ERROR_WRITE_PROTECT`) → 403 `read_only`, ENOSPC/EDQUOT (Windows disk full or quota) → 507
  `storage_full` (as uploads); each directory is
  checked against the deny lists again once it exists, before anything is made inside it (an 8.3
  name or a junction is only caught there). The file is opened `O_CREATE|O_EXCL` on its parent's
  handle: anything there, a dangling symlink included → 409 `exists` with the cleaned `path`
  (`/`-separated; Open it opens that), never replaced. A reply after the box was closed opens
  nothing, the tree is only read again. A create
  drops the root's cached git status. Accepted risk: a new file can be one another tool trusts
  or runs (`.claude/settings.local.json`, `.claude/commands/*.md`, `.vscode/tasks.json`,
  `.github/workflows/*`, a systemd/launchd unit when the root is the home dir); a signed-in user
  has a shell anyway, and a view-only client gets 403 `view_only` for creates as well as saves.
  The root's lock is keyed `root + "\x01create"`: `"\x00create"` was the key of a file named
  `create` at the root, and a delete takes both
- **Pasting an image into Markdown** (`POST files/image?root=&dir=[&reveal=1]`,
  `server/files_image.go`): an image pasted into a `.md`/`.mdx` file being edited becomes a new
  file next to it. Raw `image/png|jpeg|gif|webp` body (never SVG, never multipart: `writeGuard`
  takes these types on this path and uploads only, anything else → 415 `unsupported_image`).
  Order, as a save and a create: `root` required (400), then the handler's cross-site check,
  `requireWriteRole` (403 `view_only`) and the root still the pane's (409), `dir` checked (400
  `invalid_name`: `.` for the root, else `validPathShape`, no `\`, then `cleanRelPath`), a
  `Content-Length` over 10 MB → 413 `too_large` unread, then one of the 2 write slots shared with
  saves, creates, deletes, renames and restores (429 `busy`; held while the body streams), then the read deadline grows to 5
  minutes and the body is capped at 10 MB (`MaxBytesReader`). The first 512 bytes must be the
  declared type (415); the image's pixels are counted with `imageType` as it is written (over 40 MP
  → 413 `too_many_pixels`, not an image → 415), the rest streamed to disk, never held whole. The
  directory is walked as a create walks it, without making any (`walkParents`: a symlink or
  junction → 403 `symlink`, deny dirs and the git dir → 403 `not_allowed`, missing → 404
  `not_found`);
  `dir/assets` is used when it is a real directory (a link, a file or nothing there → `dir` itself,
  never through the link), checked against the deny lists too. The server names the file
  (`pasted-YYYYMMDD-HHMMSS.<ext>`, then `-2` … `-99`, then 409 `exists`; the client's name is
  never read) and opens it `O_CREATE|O_EXCL` on the directory's handle: nothing is ever replaced,
  and there is no temporary name or rename. A sensitive path (`.ssh/…`) needs `reveal=1` (403
  `sensitive`). The root's lock (`rootLockKey`) is held only while the name is chosen and opened,
  never while the body streams; a failure after the open (a body cut short, over the cap, not an
  image, a disk error: a write error is kept apart from the body's, so a full disk is 507
  `storage_full`, and a body error is checked even when the GIF count took it for the file's end)
  removes the file by name through the same directory handle (a local process renaming it and
  making another of that name meanwhile would lose that one: accepted). A file being written can be
  read half-written by another tool. 201 `{root, path}` (`/`-separated); the root's cached git
  status is dropped. Accepted risk: no quota and no sweep (unlike uploads), at most 10 MB per
  request and 2 at a time, since the file is the user's own in their repo, as a save is. No caps
  flag: the PWA offers it where Edit is offered
- **Uploading a file** (`POST files/upload?root=&dir=&name=[&reveal=1][&check=1]`,
  `server/files_upload.go`; PWA `hooks/use-file-uploads.ts`, `utils/upload-file.ts`): a file from
  the device (the Upload button, a drop on Files, a paste of files in the tree) becomes a new file
  in a folder of the root, any type, 0 bytes allowed, never sniffed. The body is raw
  `application/octet-stream` only (`writeGuard`, above: any other type → 415 `unsupported_type`);
  `check=1` is a JSON write like any other and its body is never read. Order: POST only (405),
  `root` required (400), the handler's cross-site check, `requireWriteRole` (403 `view_only`), the
  root still the pane's (409) or the Place's (403 `place_moved`, 404 `unknown_place`), `dir` as
  `files/image` checks it (`imageDir`, 400 `invalid_name`), then `name` (`validUploadName`, 400
  `invalid_name`): exactly one component on every OS (no `/`, no `\`, `filepath.IsLocal`,
  `Base(name) == name`), a create's per-name rules (`validNamePart`: at most 255 bytes, no
  control character, not ending in a dot or a space, so never `.` or `..`, and `<>:"|?*` on a
  Windows host), never a temporary file's name (`tempName`), no Windows device name on any OS
  (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`, `COM¹²³`, `LPT¹²³`, `CONIN$`,
  `CONOUT$`, with or without an extension: `CON.txt`), no format character (a bidi override or a
  zero-width space makes one name pose as another) and no U+FFFD or invalid UTF-8.
  - `check=1` runs every check that needs no body (the walk, the deny lists, sensitive, the name
    the upload would get now), creates nothing, takes no slot, and answers 200 `{root, path}` or
    the refusal; with no refusal, 429 `upload_busy` while another upload holds the slot (looked at
    only). The PWA always checks first: a refusal written before a large body is read reaches the
    browser as a reset connection (`net/http` stops reading past 256 KiB), not as its code. The
    upload checks everything again.
  - The upload: a `Content-Length` over 100 MiB (`maxUploadFileSize`, as `maxDownloadSize`) → 413
    `too_large` unread; one slot of its own (`uploadSlots`, capacity 1, never one of the 2 write
    slots of saves) else 429 `upload_busy` unread; the body capped at 100 MiB (`MaxBytesReader`,
    413); a read deadline of 2 minutes from each read that brought bytes and 30 minutes for the
    whole body (`idleReader`): a client that stops sending gets 408 `timeout` and frees the slot.
    The folder is walked as a create walks it, making none (`walkParents`: a symlink or junction
    → 403 `symlink`, deny dirs and the git dir → 403 `not_allowed`, missing → 404 `not_found`, a
    file on the way → 409 `not_directory`); the name is checked again before the body is read
    (deny lists, sensitive without `reveal=1` → 403 `sensitive`). `.termote-upload-<16 hex>`
    files over an hour old in that folder are swept (that exact form only), then the body streams
    into a new hidden `.termote-upload-<16 hex>` (`O_CREATE|O_EXCL`, 0666 under the umask), synced
    and closed; a disk error is kept apart from the body's (507 `storage_full`, 403 `read_only`,
    403 `permission`).
  - Only then, under the root's lock (`rootLockKey`, never held while the body streams), the
    first free name: `name`, then `stem (2)ext` … `stem (99)ext` (a dotfile with no other dot has
    no extension: `.env (2)`; the stem cut on a rune boundary to stay within 255 bytes; each one
    checked again: the name rules, the deny lists, sensitive), past 99 → 409 `exists`.
    `os.Root.Link(temp, name)` gives it the name (a hard link never replaces: a taken name moves
    on to the next), then the temp is removed. Where the file system has no hard links (`Link`
    fails with `ErrUnsupported`, `EPERM`, `ENOTSUP`, `EXDEV` or `ENOSYS`; on Windows
    `ERROR_INVALID_FUNCTION` or `ERROR_NOT_SUPPORTED`): the name is `Lstat`ed and, free, the temp
    renamed to it under the lock. Any failure removes the temp by its random name, never a name a
    user sees: a visible name only ever holds a whole file, and a server stopped mid-upload leaves
    only a hidden temp. 201 `{root, path}` (`path` names the file as saved); the root's cached git
    status is dropped; an `audit: upload path= size= by= via=` line.
  - Upload temps are refused as a name by every write (`tempName`) and are sensitive
    (`isSensitive`), as a save's: one a failed remove left shows in the tree as sensitive until
    the sweep, and one whose `Link` worked shares the visible file's inode, so it is swept only
    once that file went an hour unchanged. Accepted risks: on a file system without hard links
    (a FAT or exFAT stick on Windows too), a file another process makes under the same name
    between the `Lstat` and the rename is replaced, on Windows as on Unix (Go's `Root.Rename`
    replaces an existing file there, unless it is open without delete sharing), and so is a file
    a create makes through another root's lock (a Place inside the pane's root); the slot is one
    for the whole server, so a writer sending a byte just under every 2 minutes holds it up to 30
    minutes; an uploaded file is as trusted as one made with `files/create` (Windows runs a
    file by its extension, so an uploaded `.exe` or `.ps1` can be run like any file the user has;
    a writer has a shell anyway); no quota beyond 100 MiB a file and one at a time, writer role
    only.
  - The PWA sends one file at a time from a queue that outlives the Files view (switching to the
    terminal never stops it); each file keeps the pane, Place and root it was started for. It asks
    once per batch before a sensitive folder or name (`.ssh/…`, `.env`), naming the file, the
    folder and the root (Enter cancels; a no sends nothing of the batch and says nothing), waits on `upload_busy` (every 3 s, 150 s at most), and after every byte went checks
    a lost answer by reading the folder (the name and the size). Drops are taken in the capture
    phase on the whole Files view: the browser never navigates to a dropped file, and the editor
    never inserts its text. A view-only device has no Upload button and no paste, and a drop only
    tells it so
- **Finding a file** (`GET files/find?q=&root=&ignored=1&exclude=…&fresh=1`,
  `server/files_find.go`): the GET guards of the other files routes; only names are sent, as
  the tree does. `q` is trimmed, 1–256 bytes; `exclude` (repeated) is at most 50 directory
  names of at most 255 bytes, never `.`/`..` nor holding `/ \` NUL `* ? [` (400
  `invalid_exclude`), compared without case on Windows/macOS. In a repo the list is
  `git ls-files -co --exclude-standard --deduplicate -z` less `ls-files -d` (files gone from the
  disk) and less what git lists as a directory (a nested repo, a submodule); a view-only client's
  is `git ls-files -c --deduplicate -z` (tracked files only), cached apart. Tracked files are
  never filtered by `exclude`. `ignored=1` adds `git ls-files -o -i --exclude-standard
  --directory -z`, read and cached apart: a path with an excluded component is dropped unread,
  a directory git names whole is walked through `os.Root` without entering an excluded name at
  any depth. Outside a repo the root is walked the same way. A walk never enters a symlinked
  directory or a junction (irregular), lists a symlink only when `os.Root` stats it as a file,
  and is bounded per list: 200 000 paths, 32 levels, 5 s, git output 16 MiB → `incomplete`.
  Building a list drops `.git` components and paths under a deny dir or the git dir by name;
  the ranked results then pass `f.denied` (through symlinks) and an `Lstat` (gone or a directory
  → dropped) until 200 are kept (`truncated` past that). git runs as `heavy` with `noBackoff`: a
  timeout answers 503 but never makes Changes back off. Lists are built under
  `context.WithoutCancel` (the PWA aborts the previous request at each key), cached 30 s per
  root + `SafeDir` + kind (+ the sorted excludes; a failure is not kept), dropped by `forgetRoot` on a save, a create, a
  delete and a restore, by `fresh=1` (the PWA's refresh), and at a search that finds the list's stamp changed
  (`server/files_find_stamp.go`): the times of the directories it was read from (the root, every directory a walk
  read or above a listed file; at most 20 000, past that only the 30 s end it) and of the repo's index, taken
  after the build; a directory gone, no longer a directory or of another time, or the index of another time or
  unreadable, is a change, and a time from 2 s before the build to 2 s after the stamp makes the first check one
  too (a time far ahead is only compared). A stamp is checked at most once a second, by one request at a time
  (the others wait for its answer), and only the finished list read is then dropped (`ttlCache.forgetIf`): a build in
  flight is joined, never restarted. The stamp is server-side `Stat`s of what the list was built from (`os.Root`
  for directories), never a path from the client; a view-only client's request rebuilds only for such a
  change, never for its `fresh=1`
- **Searching file contents** (`GET files/search?q=&root=&case=1&word=1&regex=1&files=…&skip=…&exclude=…&fresh=1`,
  `server/files_search.go`, `server/files_search_glob.go`): the GET guards of the other files
  routes. `q` is 1–256 bytes, never trimmed. `files`/`skip` (repeated) are at most 20 globs
  each, of at most 255 bytes, no NUL or `\`, at most 4 `**` (400 `invalid_glob`), matched by
  dynamic programming over (pattern part, path component), so a `**` pattern costs parts ×
  depth `path.Match` calls; `exclude` is Find's (same parser, 400 `invalid_exclude`). The
  pattern is Go `regexp` (RE2): a regex is parsed alone before any wrapping (whole word, case),
  so wrapping never makes an invalid one valid, and a program past `searchMaxProg` (1000)
  instructions is refused; every failure is 400 `invalid_regex` with a generic message, never
  Go's text. A regex that can match empty text (`a*`, `^`, `x*|foo`) is 400 `empty_match`: its
  non-empty matches would take a scan of the line per position. RE2 costs input × program size,
  so a line is matched on its first 16 KiB only (a cut line → `incomplete`), once to tell whether
  it matches; its other matches are looked for in the 240-rune window sent, at most 240 of
  them, never in the whole line (no search costs a scan of the line per match). There is no
  whole-file search: the deadline is checked before each line, so a scan overruns its budget by
  at most one line's search. Nothing reaches git
  argv: a query starting with `-` is text. The list is Find's (`findLists`, the same cache key
  with the PWA's excludes; a view-only client searches its `req.view`, tracked files only, and
  `fresh=1` is ignored for it), sorted by path. Per file, before anything is
  opened: the `files`/`skip` globs; under a root holding a home dir (`holdsHome`) every
  dot-path is skipped (`skipped.hidden`: shell histories hold secrets under ordinary names);
  then one `EvalSymlinks` shared by `deniedPaths` (deny dirs, the git dir, `.git` parts, on
  both paths), the view-only target check (where a link leads must be listed), the dot-path
  rule on where a link leads (a link of an ordinary name to `.bash_history`) and
  `isSensitive` on both paths (never opened, `skipped.sensitive`). Only then `os.Root`
  `OpenFile` with `openNonblock`, and every check on the handle (`readTextFile`, shared with
  content): regular, at most 1 MiB (`skipped.tooLarge`), a NUL in the first 8 KiB stops the read
  (`skipped.binary`), not UTF-8 → `skipped.binary`. Caps: 2000 matching lines (`truncated`), 100
  per file (`more`), 256 MiB read and 5 s from the scan's start, kept 500 ms short of the
  request deadline (`incomplete`: answered with what was found, never an empty body), 2 scans
  server-wide without waiting (429 `busy`), 4 workers at most 8 files ahead of the merge.
  A client that leaves gets nothing written; the response ends once every worker has (each
  stops at its next line, or when a read returns), and the slot is freed after that. No git runs beyond Find's `ls-files`. Matches are sent as a window
  of 240 runes of the line with UTF-16 ranges; Go's `\b` is ASCII only
- **Deleting a file** (`POST files/delete?root=`, `POST files/restore?root=`,
  `server/files_delete.go`, `server/files_trash*.go`): the guards of a create (`writeGuard`, the
  handler's cross-site check, `requireWriteRole`, `root` required), body read first (8 KB);
  then the root's lock, the file's lock (shared with saves) and a write slot without waiting
  (429 `busy`), then the trash's mutex: a save takes its slot before the file's lock, but a
  delete never waits on a slot, so they never wait on each other. Delete body
  `{path, kind: file|dir, baseHash, reveal, permanent}`: `.`/`""` → 400 `invalid_path`, the
  create's deny lists → 403 `not_allowed`, a sensitive name without `reveal` → 403 `sensitive`;
  the parents are opened one at a time without making any (a symlink, a junction or a swapped
  directory → 403 `symlink`, a missing one 404). A file must be regular (409 `not_file`), the
  one opened (`SameFile`), one link (409 `hardlink`), the server user's (403 `permission`), and
  its sha256 (streamed, at most 512 MiB, else 413 `too_large`) must equal `baseHash` (409
  `changed`). A record `<32 hex>.json` (`{root, path, kind, deletedAt, size, mode[, after]}`, `.part`
  0600 `O_EXCL` then rename) is written, then the file is renamed into
  `os.UserCacheDir()/termote/trash/<32 hex>` (0700, refused when a symlink or another user's →
  503 `trash_unavailable`, `Caps.trash` false) by directory descriptors (`renameat2`
  `RENAME_NOREPLACE`, `renameatx_np` `RENAME_EXCL`, else `linkat` + `unlinkat`; Windows
  `MoveFileEx` without `MOVEFILE_REPLACE_EXISTING` on paths checked first, an accepted gap: a
  local writer of the root has a shell anyway); what landed must be the file checked, or it
  goes back (never replacing) and 409 `changed` (with `trashId` when its name was taken again
  meanwhile). `EXDEV`/`ERROR_NOT_SAME_DEVICE` (WSL `/mnt/c`, a volume, the container's
  `/workspace` bind mount): 409 `cross_device`, nothing deleted, unless `permanent: true` (the
  PWA asks a second time): then the file is checked again (`SameFile`) and unlinked by
  descriptor, 200 `{permanent: true}`; `permanent` never skips a trash that works. An empty
  directory is removed by `unlinkat(AT_REMOVEDIR)`/`RemoveDirectory` (a file swapped in →
  409 `changed`; entries → 409 `not_empty`) after its record; the root never. Never
  `os.Root.Remove`, which unlinks before trying rmdir. Restore `{trashId, reveal}`: a 32-hex id
  (400), its record (404 `not_in_trash`), the record's root (409 with the root), its path
  checked as a create's but not its name (`a.` must come back), parents made, then renamed back
  never replacing (409 `exists` with `path`; `cross_device`), with one controlled exception: a
  record of `kind: discard` (below) replaces the file, and only while it still holds exactly what
  the discard left; the trash's mutex is held from
  reading the record again to removing it. The sweep (at start and before every delete) ages an
  entry by `deletedAt` only, never the mtime a rename keeps: 7 days, then the oldest past 1 GiB,
  never one younger than an hour; names left half done (a payload or a record alone, a `.part`)
  go 10 minutes after the sweep first sees them; a payload that is the restored file itself (a
  `linkat` restore that died) is only unlinked; only `^[0-9a-f]{32}(\.json(\.part)?)?$` names
  are removed, never through a directory or a symlink; a `discard` record without its payload is
  swept like a `file` one. `GET files/content?hash=1` answers
  `{root, path, size, hash}` with no text for any regular file (no `hash` past 512 MiB), even a
  sensitive one not revealed, so deleting a `.env` never sends its secret to the browser
  (accepted risk: a short secret's hash can be guessed by a signed-in user, who has a shell);
  it takes one of the 4 `files/raw` slots (429 `busy`). `termote uninstall` keeps the trash
  (the user's files) and says where; `--purge` removes it. A view-only client gets 403 `view_only`
  for deletes and restores, and `content?hash=1`.
  The root's trash (`GET files/trash?root=`, `POST files/trash/delete?root=`,
  `POST files/trash/empty?root=`, `server/files_trash_list.go`): full clients only, the list
  too (403 `view_only`: it names files a view-only client may not read), `root` required (400,
  never the trash of a directory the pane moved to; a different one → 409 with the root), no
  trash → 503 `trash_unavailable`. The client sends only ids (`trashId`, `trashIds`, each
  `^[0-9a-f]{32}$`, else 400), never a path. Scope is the exact root: an entry whose record's
  `root` differs (deleted before a `cd`, or from a Place or repository holding this folder) is
  never listed or removed here, and a delete of one answers 404 `not_in_trash`, as for an id that
  is gone (not 409 like a restore, which needs the new root). The list holds no lock (a record
  is renamed into place whole, never changed): it reads every record, skips one past 7 days, a
  `file`/`discard` whose payload is missing or not a regular file, and a `file` whose `linkat`
  restore died, removes nothing, answers the 500 newest (`truncated`), with `sensitive` computed
  for those only, and takes one of the 4 `files/raw` slots (429 `busy`). A delete and an empty
  hold only the trash's mutex, for one id at a time, and take no write slot (they change nothing
  under the root): the record is read again under it and must name this root, the payload is
  removed first, only when `Lstat` says it is a regular file of the store (a symlink or a
  directory is left alone), and when that or the `Lstat` fails (not `ENOENT`) the record stays,
  so the entry is still listed: 500 for a delete (an access denied too, logged), counted in
  `failed` for an empty; a store that cannot be opened is 503 `trash_unavailable`. The list reads each record through the store's `os.Root`: on Windows a
  plain open shares no delete, and a restore removing that record meanwhile would fail unseen. Both ignore the one-hour
  `trashMinAge` (the user asked), but an empty (`{trashIds: [...]}`, 1–500, body 24 KB) removes
  only the ids sent, those the client listed, never one deleted since (another device's Undo);
  ids gone or of another root are skipped (`{removed, failed}`). A restore racing a delete of the
  same id rereads the record under the same mutex: exactly one wins, the other gets 404
  `not_in_trash`. `audit: trash-delete id=…` and `audit: trash-empty removed=… failed=…` (with
  `by`, `via`) never carry a path or a root
- **Staging and discarding a change** (`POST files/changes/apply?root=`,
  `server/files_git_apply.go`, `server/files_git_patch.go`): a file git status lists, or one hunk
  of its diff, is staged, unstaged or discarded. Guards in order: `writeGuard`, POST, `root`
  required, the handler's cross-site check, `requireWriteRole` (a view-only client gets 403
  `view_only`), the body (8 KB), then the action (`invalid_action`), a discard with no trash
  (503 `trash_unavailable`), the path (`.`/`""` → 400 `invalid_path`), the create's deny lists for
  `path` and for `orig` too (403 `not_allowed`), a root that is no repo (404 `not_changed`),
  and the root's lock, the file's lock and a write slot without waiting (429 `busy`), shared with
  saves and deletes. The root's cached status is dropped, then a fresh one is read. Body
  `{action: stage|unstage|discard, path, orig, hunk, baseHash, reveal, permanent}`: only a path
  (and `orig`) that status lists, on the side the action acts on (the index side for `unstage`),
  else 404 `not_changed`; a conflicted path or `orig` → 409 `conflict`, checked first because a
  conflict has no staged side. The status letter must be one of `MD?` for `stage`, `MADRC` for
  `unstage`, `MD?` for `discard`, and a discard refuses any entry whose index or worktree mode is
  `120000` or `160000` (a symlink, a submodule): 409 `unsupported`. A sensitive name without
  `reveal` → 403 `sensitive`. Every read (status, `check-attr`, diff, the index version) comes
  before the first write.
  - **Filters.** A path (and `orig`) with any `filter` attribute other than unset or unspecified
    → 409 `filtered` (LFS, `git-crypt`): the filter drivers are off, so `git add` would stage what
    the clean filter should have turned into something else, and a driver set at the system level
    cannot even be seen. `git check-attr --stdin -z` takes names, not pathspecs.
  - **Whole file.** Stage is `git add -- :(literal)<path>`; unstage is `git restore --staged`
    (with `orig` for a rename, so both sides go back), or `git reset -q` when there is no commit
    yet (`rev-parse --verify HEAD` exits 1). Every path is a `:(literal)` pathspec.
  - **One hunk** (`hunk` is an id, never text). `files/diff` gives a hunk an `id`, the sha256 of
    its header and lines as git printed them, only when the side is a change in place (`M`, no
    rename or copy, a regular file, the same mode on both sides, not binary, not truncated) and
    git's `---`/`+++` lines name the path itself (`hunkHeadOK`); else no `id`, and an apply
    by hunk → 409 `hunk_unsupported`. The diff runs with fixed `--src-prefix=a/ --dst-prefix=b/`,
    whatever `diff.noprefix` the user set. An apply takes the diff again and finds the id in it:
    not found → 409 `stale_hunk`. The patch is built by the server: the `diff --git`, `---` and
    `+++` lines are written from the path, always C-quoted (`quoteC`), never copied from git's
    output, and there is no `index` line; then the hunk, as git printed it. It goes to
    `git -c apply.ignoreWhitespace=no apply --cached -p1 --whitespace=nowarn` (`-R` to unstage) on
    **stdin**, never as a file or argv: only the index is written. Any git failure → 409
    `stale_hunk`. A name with `\r` or `\n` needs no 400: `cat-file` gets the name in argv, not
    stdin.
  - **Discard** writes the worktree, which git never does here. Untracked (`?`): the delete
    route's code (`deleteFileLocked`, kind `file`, `baseHash` required, `permanent` as for a
    delete: `cross_device` and its record), so it is one entry in the trash. Deleted (`D`): the
    file is made again from the index (`recreate`: the parents made as a create makes them,
    `O_EXCL`, never over a file that came back → 409 `changed`; 0644 or 0755 from the index mode,
    set on the handle). Changed (`M`), whole file: `baseHash` required (400), the file is
    opened as a save opens it (`openEditDir`, `readEditTarget`: no symlink on the way, a regular
    file, one link, the server user's, at most 1 MiB: 422 `not_editable` with `reason`, 403
    `permission`, 413 `too_large`; a binary file is discarded whole too), its sha256 must equal
    `baseHash` (409 `changed`); the new text is the index version. A copy of what it replaces is
    kept first (`keepCopy`: payload `O_EXCL` 0600, then the record `{kind: discard, mode, after}`,
    `after` the sha256 of the new text), then `replaceFile` writes it. That write narrows the race
    with another writer as a save does, and does not close it. If the write fails the entry is
    removed. Changed, one hunk: not `M` → 409 `hunk_unsupported`; the hunk is undone **in Go**
    (`reverseHunk`) on the bytes just read, not with `git apply -R`, because `apply` writes the
    worktree through paths, filters and `core.autocrlf` this server does not control, and the
    save's checks and `replaceFile` must be the only writer. Each line is compared (one trailing
    `\r` ignored, written with the file's own line break); any line that differs, a count or a
    missing newline that does not fit → 409 `stale_hunk`, nothing is guessed. The response has
    `{root, path, trashId[, permanent]}`.
  - **Restore** of a discard (`files/restore`, `restoreDiscard`) is the one restore that
    replaces a file. Under the restore's locks it reads the file as a save does and puts the copy
    back only when the file's sha256 equals the record's `after`; a directory on the way gone or
    turned into a file or a symlink, a missing, oversize, hard-linked or non-regular file, or any
    other hash → 409 `changed`, the file and the entry stay. The payload is opened with
    `os.Open` like the record (the store is private), at most 1 MiB, written by `replaceFile`
    with the recorded mode, then the entry goes.
  - **Size.** An index version is read at most 1 MiB (`too_large` 413): `cat-file -s` first, and
    nothing is read when it is larger; then `cat-file --filters` with the same limit, because the
    line breaks can make it grow (cut → 413 `too_large`). The save's own checks apply to the
    worktree file.
  - **Index writes** (`gitCall.write`: `add`, `apply --cached`, `restore --staged`, `reset`) do
    not end with the request (`context.WithoutCancel`): a half-finished index is worse than one
    that took a moment. They run under a 30 s timeout and, on Unix, are interrupted (SIGINT)
    rather than killed, so git removes its own `index.lock`. On Windows the process is killed
    after 30 s: an accepted risk, a stale `index.lock` may stay. They take a git slot (no
    backoff) like the diff. `index.lock` in git's message → 409 `index_locked`. Git's own text is
    logged, never returned; every other failure is a `codedError` or a generic 500. The root's
    caches are dropped (`forgetRoot`) before the status and after the write, so Changes reads the
    new state; the PWA refetches.
- **Renaming a file** (`POST files/rename?root=`, `server/files_rename.go`): a regular file moved
  to a new path under the same root (a rename, or a move whose missing directories are made, and
  stay if a later step fails, as with `mkdir -p`); never a directory. The guards of a create
  (`writeGuard`, the handler's cross-site check, `requireWriteRole`: a view-only client gets 403
  `view_only`; `root` required: 400, 409 once it moved), body `{path, newPath, reveal}` read
  first (8 KB) → 200 `{root, path}` (the cleaned new path); no trash needed (`caps.trash` off
  still renames). The source is checked as a delete's: `.`/`""` → 400 `invalid_path`, the deny
  lists → 403 `not_allowed`, parents opened one at a time without making any (a symlink, a
  junction or a swapped directory → 403 `symlink`, missing → 404), a regular file (409
  `not_file`, a symlink 403 `symlink`) owned by the server user (`fileOwnedByServer`, Unix; 403
  `permission`); never opened, never hashed, any number of hard links. The new path:
  `validRenameTarget` (a create's shape rules; its per-name rules only for the new base name and
  for each directory the walk has to make, so a file inside an existing directory whose name ends in a space can
  still be renamed; never a `.termote-edit-`/`.termote-rename-`/`.termote-upload-<16 hex>` name) → 400
  `invalid_name`, the deny lists → 403 `not_allowed`, missing parents made and checked again as
  a create's. A sensitive name on either side needs `reveal: true` (403 `sensitive`). Locks: the
  root's lock, both files' locks (shared with saves) in the order of their keys, one write slot
  without waiting (429 `busy`). The same path → 200, nothing done (after the source is checked);
  only the directories' case differing on a file system that ignores it → 200 with the source
  path. Never replaces: `renameat2 RENAME_NOREPLACE` / `renameatx_np RENAME_EXCL` /
  `MoveFileEx` without `MOVEFILE_REPLACE_EXISTING`; anything at the new path, a dangling symlink
  included, → 409 `exists` with `path`. A file system without the flag takes
  `linkCheckUnlink`: `linkat`, then the old name is unlinked only while it is still the file
  checked (an agent's write-then-rename over it in between is kept: the new link is removed, 409
  `changed`; accepted gap: a replacement between that check and the unlink). A new name differing
  only in case from the file itself (`SameFile` and `strings.EqualFold`) moves in two no-replace
  steps through `.termote-rename-<16 hex>` (never swept, a sensitive name); `SameFile` otherwise
  (another hard link, a name differing only in Unicode normalization) → 409 `exists`, nothing
  moved. What landed must be the file checked, or it goes back (never replacing) and 409
  `changed`; if it cannot go back, 409 `changed` with `path` (where it is now). `EXDEV` /
  `ERROR_NOT_SAME_DEVICE` → 409 `cross_device`, nothing moved, never a copy. Windows: a file
  another program holds open (`ERROR_SHARING_VIOLATION`/`ERROR_LOCK_VIOLATION`) → 409 `in_use`.
  OS errors as a create's (403 `permission`, 403 `read_only`, 507 `storage_full`). A rename drops
  the root's cached git status and file lists (`forgetRoot`); Changes shows a deleted and an
  untracked file until the user stages, as with `mv`. The PWA moves every tab, draft and Changes
  editor of the old path, in every pane of the root, to the new one, never onto a draft with
  unsaved changes (refused before sending), and offers Undo (a second rename, not offered when
  the old name fails those name rules)
- **Downloading a file** (`GET files/download?root=&path=&reveal=[&check=1]`,
  `server/files_download.go`): any regular file under the pane root, at most 100 MiB, as a download
  the browser never renders. `requireWriteRole` first (a view-only client gets 403 `view_only`,
  `check=1` too), then `begin` (`requireMethod(GET)`, the files routes' cross-site check, `nosniff`,
  `root` 409 once it moved). The path: `cleanRelPath` (`.` → 400 `not_file`), `createDenied` (the
  read deny list plus the install's data dir and the upload store → 403 `not_allowed`: such a file
  shows in Files but is not downloaded), parents through `walkParents` (a symlink, junction or
  swapped directory → 403 `symlink`, missing → 404), the file's `Lstat` (symlink/junction → 403
  `symlink`, directory, FIFO, socket or device → 400 `not_file`, never opened), a sensitive name
  without `reveal=1` → 403 `sensitive` (after the `Lstat`: a missing one stays 404), opened
  `O_NONBLOCK`, `SameFile` with the `Lstat` (409 `changed`), size from `Stat` over 100 MiB → 413
  `too_large`. It shares the 4 `files/raw` slots (429 `busy`, no wait). Headers:
  `application/octet-stream`, `Content-Disposition: attachment; filename*=UTF-8''<name>` (RFC 5987
  escaped, the base name without control or format characters, `download` when nothing is left),
  `Content-Length`, `Cache-Control: no-store`, CORP `same-origin`, and a second CSP `sandbox;
  default-src 'none'` on every answer of the route. Exactly the `Stat` size is sent (`CopyN`, 256
  KiB chunks; a file that grew sends no more), each chunk under a 2-minute write deadline and the
  whole within 30 minutes, so a client that stops reading frees its slot. One `audit: download
  path="<relative>" size by via` line (`by`: `password`, `session:<id>`, `device:<id>` or `none`; `via`:
  `session|device|basic|local|none`) right before the bytes, none for a refusal or `check=1`.
  `check=1` runs every check, takes no slot (a full pool still answers 429), sends no bytes and
  answers `{root, path, size}` (`no-store`): the PWA calls it first so each refusal gets a toast (a
  link with `download` never tells the page why it failed), then clicks a same-origin `<a
  download>`; between the check and the download a change shows as the browser's own failed
  download. In the iOS home-screen app (`isIos` and `isStandalone`), where such a link does nothing,
  the PWA skips `check=1` (the read of the bytes answers the same codes, and the tap's activation,
  about 5 s, is kept for the sheet), reads the bytes and calls `navigator.share({files})`; a
  `NotAllowedError` (the activation ran out) shows a toast whose Save shares from a new tap, closing
  the sheet is silent, and a `blob:` link revoked after 60 s is used only when `canShare` refuses
  the file. Download is in the open file's header (not for a sensitive file not shown, nor for a
  path through a link the tree has read) and on each regular file's row menu (a sensitive one asks
  first); never on a directory or a symlink row, never for a view-only client. Out of scope:
  directories, git versions, ranges
- **Reading a document to preview** (`GET files/document?root=&path=&reveal=`,
  `server/files_document.go`): the bytes of a `.pdf`, `.xlsx` or `.docx` under the pane root, for
  the PWA to parse in a worker. Read like `files/raw`'s worktree file: `begin`, `viewHides` (a
  view-only client reads it too, as it reads `files/raw` and `content`, only what git lists, and
  never with `reveal=1`, refused 403 for it as on every read route),
  `cleanRelPath`, the read deny list, `os.Root` `O_NONBLOCK` and every check on the open handle in
  `content()`'s order (missing → 404 even for a sensitive name; a sensitive name without
  `reveal=1` → 403 `sensitive`; not a regular file → 415 `not_document`). `side` is refused (400):
  Changes keeps showing these as binary. The kind comes from the name and is checked on the first
  1 024 bytes: a PDF holds `%PDF-`, an `.xlsx`/`.docx` starts `PK\x03\x04`, else 415
  `not_document`; an OLE compound file (a password-protected or IRM Office file) → 415 `encrypted`;
  a Git LFS pointer → 415 `lfs_pointer`. Over 30 MiB → 413 `too_large` with `size` in the body
  (`documentTooLargeError`). It shares the 4 `files/raw` slots (429 `busy`, "too many files at
  once"), taken through `takeRawSlot` like `files/raw`, so a view-only client never holds the last
  one. Sent by `writeDownload` (256 KiB chunks, 2-minute idle deadline each, 30 minutes in
  all) with its headers and a second CSP `sandbox; default-src 'none'` on every answer. One
  `audit: document path="<relative>" size by via` line before the bytes, none for a refusal
- **Office and PDF previews** (`pwa/src/components/document-preview.tsx` and its viewers): the
  page's CSP is not loosened for them (no `'unsafe-eval'`, no `'wasm-unsafe-eval'`, no `font-src
  data:`); every E2E spec fails on a violation of the page or of any worker
  (`pwa/e2e/fixtures.ts`). Parsing runs in workers only, each request with a timeout (30 s to load
  the worker, 20 s per request, `DocumentWorkerClient`); on timeout or failure the worker is
  `terminate()`d and the viewer says why with Download (full clients). PDF: one worker per
  document, owned by the viewer (`new PDFWorker({port})`; pdf.js never terminates a port it was
  given), ended on close, failure or a 20 s open timeout; `getDocument` gets fixed options only
  (`pdf-options.ts`: `enableXfa: false`, `useWasm: false`, `wasmUrl`/`cMapUrl`/
  `standardFontDataUrl` under `/assets/doc/pdfjs-<version>/`, `maxImageSize` 40 MP), no scripting
  manager, annotations shown but not editable, `maxCanvasPixels` 16 M; `wasmUrl` only serves the
  JS fallback decoders of JPEG 2000 and JBIG2. External links open in a new tab with `noopener
  noreferrer nofollow`; internal ones move between pages without touching `location.hash`.
  `.xlsx`/`.docx`: `zip-guard.ts` runs first in the worker and checks only what the zip declares
  (no ZIP64, no data descriptor, local header equal to the central one, no repeated name, at most
  2 000 entries, 100 MiB per entry and 200 MiB in all); what really bounds a zip bomb is the
  timeout and `terminate()`, and an entry that inflates past the worker's memory before the
  timeout ends the worker (or, at worst, the tab), never the page's data. A sheet is read by the
  cells it holds, not by the range it declares (rows up to the last with data, 201 columns), a
  row at a time until its TSV reaches 1 MiB: it reaches the table view as at most 1 MiB and 200
  columns (the size its main-thread fallback was built for), cut by rows with a note. A `.docx` is
  converted by mammoth, parsed by xmldom and filtered by an allowlist in the worker
  (`docx-sanitize.ts`: no `id`, no `#` link, `href` only `http(s)`/`mailto`, images only
  `data:image/(png|jpeg|gif|webp)`, spans 1–1000; limits of 5 Mi UTF-16 units of text, 50 000 nodes, depth
  64, 20 MiB of images); the page gets a JSON tree, checks each tag and attribute again and builds
  React elements. No `innerHTML` or `dangerouslySetInnerHTML` in `pwa/src` outside tests
- **Image uploads** (`POST /api/mux/uploads`): the PWA sends an image so an agent can read it by
  path (the host clipboard is empty when the image sits on a phone). Same auth, Host allowlist,
  `Sec-Fetch-Site`/`Origin` check and `requireWriteRole` as every write; the body is a raw
  `image/png|jpeg|gif|webp` (`writeGuard` takes these types on this path and `files/image` only: `image/*` is not
  CORS-safelisted, so another site still needs the preflight; multipart stays 415, since a form
  posts it without one). At most 10 MB (a larger `Content-Length` is refused unread); once
  authenticated and given a slot its read deadline grows to 5 minutes; the type is read
  from the first bytes and must equal the declared one; the name is random (`<32 hex>.<ext>`,
  the client's name is never read), written to a `.part` (0600, `O_EXCL`) then renamed, in
  `os.UserCacheDir()/termote/uploads` (`serveConfig.UploadDir`, set by `serve`): created 0700,
  refused when a symlink or (Unix) owned by another user, and then uploads answer 503
  `uploads_unavailable`. 2 uploads at a time (429 `busy`); 10 MB is reserved against a 200 MB
  quota before writing (507 `storage_full`); files older than 7 days go, then the oldest when
  over quota, never one younger than an hour; only the store's own names are ever deleted.
  Errors carry a JSON `code`. The Chat view sends the returned ids in `agent/message` (see
  Agent chat). `Caps.uploads` tells the PWA (snapshot); a view-only client
  gets 403 `view_only`. The container
  creates `/home/termote/.cache` and `/home/termote/.config` mode 1777 so the host uid can
  create its upload dir and the generated password's file (kept out of the log). The store is
  never served by the Files view, even when a pane's root holds it
- **Notifications / Web Push** (`/api/mux/push/*`, `caps.push`): the setting "Notify when an
  agent needs me" notifies when an agent becomes `blocked` or ends a turn (`working` →
  `done`/`idle`; a missing or `unknown` status keeps the last known one, a pane without an
  agent forgets it (tmux answers a slow lookup with the last agents found, not none), a first
  sighting never notifies; the PWA and `server/push_watch.go` share `server/testdata/agent-transitions.json`).
  `GET push/key` (auth, `hostGuard`) returns only the public key; `POST`/`DELETE push/subscribe`
  go through `writeGuard` (same-site JSON), `requireWriteRole` (a view-only client
  gets 403 `view_only`) and the 8 KB body limit, answer 200 `{ok}` (400 `invalid_endpoint`/`invalid_keys`,
  503 `push_unavailable`), and no route lists or echoes a subscription. Endpoints must be HTTPS
  on 443 at `fcm.googleapis.com`, `updates.push.services.mozilla.com`, `web.push.apple.com`,
  `*.push.apple.com` or `*.notify.windows.com` (no IP literal, no userinfo, 2048 bytes), checked
  at subscribe, at load and before each send; the dialled address must be public (`Dialer.Control`
  after DNS: no loopback, private, link-local, CGNAT, ULA, unspecified, multicast or IPv4-mapped),
  no proxy, no redirects. The payload is ids only (`{groupId, tabId, paneId, kind}`, aes128gcm,
  VAPID ES256 with `sub` `https://termote.ohnice.app` and 12 h tokens, stdlib only); `Topic` is an
  HMAC of pane and kind under a random key and `Urgency` is `high` for both kinds, so the push
  service learns neither. The service worker reads the names from the snapshot (3 s) and strips
  the characters `visibleUnsafe` marks (64 characters max); the pane's name (`Pane.Name`), when
  it has one, goes before the agent's; `Pane.Title` is never used; every push shows a
  notification (Safari revokes silent ones). State: `<stateDir>/push` (0700; `vapid.json` and
  `subscriptions.json` 0600, owner-only ACL on Windows, `%LOCALAPPDATA%` so it does not roam, no
  DPAPI), already on the Files deny list; at most 20 subscriptions, the least recently subscribed
  evicted; each bound to `gen` = HMAC(bindKey, user + password), so `start --fresh` or a new
  password drops every device until it signs in again (its page re-subscribes). One made by a
  paired device carries its id and goes when the device ends (revoke, expiry, a cascade, a reload
  that no longer finds it), and at start for a device no longer live; the password's stay. One a
  device made before this (no id) reads as the password's until its page subscribes again (on load,
  and every 10 minutes while visible), so a device revoked before that keeps receiving pushes. Only 404/410
  drop a subscription; 401/403 are logged and kept ("check the server clock" when all fail);
  429 and timeouts back the push service off (`Retry-After`, at most 1 h). The watcher runs only
  from `runServer`, every 5 s and only with a subscription, reading tmux through `peekSnapshot`,
  which reads the sessions there and never recreates the default one; the service worker names a
  push from `snapshot?peek=1`, which reads the same way. The PWA subscribes only while the active
  worker answers version 2 (`notify-sw.js` has the push handler), and repeats the subscribe POST
  on load, every 10 minutes while shown and when shown again. Log out deletes this device's subscription first.
  A click follows only a pane link (`#/s/...`): the worker keeps it in Cache Storage
  (`termote-notify`, for iOS, which drops the message to a resumed home screen app) and the page
  takes it once, kept since the page was last hidden and at most 60 s old, through
  `parseDeepLink`, and opens it as any deep link. Neither `focus()` nor `openWindow()` waits on it.
  The CSP is unchanged: the server, not the page, talks to push services. The container opens
  `/home/termote/.local/state` 1777 like `.cache`/`.config`
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
  first (400 `invalid_template` or `duplicate_name` with `index`), a name already there
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
  window is kept for the pane shown
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
- **Tasks** (`/api/mux/panes/{id}/tasks`, `/api/mux/panes/{id}/tasks/run`,
  `/api/mux/tasks/runs/{runId}`, `/api/mux/tasks[/{id}]`; `server/tasks.go`,
  `tasks_discover.go`, `tasks_tools.go`, `tasks_tools_toml.go`, `tasks_shell.go`, `tasks_run.go`, `tasks_run_state.go`, `task_store.go`,
  `task_routes.go`, `mux_{tmux,herdr,zellij}_tasks.go`; `caps.tasks`: the Files routes work and
  the backend runs tasks (`taskMux`: tmux, Herdr, Zellij; never psmux, which has no Files);
  `caps.userTasks`: the store is usable). Every route is a full client's only, reads included
  (403 `view_only`): a script's command, a user task's command and a run's output can hold a
  token or a path. **Listing** (`GET .../tasks`): `requireMethod(GET)`, then the Files routes'
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
  terminal's foreground, tmux not in copy mode): C-c clears its input line first and the shell is
  checked again; a new tab is never sent C-c (its rc files may still run) and is typed into once
  its shell is idle and its text stopped changing (up to 15 s); a shell still busy after the wait
  is 409 `shell_busy`. A new tab whose line could not be typed (`shell_busy`,
  `unsupported_shell`) stays open and is kept, shown to no client, as the task's next tab, so
  Run never piles tabs up. A user task's command is checked again before it is typed (400
  `invalid_task`: the file can be edited by hand). Zellij without a client is 409 `no_client`; a
  tab closed meanwhile 409 `tab_gone`. pwsh resets `$LASTEXITCODE` before the command and reports
  it first (`Invoke-Expression` leaves `$?` true after a failed native command). An `audit: task-run` line names the
  kind and the name (or the user task's id), never a command. **State** (`GET
  /api/mux/tasks/runs/{runId}`, same-site, `no-store`): runs live in memory only (at most 200, 24
  h; a restart forgets them: 404 `run_not_found`), checked at most every 2 s whoever asks; a
  shell still running something is `running` without its text being read; else the last 400
  lines are searched for the run's end marker (`exited` with its code); a shell back at its prompt
  for 2 s without it (the screen cleared) is `ended`, a closed pane `gone`. The markers are a hint:
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
- Exclude sensitive dirs (.ssh, .gnupg, .aws, .config/gcloud) from container volume mounts
  (warned at `container up`)
- Serve mode uses constant-time comparison for password verification
- **Brute-force protection**: built-in rate limiter (5 failed attempts/min per IP → 429, and
  20/min per IPv6 /64 so a host cannot take a new address for each try); the check and the
  count are one step, so a concurrent burst gets no more than 5 tries. With `--tailscale`, a
  password attempt over loopback that carries `Tailscale-User-Login` (`rateKey`; `tailscale serve`
  sets it for a tailnet user and removes one the client sent, not for a tagged node or Funnel)
  counts under `ts:<login>` instead of the address, so one tailnet user's typos never lock the
  others out; the header is ignored off loopback and without `--tailscale` (another proxy on
  loopback would pass a client's header through). Every attempt over loopback, whatever its key, also counts toward
  one shared cap of 30/min (`authMaxLoopbackFailures`): a local process setting the header itself
  (no owner check on macOS loopback) guesses no faster than that. A refund takes back both. A
  container behind NAT still counts under the gateway address. The pairing limiter stays per
  address. Failed logins and
  blocked clients are logged with the client address (never the credentials), at most one
  line per 10s each
- **Server hardening**: ReadHeaderTimeout (Slowloris protection), a 60s read deadline on every
  request, the terminal stream's handshake included (a body sent a byte at a time; hijacking the
  connection for the WebSocket clears it); an authenticated image upload
  extends it to 5 minutes (a slow mobile link), at most 256 sessions (the
  least recently used is dropped), request
  body size limits (8KB on `/api/mux/*`, 64KB on `agent/message`)
- **Connections from other local users** (`server/peer_user_*.go`, native only: `CheckLocalUsers`
  is set from the saved config, never for the container or an env-configured `serve`): a
  connection whose client address is loopback or one of the machine's own (`net.InterfaceAddrs`,
  30 s cache; an address not in it is another machine's only by a list whose read started after
  the connection arrived, so one added a moment ago is checked; lists are read at most once per
  100 ms, a miss waits for the next one and every miss waiting by then shares it, so a client
  cycling source addresses lists them at most that often; no address is remembered as
  remote) is checked on its first read/write, never in `Accept` (64 lookups at once, at most 4
  `sock_diag` queries of them, 2 s, else refused). Linux: `sock_diag` exact lookup, `/proc/net/tcp*` fallback, only ESTABLISHED with an
  inode (a TIME_WAIT row reads uid 0). Windows: `GetExtendedTcpTable`
  (`TCP_TABLE_OWNER_MODULE_CONNECTIONS`) owner PID and bind time; the process opened at that PID
  must be created strictly before the socket was bound (else the PID may have gone to another
  process: refused, as are equal times, both read from a clock that ticks coarsely, and a row with no
  bind time), then its token SID. This holds only if the table's PID is the process that bound the
  socket: Microsoft documents it as the process that "issued a context bind", and says nothing of a
  socket created in one process and bound or connected in another after its handle passed on, so a
  socket handed on that way before its bind is not proven to be caught (accepted residual risk, see
  `docs/security-model.md`). With `--no-auth` (and `--allow-herdr-no-auth`) on Windows this check is
  the only boundary against another user signed in to the machine, and one that passed it would get a
  shell as the server's user (accepted, written in `docs/security-model.md` and the deployment
  guide). An unreadable token is trusted only for a
  running service's own PID, from the Service Control Manager (`EnumServicesStatusEx`, read after
  the process is opened, so the PID cannot change hands; a per-user service, type bit 0x40 or 0x80,
  is not one, as it runs as whoever logged on), never for being in session 0 (an SSH logon is too)
  or a service's child (sshd's session processes are). A process that cannot be opened is refused,
  service or not: a standard user cannot open `tailscaled`, so `tailscale serve` is refused. Both times are wall-clock FILETIMEs, so the
  comparison fails closed in one direction only: a clock stepped back between a process's start and
  its bind refuses that process until it binds again, but a clock stepped back between a socket's bind
  and the start of the process that later takes its PID lets that process pass for the socket's owner
  (an administrator's or the time service's change; recorded in `docs/security-model.md`). A whole-table read (`/proc`, Windows' tables and service list) is
  shared (`tableSnapshots`): a lookup waits for the first read that starts after it asked, and
  every lookup waiting then uses that read, so a flood costs about one read per batch, not one
  per connection. Trusted: own uid/SID, root/SYSTEM (on Windows only
  with a token the server's user can read), running Windows services as above, `--allow-local-user` names (checked to exist when given; a vanished one skipped at
  start). WSL 2 mirrored: an absent loopback client with an established server end (two looks,
  10 ms) is Windows, let through; NAT goes through root's relay (accepted: every Windows user).
  Not found, closed or timed out → refused, `audit: local-user-refused` (10 s per user, 64 users),
  the first naming `--allow-local-user`. macOS: no check (accepted). On by default (breaking for
  a reverse proxy under another user); a rollback's `start` drops the saved names
- **CLI local socket** (`server/local_socket*.go`): the native server also serves on
  `<stateDir>/run/<port>.sock` (dir 0700 owned, not a symlink; socket 0600) or the pipe
  `\\.\pipe\termote-<SID>-<port>` (owner the user, named in its SDDL; ACL user + SYSTEM, remote
  refused, first instance exclusive).
  A connection there gets a context mark from its type only and is `authLocal` (full, no
  password); `hostGuard` takes `termote.local-socket` only there; audit `ip=local`. The CLI checks
  the server end's owner (`SO_PEERCRED`/`LOCAL_PEERCRED`; on Windows the owner of the pipe object
  itself, `GetSecurityInfo`, never the user of the serving PID) is itself or root/SYSTEM before
  writing, uses that one connection, falls back to TCP + password when the
  socket is missing or untrusted or a read got no answer (on Windows without the password: see the
  CLI entry below), and never resends a write that was sent. `status` prints `Via: socket`
  or `Via: TCP` (`--json`: `via`). The exit cleanup removes the socket only while it is its own and
  nothing answers on it (an update's new server keeps its socket)
- **Signed-in browsers** (`server/sessions.go`, `server/signin_routes.go`, `caps.signins`): each
  password session (memory, 24 h, 256, LRU) keeps id (16 hex of the token's SHA-256), created,
  last used (1 min), `via` (`form|basic|link`), IP and a cleaned User-Agent (200 B). Basic auth
  makes a session only for a browser (`Sec-Fetch-Mode`, a navigation, or a session cookie held).
  `GET /api/mux/signins` (same-site read, not view) → `{sessions, canRevoke}`; `DELETE
  /api/mux/signins` revokes all but the caller's (the CLI: all); `DELETE /api/mux/signins/{id}`
  (404 `unknown_session`). A device gets 403 `full_needs_password` on revokes. Revoke: store
  first, then stream tokens (`sessionID`), then streams; one mid-handshake is refused by
  `sessionAlive` under the hub lock. `audit: revoke-session ... via=cli|settings devices=<ids>`. A
  revoke ends the cookie only: a client sending Basic every request is back at once (accepted;
  `--fresh`). A code a session makes carries `session:<id>` as its creator (`pair-code by=`, the
  device's `pairedBy`); the CLI's (Basic, local socket) stays `password`, as did a session's before
  2.0.1 (no migration: such a device is not revoked with its session, and Devices and
  `termote devices` list every `password` device as kept when a browser signs out). A session that
  leaves the store without a revoke ends like one (stream tokens, streams, codes; no devices): `start`
  ends the sessions its sign-in pushed out or swept as expired, and a timer per session revokes it at
  its expiry; each is logged `audit: session-ended id reason=expired|pushed-out`. Every token's
  expiry (`tokenStore.put`) is stored without a monotonic reading, so each check compares it with the
  wall clock; the timer fires late after the host slept, and each open stream asks `sessionAlive` at
  every 15 s ping, which closes a session's stream within one ping of its expiry. Every end of a session
  (revoke, Log out) drops its waiting codes (`onEnd`, after the session left the store; `create`
  asks `sessionAlive` under the codes' lock). A revoke (not Log out) then removes, in one locked
  write, every live device whose `pairedBy` is one of the revoked sessions and every device those
  paired, ending their tokens, streams and codes; the response adds `devices` (a count). A failed
  write still leaves the session revoked and answers 500 `devices_not_revoked`. A code redeemed
  while its session is revoked pairs nothing: `add` asks `sessionAlive` under the file lock, which
  the revoke takes only after dropping the session (409 `creator_gone`, not counted).
  Session ids live in memory: an id whose session is gone (a restart, Log out, a revoke whose write
  failed) still revokes its devices on `DELETE /api/mux/signins/{id}` (`signedOut: false`, audit
  `signedOut="false"`), 404 `unknown_session` when it paired none
- **Sign-in link** (`server/login_link.go`, `server/cli_login_link.go`): `url --open` and the
  panel's open key. `POST /api/mux/login-links` → `{token, expiresIn}` for the CLI only (Basic or
  local socket, else 403 `full_needs_password`), single use, 30 s, 5 waiting. When another user's listener
  holds the port the CLI makes no token and opens the plain link with a warning (on Windows this
  rests on the table's PID even for the native server, whose token comes over its pipe but is posted
  by the browser over TCP; while the server listens, another account cannot bind its port on the same
  address or, with `--lan`, any, by Microsoft's different-account bind table, which
  `SO_EXCLUSIVEADDRUSE` does not change, so the server does not set it); otherwise it writes `<stateDir>/run/login-<16 hex>.html` (0600,
  `O_EXCL`, `no-referrer`) and opens the path; the page posts `t`/`hash` to `/login/link` (a `localhost` link posts to
  `127.0.0.1`: `::1` could be another user's listener, unseen by `lsof` on macOS)
  (urlencoded, 8 KB; the only cross-site exception is `Origin: null`). A valid token starts a
  `link` session and answers 200 + `meta refresh` (no script; a 303 would keep the navigation
  cross-site and drop the Strict cookie); a dead one shows the form, not rate limited. `safeNext`
  never returns `/login/link`; `hash` only `#` + URI-safe bytes, 512. Files older than 2 min are
  swept by the CLI and by `serve` at start. With `--no-auth` the plain link opens; with an old
  server or no password it opens with a warning saying why
- **CLI and the saved password**: on Windows the native server (any port but the saved
  container's; a port both are saved on is the container's only while no native server is registered
  or running, `installedSupervisor`, and the runtime reports the container running,
  `containerRunning`, so a failed `schtasks`, `podman` or `docker` lookup keeps the password home)
  gets the saved password over its pipe only (`cli.pipeOnly`, `server/cli_start.go`;
  `cli.tcpRequest` for `container status`): without the
  pipe, `status`, `url`, `panel` and the health wait of `start`/`restart`/`update`/`container up` ask over TCP
  without it, still only on a connection whose listeners pass the owner check below (else
  "untrusted listener" or "unverified listener", never running), and a server that answers 401
  there reads as "pipe only" (`healthPipeOnly`); `pair`, `devices`, `signins` and the sign-in link
  send nothing but a health probe without it, whose answer only tells a stopped server from a pipe
  that did not answer; `container status` on such a port tries no pipe, asks over TCP without the
  password and, on a 401, says the native server is saved there too. A server older than the pipe (2.0.0) is reached that way, and an `update` back
  to one fails its health wait and rolls back (`container up` refuses, exit 2, the native server's saved
  port while its service is registered, where its own health wait could not send the password). Otherwise, without the local socket (the container,
  on every OS; an older native server on Linux and macOS), `status`, `url`, `panel`,
  `container status`, the health wait of `start`/`restart`/`update`/`container up` and the device
  commands against the container send the saved password to `127.0.0.1:<port>` only when
  every socket listening on it runs as the current user or root/SYSTEM (`server/listener_owner*.go`:
  `/proc/net/tcp*` on Linux, `lsof` on macOS, on Windows the listener table
  `TCP_TABLE_OWNER_MODULE_LISTENER` and the token SID of the process at each owner PID, a process
  that cannot be opened, not created strictly before its socket was bound (the PID may have gone to
  another process; a clock stepped back between the server's start and its bind does it too, until a
  restart), with no bind time, or with an unreadable token, a service's included, counting as
  another user's; for the container on Windows this rests on the same reading of the table's PID as
  the local-peer check above, an accepted residual risk), checked
  once the connection is made and before the request is written on it; on Linux the server end
  of that connection (its uid in `/proc/net/tcp*`) must be trusted too; otherwise
  the status reads "untrusted listener" (another user's socket seen) or "unverified listener"
  (the port answers but no listener is seen: a runtime forwarding it without a proxy process,
  macOS without `lsof`)
- **Error sanitization**: internal errors logged server-side only, generic messages returned to clients
- **Content-Security-Policy** (`server/security_headers.go`): on every response, `script-src 'self'`
  plus the `sha256` of the inline theme script in the served `index.html` (hashed at startup,
  so a changed `TERMOTE_PWA_DIR` page needs a restart), `style-src 'self' 'unsafe-inline'`,
  `img-src 'self' data: blob:` (`blob:`: images the PWA read from `files/raw`; an SVG is shown as a `data:` URL, never a `blob:` one, which opened in a tab would be a document of this origin), `connect-src 'self'` + `ws://`/`wss://` of the request's `Host` (a
  name or IPv4) + `https://api.github.com`, `worker-src`/`manifest-src 'self'`,
  `object-src 'none'`, `base-uri`/`form-action 'self'`, `frame-ancestors 'none'`; plus
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`.
  The Mermaid sandbox page (exactly the path of a served `assets/mermaid-sandbox-*.html`, each
  hashed at startup; another spelling of the path or another name gets the app's policy, never
  framed) gets its own instead (`sandboxPolicy`): `default-src 'none'`,
  `script-src` its one inline script's `sha256` (`'none'` without the page), `worker-src blob:`,
  `base-uri`/`form-action 'none'`, `frame-ancestors 'self'` with `X-Frame-Options: SAMEORIGIN`,
  and `sandbox allow-scripts`, so it is an opaque origin even opened on its own. Its iframe's
  navigation is same-site and carries the session cookie like any page load.
  `isolationHeaders`, wrapped outside `hostGuard` so its 403 carries them too, adds
  `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin` and a
  `Permissions-Policy` turning off camera, microphone, geolocation, payment, USB, serial, HID,
  Bluetooth, MIDI and display capture (never the clipboard: paste and copy on select use it).
  Every E2E spec imports `test` from `pwa/e2e/fixtures.ts`, which fails a test on any CSP
  violation
- **Homebrew install** (`homebrewOpt`, `server/install_layout.go`): a binary is a brew install only
  when its resolved path is `<prefix>/Cellar/termote/<v>/bin/termote` (path components, not a
  substring) and `<prefix>/opt/termote/bin/termote` resolves to the same file. Then `start`
  registers the service with that `opt` path (it survives `brew upgrade`, the Cellar path does
  not), `update` refuses and names `brew upgrade termote && termote restart`, `link` writes
  nothing, `unlink` still removes only its own links, `uninstall` removes the service and leaves
  the binary to `brew uninstall`, and health reports `install: "homebrew"`. Any other layout, or
  an `opt` link to another version, runs as an unknown binary (its own path), as before
- **Release integrity**: `release.yml`'s release job runs in the `release` environment (the
  maintainer approves each release; it holds `RELEASE_SIGNING_KEY`), writes `image-digest.txt`
  (the pushed image by digest) into `checksums.txt`, signs it with `openssl pkeyutl` and checks
  the signature with the key `install.sh` pins. It also signs it as `checksums.txt.sshsig`
  (SSHSIG, namespace `termote-release`, made with openssl alone by `scripts/release-sshsig.sh`, so
  the key is only ever handed to openssl) and checks that with `ssh-keygen -Y verify` against the
  allowed-signers line `install.sh` pins (`RELEASE_SIGNER`; `install.ps1` pins the same line, and
  `TestReleaseSignerMatchesInstallers` keeps both equal to the CLI's key); the release needs 14
  assets. `update` and `install.sh` (OpenSSL 3) refuse a 1.10.0+ release whose signature does
  not verify. Without OpenSSL 3, `install.sh`, and `install.ps1` always, check the `.sshsig`
  with an `ssh-keygen` that has `-Y` (OpenSSH 8.1+; one that answers "option -- Y" counts as
  absent), refuse a bad one, and refuse a release from `FIRST_SSHSIG_VERSION` (2.14.0) without
  one; with no such `ssh-keygen`, or before that version, they print that the signature was not
  checked. Both check the archive's line in the verified `checksums.txt`; `install.ps1` writes it
  to `ssh-keygen`'s stdin byte for byte (`Invoke-Native`: `Start-Process` rewrites its lines).
  `container up` runs the image by that digest,
  and only from a signed list that names the version's own archives (`listsVersion`:
  `termote-<version>-<os>-<arch>.tar.gz|.zip`, a pre-release's not counting for its stable), so a
  genuine list and image of another release copied into a version's assets run nothing.
  Whoever can publish a release picks the unpinned target, so neither lets it skip the signature:
  without `--version`, `update` refuses a release before 1.10.0 on an install already on a signed
  one (`releaseSigned`, `server/cli_update.go`), and without `TERMOTE_VERSION`, `install.sh` and
  `install.ps1` refuse a release before 1.10.0. The `docker` job pins the binfmt (QEMU) and
  BuildKit images it builds with by digest, like the actions; a Renovate `customManagers` entry
  updates both tags and digests.
  The `homebrew` job (after `publish`, stable releases only, never a dry run) writes
  `Formula/termote.rb` only from a `checksums.txt` whose `.sig` verifies with the key `install.sh`
  pins, since brew checks nothing but the hash the formula names; it pushes with
  `HOMEBREW_TAP_DEPLOY_KEY`, a deploy key that can write to `lamngockhuong/homebrew-tap` only,
  held in the `release` environment, through ssh with GitHub's host keys from `gh api meta`
  (`StrictHostKeyChecking=yes`), and never replaces a newer version in the tap.
  `homebrew-verify` installs the pushed formula on macOS and Linux with no secret.
  The `docker` job pushes the image to GHCR by digest only, with no tag; `docker-tags`, which needs
  the release job, moves `x.y.z`, `x.y` and `latest` on GHCR and Docker Hub to that digest and fails
  when a tag names another one, and `publish` makes the draft public only after it. So a `v*` tag
  pushed without the approval moves no tag users pull through this workflow. It does not stop a
  writer: any workflow run from a ref a writer pushes (a branch or a tag, any workflow file; the
  `protect` ruleset covers `main` and `release/*` only) gets the repository's `DOCKERHUB_*` secrets
  and can ask for `packages: write`, so it can move image tags on both registries (residual risk
  accepted by the Tech Lead, 2026-10-23).
  Immutable releases are on for the repo, so assets and tags cannot change after publishing.
  `release-please.yml` starts `release.yml` with `workflow_dispatch` on the tag, never as a
  called workflow: a `workflow_call` job does not get the environment's secret (actions/runner#1490)
- **Git hooks** (`scripts/install-git-hooks.mjs`, `lefthook.yml`): `pnpm install` writes the
  `pre-commit` and `pre-push` hooks itself (`lefthook install` is never run, and `lefthook run` gets
  `--no-auto-install`, so lefthook never rewrites them; `lefthook.yml` sets `no_auto_install: true`
  for a bare `lefthook run` by hand, and the command the skip message and `CONTRIBUTING.md` give
  carries the flag too, since a branch's `lefthook.yml` may drop the key; a hook that is not lefthook's is left; with
  `core.hooksPath` set nothing is written). A hook runs lefthook, with `LEFTHOOK_CONFIG` set to the
  checked-out `lefthook.yml`, only when `git diff` (`--icase-pathspecs`: on a case-insensitive file
  system npm reads a `.NPMRC` as `.npmrc`) finds no change against `origin/HEAD`, else `main`, to a
  name git quotes (`core.quotePath=true`: a non-ASCII byte, a `"`, a `\` or a control character;
  case folds only in ASCII, and such a file system can fold a Kelvin sign onto a `k`) or to any `lefthook*`, `.lefthook*`, `.config/lefthook*`, `scripts/check-gofmt.sh`,
  `scripts/staged-files.sh`, any
  `dprint.json*`/`.dprint.json*` (dprint plugins can be programs), any `.npmrc`, any
  `pnpm-workspace.yaml`, any `.pnpmfile.*`, `package.json`, `pwa/package.json` (what `pnpm exec` and
  `npx` read) or any tracked `node_modules` (a symlink too) or file under one (git replaces an
  ignored file with a branch's tracked one, so a branch could bring its own
  `node_modules/.bin/lefthook`); otherwise, or with no such branch, it names the files on stderr and
  exits 0 without running anything. A pre-commit command gets its files from
  `scripts/staged-files.sh` (`git diff --cached`, each name one argument starting with `./`), never
  from a lefthook file template (`{staged_files}`): lefthook on Windows puts `run` into a
  double-quoted `sh -c` command line without escaping, and its quoting of a name holding a `'` adds
  double quotes that end it, so the rest of the name would run as shell code (a test refuses any
  file template in `lefthook.yml`). A name git has to quote (a `"`, a `\` or a control character) is
  refused, not passed on as a path that matches nothing; on Windows (`OS=Windows_NT`, or `uname -s`
  `MINGW*`, `MSYS*`, `CYGWIN*`, `Windows_NT*`, and a `uname` that fails or prints nothing) so is a
  name holding a character cmd.exe reads (`& % ^ ! | < > ( )`), since `pnpm exec` and `npx` can run
  the command through a `.cmd` shim, which puts its arguments in an `IF ( ... ) ELSE ( ... )` block
  and whose escaping depends on the npm and cross-spawn versions; names go in batches of at most 7000 bytes
  (a longer single name runs alone), as lefthook split its own. `go vet` runs with
  `CGO_ENABLED=0` (as releases build; `server/` has no cgo), so it compiles no C code from
  `server/*.go`, which are not hook files (a test refuses a `go` command without it). A clone whose
  hooks `lefthook install` wrote before 2.2.0 runs them unchecked until `pnpm install` runs once
  (`CONTRIBUTING.md` says so). `pnpm install` itself runs the branch's `package.json` scripts
  (accepted: a maintainer reads that diff first, `CONTRIBUTING.md`)
- **Tailscale mapping**: `serve` removes its `tailscale serve` mapping when it stops (only while
  it still proxies to its port), so the name never leads to a free port another user could take;
  `start --lan` warns when lingering is off (the port is free while the user is logged out)
- **Config persistence**: the saved password is AES-256-CBC with an HMAC, keyed by a random
  per-install `secret` file (0600) on Unix, DPAPI on Windows; the config file is also chmod
  600. The password is never written to the systemd unit, launchd plist, Scheduled Task or any
  process command line; print it again with `termote show-password`.
