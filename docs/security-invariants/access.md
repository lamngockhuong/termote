# Security invariants: Access

Part of the [security invariants](README.md): who gets in and as what: config, sign-in, cookies, guards, devices, roles, local connections.

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
  host name of its own (accepted risk; no `__Host-` prefix, which would not change that). A
  sibling subdomain can set a `termote_session` for the parent domain with a longer path, which
  the browser sends first: every cookie of that name is tried, not only the first, so it cannot
  hide this host's own and keep the user at the sign-in form, and Log out ends each one it carries;
  the device cookie the same: every copy is tried, it is cleared only when none names a device that
  can sign in, and Log out revokes each device its copies name. Copies that name more than one live
  device sign the request in as none of them (nothing is cleared): the request cannot tell this
  host's own copy from one a sibling planted with the token of a device of its own, which would
  otherwise run a full browser's requests as that (perhaps view-only) device
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
  working as the LAN IP changes + the Tailscale name + the Cloudflare hostname (`--cloudflare`) +
  `--allow-host` entries, with no wildcard to disable the check. The 403 never names the
  `--allow-host` command: a DNS-rebinding page receives it in the victim's own browser, from loopback
  or the LAN like the user, and would get termote to vouch for the command that lets it in. The
  command goes to the server log only (`rejected request for host`, at most one line per 10 s),
  and only for a name of letters, digits, `-`, `.` and `:` that does not start with `-`, so a
  Host header cannot put shell syntax into a line the user may paste
- **Write/CSRF guard** (`writeGuard`): state-changing `/api/mux/*` requests must be
  same-site (`Sec-Fetch-Site`/`Origin` on the allowlist) with `Content-Type: application/json`;
  only the paths `/api/mux/uploads` and `.../files/image` (`isFilesImagePath`, anchored, on the
  decoded path) take a raw `image/png|jpeg|gif|webp` body instead (their handlers take POST only),
  any other type there → 415 `unsupported_image`; and `.../files/upload` (`isFilesUploadPath`,
  anchored) without `check=1` takes a raw `application/octet-stream` body only, any other type
  there (a form's `multipart/form-data`, `text/plain` or urlencoded, which need no preflight) → 415
  `unsupported_type`
- **Terminal stream** (`/api/mux/stream`): same Origin check plus a single-use, 30s-TTL token
  fetched via `/api/mux/stream-token`, consumed on WebSocket upgrade. The token store holds 32
  (`maxStreamTokens`); a new full-role token pushes out the oldest, but one asked for with Basic
  credentials alone never does (`tokenInfo.noPush`, 429 `busy` instead): over plain HTTP a browser
  sends no `Sec-Fetch-Site`, so the route's cross-site check cannot see another site's page, and it
  attaches saved Basic credentials to that page's `no-cors` request. Every paste into the
  terminal (native paste events are taken in capture phase, ahead of xterm) goes through
  `cleanPaste` in `terminal-view.tsx`: end-of-paste markers and control characters other than
  tab and line breaks removed, since xterm brackets a paste without removing a marker inside it.
  The hub holds 16 streams server-wide on Herdr outside Windows (`maxStreamsFor`, its layout view
  streams up to 4 panes of a tab), 8 on every other backend (`maxStreams`); past it a full stream
  evicts the oldest view stream first, then the oldest stream (4001). A stream closed with 4001
  never reconnects by itself, a pane of the layout view included: that pane shows Reconnect in
  its own box, the layout stays, and no other stream opens (two devices never evict each other
  in a loop). The `{"type":"layout"}` frame carries nothing but its type. A new stream reads no input
  (keys, resize, drive, visible) before the terminal's first output, at most `streamInputHold` (3 s): an
  attach client not reading yet would drop it. A stream forwarded to a
  machine (`/api/machines/{id}/mux/stream`) is registered in a hub of its own (32, never evicting this
  server's), linked to the main one: a device revoke, a sign-out and shutdown close it, and a 15 s
  recheck closes it once its device or session is gone from the store or expired; its token is the
  machine's, consumed there. The PWA (`pwa/src/utils/spare-stream-token.ts`, the server unchanged)
  of a client whose snapshot says `caps.role` `full`, or has no `caps.role` (a server without
  sign-in: one with sign-in names every client's role, and a machine is always given one; never a
  view-only device, never before a snapshot's caps are in), keeps at most one unused token,
  fetched with a single request (no retry, given up after 5 s) after a stream opens, never on a timer, and used for the
  next stream only while younger than 20 s; there is no route to give one back, so a page has at
  most that one spare plus what is left of the 30 s TTL of one it dropped as too old. A stream
  refused before it opened with a spare is retried once at once with a token fetched then, not
  again: a server that stays down costs one request more than before, not one per retry
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
  cookie (every copy of the name, as for the session cookie) → Basic; a session wins over a device
  cookie, and cookies none of which names a record that can sign in are cleared.
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
  already signed in as a session or full device, or whose cookies name more than one live device,
  → 409, never downgraded and its cookie never replaced; a view-only device paired
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
- **View-only role** (`server/auth_role.go`, `caps.role` = `full|view`, `caps.viewStream`): Basic,
  session and `--no-auth` are always `full`; a device carries its role, and a role other than
  `full` (empty, unknown) reads as `view`. Another termote over the machine bridge (`authMachine`) carries the role
  its `X-Termote-Role` names, `view` without one; the main server sends the role of the request it
  forwards, so a view-only device is view-only on every machine. `basicAuth` refuses every
  non-GET/HEAD/OPTIONS method of a view-only client on any path (403 `{"error", "code":
  "view_only"}`) before a handler runs, except `POST /api/mux/logout`; handlers repeat it with
  `requireWriteRole`, so a route added later is closed without remembering to. Reads: transcript,
  commands (the pane's project commands and skills only where Files would show them: none under a
  root Files hides from view-only, else only files git tracks, `projectView`; the user's and the
  plugins' stay), snapshot (`viewSnapshot`: no tmux default session, and Herdr is not started), push key and `worktrees` GET are allowed; `agent/prompt` carries no
  `promptId`, body, options or free-text option, a form's fields by key, type and title only, and no
  title taken from the dialog's text rather than its header (a Claude dialog's title is kept only
  when it is a question's or one of `claudeDialogHeaders`, since a rule the text draws at column 0
  can pass for the top edge; `viewCard`: these can hold the tool's
  input, the command or the file and its new content, and the card is read for any pane, not only
  one the view stream can show; its `activity` is the same as for `full`). Through the machine proxy
  the remote machine builds the card, so a machine on 2.29.1 or older still sends the whole card to
  a view-only device signed in here (accepted, Tech Lead 2026-11-19: it closes when the machine
  updates); `GET agent/start` and `files/content?hash=1` are 403; a Place never (`place=` → 403
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
  only, so a file deleted from the worktree but still in the index shows its diff, but never the
  entry of an untracked file: `diff` and `serveImageVersion` refuse it, `trackedOnly`, from the
  entry they read; nor what only `HEAD` still holds, as with the last commit: the staged diff of a
  file deleted or removed from the index (`git rm --cached`) or of a rename, and the staged old
  side of such an image, are 404 as if missing, `leftIndex`); `files/changes` leaves out, for a view-only client, every untracked entry and
  every entry `viewHides` would refuse; `agent/touched` gives it only the files of that list it may read, by name
  (see Files a session touched in [`agents.md`](agents.md)); names match
  exactly as git lists them (never folded: a case-sensitive volume on macOS keeps an ignored
  `notes.md` beside a tracked `Notes.md` hidden); anything else is 404 as if missing, a list cut
  short (`findMaxPaths`, git's output cap) refuses what it lacks, and a list that cannot be read
  refuses the request. The snapshot uses `peekSnapshot` (tmux does not recreate the default session).
  A view stream drops every input frame, `resize`, `drive` and `visible` (so it never counts as a
  viewer: no `herdr.seen`, no seen turn in the activity tracker); tmux attaches `-E -r` to the
  session's active window only (another `pane` → 403; tmux ≥ 3.2, older tmux and psmux → 501,
  `caps.viewStream` false), Herdr and hc only `observe`. Limits: 2 streams and 4 waiting stream tokens
  per view device; a view stream or token never evicts a full one (full evicts view first; a full
  hub with no view stream to evict → "too many viewers"). The PWA hides every write control and
  shows "View only" (`caps.role`); tmux follows each session's active window, Herdr selects tabs
  client-side but cannot scroll history. No Web Push. A view client reads whatever the agent
  printed in the terminal (accepted); its Chat view gets the user's and the agent's words only, no
  tool call, input or result and no command output, while an open dialog's card, read for any pane,
  shows its kind and header title, without the body, the options or anything else that can hold the
  tool's input (`viewCard`, above; see Agent chat in [`agent-chat.md`](agent-chat.md))
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
  loopback would pass a client's header through). With a proxy client header (`--proxy-client-header`,
  or `CF-Connecting-IP` implied by `--cloudflare`; `authOpts.ProxyHeader`), an attempt counts under
  `px:<address>` (`proxyClientIP`): the header's value, the last entry of `X-Forwarded-For`, used only
  when it parses as an IP address (zone dropped, IPv4-mapped unmapped), else the request's own
  address. A `px:` key comes before `Tailscale-User-Login`: cloudflared passes on what an Internet
  client sent, a login included, so that client could otherwise count its failures under a tailnet
  user's `ts:` key and lock that user out (cloudflared always sets its header; a value that is no
  address leaves the login, else the address, as the key). With `X-Forwarded-For` as the client
  header, a tailnet user whose request carries one counts under `px:` too. Natively the header is read over
  loopback only; in the container (`TERMOTE_PROXY_CLIENT_HEADER`, `ProxyClientAnySource`, set only
  when `runningInContainer`: a server run by hand from the environment reads it over loopback only)
  from any source, which is why `container up` refuses a client header with `--lan` (a LAN machine
  comes in through the gateway like the proxy) and passes it only with the port published on
  `127.0.0.1`. The /64 cap applies to `px:` addresses too, under a `px:` prefix of its own. Every
  attempt under a `ts:` or `px:` key also counts toward one shared cap of 30/min
  (`authMaxProxiedFailures`, key `proxied`): a local process setting a header itself (no owner check
  on macOS loopback), or a tailnet node whose `tailscale serve` passes the client's
  `CF-Connecting-IP` through (counted under that `px:` address then, not its login), guesses no faster
  than that with a header. Every attempt over loopback under its own address (no proxy key: the CLI,
  a local browser, and a `tailscale serve` request with no login, from a tagged node or Funnel)
  counts toward a cap of the same size of its own (`sharedKey`, key `loopback`), since any `127.x`
  source address is a new key: attempts under a `ts:` or `px:` key filling theirs do not lock it out,
  and a local process gets 30/min under each, 60 in all. The price of the shared cap: anyone
  reaching the tunnel can fill it with wrong passwords from a handful of addresses and lock every
  password sign-in through the tunnel (tailnet users' too) until the minute passes; sessions and
  paired devices already signed in keep working. Cloudflare Access in front of the tunnel stops
  this, and `status` warns when Access is off (accepted by the Tech Lead, 2026-11-08).
  A refund takes back all of them. A container without a client header still
  counts under the gateway address. The pairing limiter keys the same way except that it never
  reads `Tailscale-User-Login`. Failed logins and blocked clients are logged with the client
  address (`<proxy-reported address> via <proxy address>` for a `px:` key; the reported address is
  only what the proxy says), never the credentials, at most one line per 10s each. `validateConfig`
  refuses a header name that is not an HTTP token of at most 64 bytes, or is `Host`, `Cookie`,
  `Authorization` or `Proxy-Authorization`; `start` and `container up` check it the same way
- **Server hardening**: ReadHeaderTimeout (Slowloris protection), a 60s read deadline on every
  request, the terminal stream's handshake included (a body sent a byte at a time; hijacking the
  connection for the WebSocket clears it); an authenticated image upload
  extends it to 5 minutes (a slow mobile link), at most 256 sessions (a sign-in by the form or a
  link drops the least recently used; one by Basic auth only takes a free place, else the browser
  stays signed in by Basic auth without a cookie: a page of another site can load the server in
  frames that send the saved Basic credentials, and must not push the user's sessions out; such a
  page can still fill the free places until they expire after 24 h, residual risk accepted by the
  maintainer, 2026-11-14), request
  body size limits (8KB on `/api/mux/*`, 64KB on `agent/message`)
- **Connections from other local users** (`server/peer_user_*.go`, native only: `CheckLocalUsers`
  is set from the saved config, never for the container or an env-configured `serve`): a
  connection whose client address is loopback or one of the machine's own (`net.InterfaceAddrs`,
  30 s cache; an address not in it is another machine's only by a list whose read started after
  the connection arrived, so one added a moment ago is checked; lists are read at most once per
  100 ms, a miss waits for the next one and every miss waiting by then shares it, so a client
  cycling source addresses lists them at most that often; no address is remembered as
  remote; while the last read failed, or none succeeded yet, no address counts as another
  machine's; a client at the server's own address is local whatever the list says) is checked on its first read/write, never in `Accept` (64 lookups at once, at most 4
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
  a reverse proxy under another user); a rollback's `start` drops the saved names. An address is
  this machine's only by this network namespace's interfaces: with `--lan`, a process in another
  namespace on the same machine that has an address of its own on the bridged network (an LXC
  container with `lxc-user-nic`, for one) connects as another machine would, with no owner lookup,
  and meets only the password (accepted, written in `docs/security-model.md`). Rootless podman
  connects from the host's namespace and is checked
- **CLI local socket** (`server/local_socket*.go`; what it may not do: a job grant, an option of a
  permission dialog that stops it asking, see Dialog delegation): the native server also serves on
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
  `img-src 'self' data: blob:` (`blob:`: images the PWA read from `files/raw`; an SVG is shown as a `data:` URL, never a `blob:` one, which opened in a tab would be a document of this origin: `imageSource` in `pwa/src/hooks/use-image-blob.ts` never takes the response's type for a `blob:` URL, which gets the raster type the first bytes show, else `application/octet-stream`, and treats as SVG what has no raster signature and is typed SVG (MIME essence), named `.svg` or starts with `<`), `connect-src 'self'` + `ws://`/`wss://` of the request's `Host` (a
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
- **Cloudflare hostname** (`--cloudflare <host>`, `server/cloudflare.go`): Termote never runs or
  watches `cloudflared` and never holds a tunnel token; the user runs the tunnel, pointed at
  `http://127.0.0.1:<port>`. The hostname (a DNS name of two labels or more, lower-cased; no scheme,
  port or path) is added to the Host allowlist and implies `CF-Connecting-IP` as the proxy client
  header unless `--proxy-client-header` names another. `start` and `container up` refuse it with
  `--no-auth`, a saved one included, and natively `validateConfig` also refuses `Cloudflare` with `NoAuth`
  (the container's `serve` is not told the hostname; only `container up` refuses there). After
  the server answers, `start`, `container up`, `status` (and `status --json`'s `cloudflareAccess`)
  and `panel` (once when it opens) probe `https://<host>/api/mux/health` from outside: no password,
  no cookie, no redirect followed, 5 s, headers only. A redirect to `/cdn-cgi/access/login` or a 401
  naming `cloudflare-access-protected-resource` is Access (`on`); Termote's own Basic challenge or a
  200 is `off` and prints a warning; anything else (403, 530, unreachable) is `unknown`. The probe
  only warns, never fails a command, and grants nothing: the server never trusts a `Cf-Access-*`
  header
- **Tailscale mapping**: `serve` removes its `tailscale serve` mapping when it stops (only while
  it still proxies to its port), so the name never leads to a free port another user could take;
  `start --lan` warns when lingering is off (the port is free while the user is logged out)
- **Config persistence**: the saved password is AES-256-CBC with an HMAC, keyed by a random
  per-install `secret` file (0600) on Unix, DPAPI on Windows; the config file is also chmod
  600. The password is never written to the systemd unit, launchd plist, Scheduled Task or any
  process command line; print it again with `termote show-password`. `start` and `container up`
  print a new password (`showAccessInfo`) only when stdout is a terminal and no Herdr plugin runs
  them (`HERDR_PLUGIN_ID`); otherwise only the username and `termote show-password`, since a coding
  agent's output, a pipe or a log can end up in a transcript or a file.
