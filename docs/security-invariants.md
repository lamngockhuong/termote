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
  same-site (`Sec-Fetch-Site`/`Origin` on the allowlist) with `Content-Type: application/json`
- **Terminal stream** (`/api/mux/stream`): same Origin check plus a single-use, 30s-TTL token
  fetched via `/api/mux/stream-token`, consumed on WebSocket upgrade. Every paste into the
  terminal (native paste events are taken in capture phase, ahead of xterm) goes through
  `cleanPaste` in `terminal-view.tsx`: end-of-paste markers and control characters other than
  tab and line breaks removed, since xterm brackets a paste without removing a marker inside it
- **Herdr guard**: `--mux herdr --no-auth` is refused unless `--allow-herdr-no-auth` is also
  given, since Herdr exposes every workspace on the host
- **Pane processes** (`server/mux_process.go`): the snapshot carries each pane's foreground
  process `{name, cwd}`; tmux tabs also carry every pane's in `processes` (the snapshot holds
  only the window's active pane). The name is the first word of what the OS reports (cut at
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
  confirmations; the cwd is not shown
- **Paired devices** (`server/device_*.go`, `server/pair_page.go`, `server/cli_devices.go`,
  `caps.devices`): a device signs in with a one-time code instead of the password and gets its own
  cookie `termote_device_<8 hex of the store id>` (`HttpOnly`, `SameSite=Strict`, `Secure` on HTTPS,
  400 days, never reissued; the id keeps two servers on one host name from clearing each other's).
  The token is 32 random bytes, `tmd_` + base64url, shown once; only its SHA-256 is stored, in
  `<stateDir>/devices/` (0700; `key.json`, `devices.json` 0600, owner-only ACL on Windows), at most
  50 devices (409 `too_many_devices`), name 1–64 bytes. Each record carries `gen` = HMAC(store key,
  user + password): another password makes a record ignored in memory, never deleted (a manual
  `serve` with another password must not end every device); only `start --fresh` removes them from
  disk. Every write rereads the file and applies one operation; a lookup stats it at most each
  second, so a second process sees a revoke; `lastUsedAt` reaches disk each 5 minutes. `--no-auth`
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
  store's `onReload` after each change or reload) closes its streams, stream tokens and codes; expired
  records stay listed (`expired`) until revoked; the cookie's `MaxAge` stays 400 days. Lineage:
  `pairedBy` (`password` or the maker's id; absent in older records, listed `unknown`); only the
  password (session, Basic: the CLI) makes a `full` code, a device gets 403 `full_needs_password`
  (also with Basic credentials as well: the device cookie is tried first). The maker must be live
  and valid in the very write that adds the device (`errCreatorGone`; `/pair` says "This code is no
  longer valid", not counted), and `codes.create` refuses a maker no longer `alive`. The DELETE
  route revokes the device and every live record it paired in one write (`revokeCascade`, one
  level) and answers `{ok, revoked}`; Log out and a view device paired again revoke only it. Audit:
  `auditf` (`server/audit_log.go`) logs `audit: <event> k="v"` (values `strconv.Quote`d, never a
  token, code, password or cookie) for `pair-code`, `pair`, `revoke` (`by`, `via`, `cascade`),
  `device-expired` (once per id and process) and `login via=form`; Basic sign-ins are not logged.
  What this does and does not protect: `docs/security-model.md`
- **Pane text** (`GET /api/mux/panes/{id}/text?lines=N` → `{text, lines, truncated, more}`,
  `server/mux_pane_text.go`, `caps.paneText`: tmux, never psmux, and Herdr): a same-site read
  (`crossSiteRejection`, `Sec-Fetch-Site: none` included, as the snapshot), `requireMethod(GET)`,
  then `requireWriteRole` (a view-only client gets 403 `view_only`: its role shows the screen,
  never the history; the PWA copies it from the xterm.js buffer). `lines` 1–5000, default 1000,
  else 400 `invalid_lines`, checked before the backend is called. tmux: `capture-pane -p -J -S
  -<lines> -t` the exact window target (no `-e`, so no escapes), a missing window → 400; psmux →
  501 `unsupported` (its targets never match exactly). Herdr: `pane.read` `{pane_id, source:
  recent_unwrapped, lines, format: text}` after `requirePane`, `invalid_request` (an older Herdr)
  → 501. `more` (history rows past `lines`: tmux `#{history_size}`, Herdr `pane.get`) offers Load
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
  commands, snapshot, push key and `worktrees` GET are allowed; `agent/prompt` carries no
  `promptId`; `GET agent/start` and `files/content?hash=1` are 403; Files/Changes routes only when
  the pane root is a git toplevel, never with `reveal=1` (`requireFilesRead`), and `files/find`
  ignores `fresh=1`. The snapshot uses `peekSnapshot` (tmux does not recreate the default session).
  A view stream drops every input frame, `resize` and `drive`; tmux attaches `-E -r` to the
  session's active window only (another `pane` → 403; tmux ≥ 3.2, older tmux and psmux → 501,
  `caps.viewStream` false), Herdr only `observe`s. Limits: 2 streams and 4 waiting stream tokens
  per view device; a view stream or token never evicts a full one (full evicts view first; a full
  hub with no view stream to evict → "too many viewers"). The PWA hides every write control and
  shows "View only" (`caps.role`); tmux follows each session's active window, Herdr selects tabs
  client-side but cannot scroll history. No Web Push. A view client reads whatever the agent
  printed (accepted), except a sensitive file's tool results in the transcript (see Agent chat)
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
  `muxTimeout` for another group change gets 503 `busy`. Closing a group ends every process in it
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
  never returned). The snapshot keeps Herdr's tab order (`number` is a creation number). tmux
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
  is kept. The snapshot's `worktree: {linked, branch?}` comes from `session.snapshot`'s
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
  keep working; any other session is tmux's own session id: group `$3`, tab/pane `$3:1`, which
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
- **Agent chat** (`/api/mux/panes/{id}/agent/*`): for Claude Code on tmux the server reads only
  the transcript in the Claude config dir of the process found in the pane (`CLAUDE_CONFIG_DIR`,
  else `~/.claude`; psmux: `%USERPROFILE%\.claude`), and only for a process whose start time
  matches its session file's `procStart`; Herdr reports the session id itself, read from the
  server user's config dir. The session id must be a UUID. Every write (Claude Code or Codex)
  takes a lock on the pane, re-checks the process, session and screen, and sends nothing unless
  the screen shows the expected state (an empty input box, the dialog the client saw with a
  single-use `promptId`). Claude Code writes its transcript only with the first message: until
  then `transcript` answers an empty conversation whose cursor names the session, so the Chat
  view can send it.
  `agent/message` may carry `images`: at most 5 upload ids, each resolved through the upload
  store (a path is never taken from the client; unknown ids → 400 with the bad ids, no store →
  503 `uploads_unavailable`). Each path is pasted alone and the draft must show that many
  `[Image #N]` tokens (11s wait each) before the next, then the text, then Enter, with the
  process and session re-checked between pastes. If a step fails after the first paste, the
  box is cleared with one `C-c` only when the same idle agent shows nothing but what this
  request pasted; otherwise 409 `partial_paste` and nothing is touched.
  Markdown images in the Chat view never load (shown as links), and raw HTML is not rendered.
  A tool call carries `detail` for its card: the model's description, a Bash/Codex command whole
  (8 KiB) and an Edit/MultiEdit/Write's old and new text (16 KiB per call); the edits of a file
  `isSensitive` names are left out (`hidden`), as its diff is in Changes. A view-only client also
  gets no result of a Claude Code tool call on such a file (the call's `file_path`/`notebook_path`/
  `path`, or the result row's `toolUseResult` file path): `Result` emptied and `hidden` set, on a copy of
  the cached read; a Grep over a directory, Bash and Codex output that prints one is not keyed (accepted).
  `agent/commands` (the composer's `/` suggestions; Codex: its skills, see Codex chat) returns
  only names, descriptions, sources and kinds of `.claude/commands`/`.claude/skills` under the
  pane root and `commands`/`skills`
  in that config dir, read through `os.Root` (first 8 KB per file; a file that is a symlink, under
  a denied dir or with a sensitive name is never read), with the same
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
  `codex` process the server's user can open with `PROCESS_DUP_HANDLE` are duplicated, with
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
  only onto an empty composer with no working line and status idle/done, and must show in the
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
  Codex and for every agent on psmux (Claude Code on tmux and Herdr: 2 s), still polling; the
  message route's budget and read deadline grow with it. An approval dialog
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
  own list takes the Enter): `.codex/skills`/`.agents/skills` under the pane root (`project`),
  `CODEX_HOME/skills` and `~/.agents/skills` (`user`), `CODEX_HOME/skills/.system` and
  `/etc/codex/skills` (`system`), each through `readSkillDir` under the Claude Code rules
  (`os.Root`, 8 KB, no file symlink, the files routes' skip); a symlinked skill dir is followed
  only into those dirs or the root (a Windows junction too, with the Windows rules above). Custom prompts (gone from Codex), plugin skills,
  `config.toml` toggles, project trust and nested skill dirs are not read
- **Files/Changes** (`/api/mux/panes/{id}/files/*`): GETs that also check
  `Sec-Fetch-Site`/`Origin` (and one write, `PUT files/content`, below); every path is opened through `os.Root` under the pane's root (its
  git toplevel when a `.git` sits at it, else its directory); termote's config/state dirs, the
  upload store and the trash (a pane in the home dir would otherwise serve a deleted `.env` under
  its random name),
  `/proc`, `/sys`, `/dev`, `.git` and the repo's git dir (`--separate-git-dir`) are never served
  (on Linux a path differing only in case is denied when its directory is the same one: WSL
  `/mnt/c`, casefold, vfat);
  sensitive names (`.env`, keys, ...) return contents or a diff only with `reveal=1`. git runs
  without a shell, with `GIT_*`/`TERMOTE_*` stripped, hooks (`core.hooksPath` to the null
  device), index refresh on diff, fsmonitor, filter drivers, external diff and textconv off,
  submodules ignored, 10s timeout, 2 at a time.
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
  (429 `busy`), 2-minute write deadline, `Cross-Origin-Resource-Policy: same-origin`,
  `Cache-Control: no-store`; an SVG also gets a second CSP
  (`sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:`) and
  `Content-Disposition: attachment`
- **Mermaid diagrams** (`pwa/src/utils/mermaid-render.ts`, `mermaid-block.tsx`): a `mermaid`
  fenced block of a previewed Markdown file is drawn in the PWA only, as an `<img>` whose `src` is
  a `data:image/svg+xml` URL, so no script runs, no link navigates and nothing it names loads;
  the SVG string never enters the DOM. Mermaid itself draws into a stage it needs for text
  metrics: an off-screen `div` (`opacity:0`, `inert`, `aria-hidden`, `contain:strict`) in `body`,
  removed after each render with every node Mermaid added to `body` (its measuring `svg`, `#cy`,
  `.mermaidTooltip`), errors included; DOMPurify only cleans the string it returns. Config:
  `securityLevel: 'strict'`, `htmlLabels: false`, `layout: 'dagre'`, `suppressErrorRendering`,
  the app's theme and font, `maxEdges` 500, all listed in `secure` (with `themeCSS`,
  `themeVariables`, `flowchart`, `look`, `dompurifyConfig`, ...) so a `%%{init}%%` directive or
  front matter `config:` of the file cannot change them. Never rendered (shown as code with a
  reason): over 50 KB; a shape with `img:`/`icon:` (Mermaid would fetch that URL with this
  origin's cookies: a source with `@{` followed anywhere by `img`, `icon` or a backslash is
  refused, and the parsed nodes are checked again); a syntax error; 10 s past the start of its
  own render (Mermaid cannot be stopped, the next diagram waits for it); a chunk that fails to
  load. One render at a time, only near the viewport, 50 results cached by source and theme.
  Mermaid and every chunk only it reaches stay out of the precache (`pwa/build/precache-split.ts`
  in `manifestTransforms`, checked both ways, else the build fails; `.vite` is deleted from the
  build so the server never embeds Vite's manifest); a runtime `CacheFirst` (`lazy-chunks`,
  same-origin `/assets/*.js`) keeps them once fetched. Accepted: a large diagram holds the main
  thread for seconds (a 50 KB sequence diagram: about 5 s)
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
  (`visibleUnsafe` path, or "Mermaid diagram N"), never text from the file
- **Saving a file** (`PUT files/content?root=`, `server/files_write.go`): replaces the whole text
  of an existing file (a new one comes from `POST files/create`, see Creating a file). `writeGuard` (same-site JSON) plus the handler's own cross-site check and
  `requireWriteRole`; the `root` query is required (400, 409 once it moved). Body
  `{path, baseHash, text, reveal}`: bytes on disk other than `baseHash` (GET `content`'s `hash`,
  sha256) → 409 `changed`, unless they already equal the text (200: a repeated save is no
  conflict); never an overwrite. The read's path checks plus a write-only deny list (the
  install's data dir, the upload store); a sensitive name needs `reveal: true` (403
  `sensitive`). No component of the path may be a symlink; the parent is opened once through
  `os.Root` and used for every step. The file must be regular, one link, owned by the server user
  (Unix), owner-writable, UTF-8 without NUL, line breaks all `\n` or all `\r\n` (422
  `not_editable` + `reason`, or 403 `permission`; writing the new text on a read-only mount → 403
  `read_only`, on a full disk or quota → 507 `storage_full`, as a create); GET `content` reports the same check as
  `editable`/`notEditable`. Text arrives with `\n` (a `\r\n` file gets them back), NUL or a lone
  `\r` → 422 `not_text`, at most 1 MiB (413 `too_large`); body limit 6 MiB + 64 KiB, 2 saves at a
  time (429 `busy`), read deadline 5 minutes once authenticated with a slot. Written to
  `.termote-edit-<random>` in the same directory (`O_EXCL`, mode set on the handle, `fsync`),
  the file read again, then renamed over it; the temporary file goes on any failure, ones older
  than 10 minutes are swept (only names of that exact form), every `.termote-edit-*` name is
  sensitive, and a save drops the root's cached git status. Saves of one file are serialised; an agent writing between the last read and the rename still loses its change (no
  compare-and-swap), and the rename drops ACLs/xattrs. A view-only client gets 403 `view_only`. The draft stays in the PWA's memory, never in
  browser storage
- **Creating a file** (`POST files/create?root=`, `server/files_create.go`): an empty file and
  the directories missing above it (0666/0777 under the umask; directories made before a later
  failure stay, as with `mkdir -p`); the text then goes through `PUT files/content`. Same guards
  as a save (`writeGuard`, the handler's cross-site check, `requireWriteRole`, `root` required:
  400, 409 once it moved); the body (`{path, reveal}`, 8 KB) is read first, and its read deadline
  stays 60s; 201 `{root, path}`. The name is checked
  before the disk is touched (400 `invalid_name`): no empty component, at most 32 components and
  1024 bytes, 255 a component, none ending in a dot or a space, no control character, no
  `<>:"|?*` on Windows, not a
  `.termote-edit-<16 hex>` name, then `cleanRelPath`. Deny dirs, `.git`/the git dir and the
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
- **Finding a file** (`GET files/find?q=&root=&ignored=1&exclude=…&fresh=1`,
  `server/files_find.go`): the GET guards of the other files routes; only names are sent, as
  the tree does. `q` is trimmed, 1–256 bytes; `exclude` (repeated) is at most 50 directory
  names of at most 255 bytes, never `.`/`..` nor holding `/ \` NUL `* ? [` (400
  `invalid_exclude`), compared without case on Windows/macOS. In a repo the list is
  `git ls-files -co --exclude-standard --deduplicate -z` less `ls-files -d` (files gone from the
  disk) and less what git lists as a directory (a nested repo, a submodule); tracked files are
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
  delete and a restore, and by `fresh=1` (the PWA's refresh)
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
  `changed`). A record `<32 hex>.json` (`{root, path, kind, deletedAt, size, mode}`, `.part`
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
  never replacing (409 `exists` with `path`; `cross_device`); the trash's mutex is held from
  reading the record again to removing it. The sweep (at start and before every delete) ages an
  entry by `deletedAt` only, never the mtime a rename keeps: 7 days, then the oldest past 1 GiB,
  never one younger than an hour; names left half done (a payload or a record alone, a `.part`)
  go 10 minutes after the sweep first sees them; a payload that is the restored file itself (a
  `linkat` restore that died) is only unlinked; only `^[0-9a-f]{32}(\.json(\.part)?)?$` names
  are removed, never through a directory or a symlink. `GET files/content?hash=1` answers
  `{root, path, size, hash}` with no text for any regular file (no `hash` past 512 MiB), even a
  sensitive one not revealed, so deleting a `.env` never sends its secret to the browser
  (accepted risk: a short secret's hash can be guessed by a signed-in user, who has a shell);
  it takes one of the 4 `files/raw` slots (429 `busy`). `termote uninstall` keeps the trash
  (the user's files) and says where; `--purge` removes it. A view-only client gets 403 `view_only`
  for deletes and restores, and `content?hash=1`
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
  still be renamed; never a `.termote-edit-`/`.termote-rename-<16 hex>` name) → 400
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
  path="<relative>" size by via` line (`by`: `password`, `device:<id>` or `none`; `via`:
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
- **Image uploads** (`POST /api/mux/uploads`): the PWA sends an image so an agent can read it by
  path (the host clipboard is empty when the image sits on a phone). Same auth, Host allowlist,
  `Sec-Fetch-Site`/`Origin` check and `requireWriteRole` as every write; the body is a raw
  `image/png|jpeg|gif|webp` (`writeGuard` takes these types on this path only: `image/*` is not
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
  C0/C1, bidi and zero-width space characters (64 characters max); `Pane.Title` is never used; every push shows a
  notification (Safari revokes silent ones). State: `<stateDir>/push` (0700; `vapid.json` and
  `subscriptions.json` 0600, owner-only ACL on Windows, `%LOCALAPPDATA%` so it does not roam, no
  DPAPI), already on the Files deny list; at most 20 subscriptions, the least recently subscribed
  evicted; each bound to `gen` = HMAC(bindKey, user + password), so `start --fresh` or a new
  password drops every device until it signs in again (its page re-subscribes). Only 404/410
  drop a subscription; 401/403 are logged and kept ("check the server clock" when all fail);
  429 and timeouts back the push service off (`Retry-After`, at most 1 h). The watcher runs only
  from `runServer`, every 5 s and only with a subscription, reading tmux through `peekSnapshot`,
  which reads the sessions there and never recreates the default one; the service worker names a
  push from `snapshot?peek=1`, which reads the same way. The PWA subscribes only while the active
  worker answers version 2 (`notify-sw.js` has the push handler), and repeats the subscribe POST
  on load, every 10 minutes while shown and when shown again. Log out deletes this device's subscription first.
  The CSP is unchanged: the server, not the page, talks to push services. The container opens
  `/home/termote/.local/state` 1777 like `.cache`/`.config`
- Exclude sensitive dirs (.ssh, .gnupg, .aws, .config/gcloud) from container volume mounts
  (warned at `container up`)
- Serve mode uses constant-time comparison for password verification
- **Brute-force protection**: built-in rate limiter (5 failed attempts/min per IP → 429, and
  20/min per IPv6 /64 so a host cannot take a new address for each try); the check and the
  count are one step, so a concurrent burst gets no more than 5 tries. Failed logins and
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
  30 s cache) is checked on its first read/write, never in `Accept` (4 lookups at once, 2 s, else
  refused). Linux: `sock_diag` exact lookup, `/proc/net/tcp*` fallback, only ESTABLISHED with an
  inode (a TIME_WAIT row reads uid 0). Windows: `GetExtendedTcpTable` owner PID → token SID; an
  unreadable token in session 0 is a service. Trusted: own uid/SID, root/SYSTEM, session 0
  services, `--allow-local-user` names (checked to exist when given; a vanished one skipped at
  start). WSL 2 mirrored: an absent loopback client with an established server end (two looks,
  10 ms) is Windows, let through; NAT goes through root's relay (accepted: every Windows user).
  Not found, closed or timed out → refused, `audit: local-user-refused` (10 s per user, 64 users),
  the first naming `--allow-local-user`. macOS: no check (accepted). On by default (breaking for
  a reverse proxy under another user); a rollback's `start` drops the saved names
- **CLI local socket** (`server/local_socket*.go`): the native server also serves on
  `<stateDir>/run/<port>.sock` (dir 0700 owned, not a symlink; socket 0600) or the pipe
  `\\.\pipe\termote-<SID>-<port>` (ACL user + SYSTEM, remote refused, first instance exclusive).
  A connection there gets a context mark from its type only and is `authLocal` (full, no
  password); `hostGuard` takes `termote.local-socket` only there; audit `ip=local`. The CLI checks
  the server end's owner (`SO_PEERCRED`/`LOCAL_PEERCRED`/pipe server token) is itself or
  root/SYSTEM before writing, uses that one connection, falls back to TCP + password when the
  socket is missing or untrusted or a read got no answer, and never resends a write that was sent. `status` prints `Via: socket`
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
  `sessionAlive` under the hub lock. `audit: revoke-session ... via=cli|settings`. A revoke ends the
  cookie only: a client sending Basic every request is back at once (accepted; `--fresh`)
- **Sign-in link** (`server/login_link.go`, `server/cli_login_link.go`): `url --open` and the
  panel's open key. `POST /api/mux/login-links` → `{token, expiresIn}` for the CLI only (Basic or
  local socket, else 403 `full_needs_password`), single use, 30 s, 5 waiting. When another user's listener
  holds the port the CLI makes no token and opens the plain link with a warning; otherwise it writes `<stateDir>/run/login-<16 hex>.html` (0600,
  `O_EXCL`, `no-referrer`) and opens the path; the page posts `t`/`hash` to `/login/link` (a `localhost` link posts to
  `127.0.0.1`: `::1` could be another user's listener, unseen by `lsof` on macOS)
  (urlencoded, 8 KB; the only cross-site exception is `Origin: null`). A valid token starts a
  `link` session and answers 200 + `meta refresh` (no script; a 303 would keep the navigation
  cross-site and drop the Strict cookie); a dead one shows the form, not rate limited. `safeNext`
  never returns `/login/link`; `hash` only `#` + URI-safe bytes, 512. Files older than 2 min are
  swept by the CLI and by `serve` at start. With `--no-auth` the plain link opens; with an old
  server or no password it opens with a warning saying why
- **CLI and the saved password**: without the local socket (the container, an older server),
  `status`, `url`, `panel`, `container status` and the health
  wait of `start`/`restart`/`update` send the saved password to `127.0.0.1:<port>` only when
  every socket listening on it runs as the current user or root/SYSTEM (`server/listener_owner*.go`:
  `/proc/net/tcp*` on Linux, `lsof` on macOS, the TCP table and process SID on Windows), checked
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
  `isolationHeaders`, wrapped outside `hostGuard` so its 403 carries them too, adds
  `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin` and a
  `Permissions-Policy` turning off camera, microphone, geolocation, payment, USB, serial, HID,
  Bluetooth, MIDI and display capture (never the clipboard: paste and copy on select use it).
  Every E2E spec imports `test` from `pwa/e2e/fixtures.ts`, which fails a test on any CSP
  violation
- **Release integrity**: `release.yml`'s release job runs in the `release` environment (the
  maintainer approves each release; it holds `RELEASE_SIGNING_KEY`), writes `image-digest.txt`
  (the pushed image by digest) into `checksums.txt`, signs it with `openssl pkeyutl` and checks
  the signature with the key `install.sh` pins. `update` and `install.sh` (OpenSSL 3) refuse a
  1.10.0+ release whose signature does not verify; `container up` runs the image by that digest.
  Immutable releases are on for the repo, so assets and tags cannot change after publishing.
  `release-please.yml` starts `release.yml` with `workflow_dispatch` on the tag, never as a
  called workflow: a `workflow_call` job does not get the environment's secret (actions/runner#1490)
- **Tailscale mapping**: `serve` removes its `tailscale serve` mapping when it stops (only while
  it still proxies to its port), so the name never leads to a free port another user could take;
  `start --lan` warns when lingering is off (the port is free while the user is logged out)
- **Config persistence**: the saved password is AES-256-CBC with an HMAC, keyed by a random
  per-install `secret` file (0600) on Unix, DPAPI on Windows; the config file is also chmod
  600. The password is never written to the systemd unit, launchd plist, Scheduled Task or any
  process command line; print it again with `termote show-password`.
