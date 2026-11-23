# Security invariants: Machines

Part of the [security invariants](README.md): other termote servers reached over SSH.

- **Machine bridge** (`server/bridge_socket.go`, `server/cli_bridge.go`): beside the CLI's socket the
  native server opens `<stateDir>/run/<port>.bridge.sock` or the pipe `termote-<SID>-<port>-bridge`
  through the same `openLocalSocket` (same modes, owner, SDDL, exclusive first instance, cleanup); the
  container opens none. A connection there gets its own context mark (`bridgeKey`, from the connection
  type only), never the CLI's: `isLocalSocket` is false, so `basicAuth` never makes it `authLocal`.
  `bridgeAuth` sits outside `basicAuth` (applies with `--no-auth` too) and signs every bridge request in
  as `authMachine` with the role of `X-Termote-Role` (`full|view`; missing → `view`; anything else
  400); the header is ignored on every other connection. `X-Termote-Origin-Auth` (`password|device`)
  only reaches the audit `via` (`machine:<origin>`), never a grant. `isCLI` is false for
  `authMachine`. On the bridge, sign-in and sign-out (`/login`, `/pair`, `/login/link`,
  `/api/mux/logout`), `login-links`, `devices*`, `signins*`, `push*`, `settings*` and a job's
  `grants*` (`/api/mux/jobs/{id}/grants...`, see Dialog delegation) answer 403
  `machine_forbidden` before any handler, whatever the role (cleaned path); a snapshot read over the
  bridge carries no `settingsProposal` and `caps.settingsProposals` false, so a machine's settings
  proposal never reaches a browser open on it through another termote. `hostGuard` takes
  `termote.local-socket` on the bridge as on the CLI's socket; audit `ip=machine by=machine`. A
  permission dialog answered over the bridge never takes an option that stops it asking
  (`answer_always_refused`), and every such answer is an `audit: dialog_answer` line.
  `termote bridge` (the forced command of the key `machine add` installs) takes only
  `--socket-dir <abs>`, reads the saved config for the port (none → error, nothing on stdout),
  dials the bridge with the owner check of `dialSocketOS`, writes `TERMOTE-BRIDGE 1 <version>\n`
  then copies bytes both ways until the server's side closes (stdin closing only half-closes the way to
  the server, where the connection can, so its last answer still goes out); it never reads `SSH_ORIGINAL_COMMAND` or
  runs anything else. A process of the same user can open the bridge: it already has the CLI's
  socket (accepted). Every other route stays open on the bridge, the machine proxy
  (`/api/machines/<id>/mux/*`) included: a termote that reaches this one over the bridge also reaches
  the machines this one added, with the role it was signed in with here, so a view role stays view
  (`server/machine_proxy.go`). A full role here can already run commands as this user and use this
  server's SSH key, so it gains no access it did not have (accepted)
- **Machines CLI** (`server/cli_machine.go`, `server/machine_store.go`, `server/machine_ssh_args.go`):
  only `termote machine add|remove|import --herdr` change `machines.json` (config dir, 0600, temp file
  renamed, at most 32, id 16 random hex); a record failing a check (alias
  `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`, printable label ≤ 64, remote paths absolute with no quote,
  backslash, dollar, backtick or control character) fails the whole read. Every ssh/ssh-keygen argv is built in
  `machine_ssh_args.go`: the alias always follows `--`, no `-o` takes data, and each ssh overrides the
  alias's config block (`ClearAllForwardings`, `ForwardAgent=no`, `ForwardX11=no`,
  `PermitLocalCommand=no`, `RemoteCommand=none`, `RequestTTY=no`, `Tunnel=no`, `ControlMaster=no`,
  `ControlPath=none`, `UpdateHostKeys=no`, `CheckHostIP=no`) and keys the host as
  `HostKeyAlias=termote-<id>` in termote's own `ssh/known_hosts`. termote's key (`ssh/id_ed25519`, dir
  0700, no passphrase) is made by `ssh-keygen` and never printed. Before its first ssh, `add` copies
  what the user's own known_hosts files (`ssh -G`'s `userknownhostsfile` and `globalknownhostsfile`)
  hold for the host (`ssh-keygen -F` on its `HostKeyAlias`, else its host, `[host]:port` off port 22)
  into termote's, as `termote-<id>`, a `@revoked` marker kept and `@cert-authority` lines left out (a
  certificate never names `termote-<id>`) (`seedHostKeys`), so a host whose key the user already
  trusts is checked against that key and a changed one refused. `add` runs the user's ssh at the
  terminal (`StrictHostKeyChecking=ask`: the only TOFU, for a host none of those files knows), asks `termote machine whereami` there for its
  stable path (Windows: `termote.exe`, never the `.cmd` shim) and socket dir; whereami from a binary the registered
  service does not run (an install on PATH while a checkout's dev shim registered the service) runs the registered
  one's `machine whereami` (no shell, fixed words) and passes on its JSON answer, its own only when that one gives
  none, and says `noUpdate` for a binary `update` refuses (a checkout, Homebrew), which is told, never offered an
  update. Where that Unix script says
  `TERMOTE-NOT-FOUND` (exit 3, reported as such, never as ssh failing), only after a yes (or `--yes`) it
  runs the online installer there over the same ssh, downloaded to a `mktemp` file first (a failed
  download fails the step) and pinned with `TERMOTE_VERSION` to this release when that matches
  `versionRe`, then `'<exe>' start` without stdin when it has no saved config; where whereami's version is older than this release,
  or the script says `TERMOTE-OLD` (exit 4: a termote without `machine whereami`, its `exe=` path checked
  by `validRemotePath` and its `Termote v<X>` line by `versionRe`; `add` stops unless it is updated),
  after a yes `'<exe>' update --version <this>`. `<exe>` is whereami's path, passed as `$0` to `sh -c`
  after `validRemotePath`, and the only arguments are fixed words and a `versionRe` version; their output,
  the new password included, goes to the user's terminal (stderr), never to a log. Then, after a yes (or
  `--yes`) appends `command="'<exe>' bridge --socket-dir '<dir>'",restrict <pub>` once, sent on stdin;
  `--print-key` (and every Windows machine) only prints it. A machine is saved only after the
  service's own connection (`BatchMode`, `StrictHostKeyChecking=yes`, `IdentitiesOnly`,
  `IdentityAgent=none`) read the bridge greeting and an equal `apiVersion` (`--no-check` skips it);
  an alias with a `ProxyCommand`/`ProxyJump` is warned about. `remove <id|label>` matches an id before a
  label, since a label may look like another machine's id (`findMachine`), and asks before dropping the key's
  lines there (matched on the key's base64; the file is rewritten only from a whole copy, so a full disk
  never empties it) and drops the host key (`forgetMachineHost`: `ssh-keygen -R`, then the `@revoked` lines
  it keeps, the file rewritten from a whole copy), as a failed `add` does for the lines it copied or learnt. The running
  server is told over the local socket only (`machines/reload`). `uninstall --purge` removes the store
  and key with the config dir; the lines on the machines stay
- **Machine transport** (`server/machine_link.go`, `server/machine_conn.go`, `server/machine_serve.go`,
  `server/machine_proc_*.go`): the server reads `machines.json` only with a saved config (never in the
  container). Each machine gets one master `ssh -M -N -S <ctl> -o ControlPersist=no` (Unix) at
  `<stateDir>/run/ssh/<id>` (dir 0700, `ensureSocketDir`), at most 86 bytes since OpenSSH binds
  `<path>.<16 chars>` first, else `$TMPDIR/termote-<uid>/<id>`, else no multiplexing; a socket left
  there gets `-O exit` and is removed before a new master. Every HTTP connection is one
  `ssh -S <ctl> ... -- <alias> bridge` (Windows: its own ssh) with the service options of the Machines
  CLI entry, used only after the greeting line (10 s, read up to the reader's 4 KB buffer: a longer first
  line is incompatible, greeting or not, never read to its end) and, after any failure, an equal `apiVersion` over a
  connection of its own; at most 16 per machine (a forwarded stream frees its slot once upgraded), idle
  90 s, and an answer's headers awaited at most 8 min (`machineResponseHeaderWait`, above the longest agent
  message, `messageBudget`, and a worktree change, a test checks), a health answer at most 20 s
  (`machineHealthWait`), so a machine that never answers does not hold them. Once the headers came,
  each read of an answer's body (a WebSocket upgrade excepted) gets 2 min and the whole body 30 min
  (`machineResponseIdleWait`, `machineResponseBodyMost`, a download's own `downloadIdleTimeout` and
  `downloadMaxDuration`): the request's context ends then, which closes the connection and its ssh,
  since an ssh pipe has no read deadline, so a machine that stalls its body does not hold them either. Every ssh runs in its own process
  group with `Pdeathsig` (Linux), is reaped as an orphan at start on macOS (`HostKeyAlias=termote-`
  in its command line) or sits in a kill-on-close Job Object (Windows), and is stopped (SIGTERM, then
  SIGKILL after 1 s) when its connection closes, its machine is removed, or the server stops. ssh's
  stderr (4 KB) is classified (`unauthorized|hostkey|incompatible|offline`) and logged (5 lines, 200
  B each, control characters removed by `stripUnsafeRunes` so the machine cannot rewrite the log in a
  terminal) on a status change, never sent to a client. After a failure requests fail at once for a
  backoff of 5 s doubling to 5 min. Masters stop after 10 min with no request or stream forwarded
  (counted while each runs), unless a device has a Web Push subscription the watcher would send to
  (`pushStore.anySendable`: not one of an ended sign-in or device; every machine is then polled).
  Removing a machine closes every connection open to it, a forwarded stream too, then stops its master.
  stdout is read from a pipe of termote's own, so `Wait` never drops what ssh wrote last; `WaitDelay`
  bounds a child holding stderr, and an exited ssh's pid is never signalled again. `TERMOTE_E2E_MACHINE_BRIDGE` (`<label>=<port>@<dir>`, comma-separated)
  joins bridge sockets of this machine instead of ssh: read only without a saved config, like every
  `TERMOTE_*`, and scrubbed from the environment
- **Machine proxy** (`server/machine_proxy.go`, `/api/machines/{id}/mux/{rest}`): an ordinary route
  behind `basicAuth`, `writeGuard`, `securityHeaders` and `hostGuard`; `writeGuard`'s raw-body cases
  (`uploads`, `files/upload`, `files/image`) match on the path with the prefix removed
  (`machineRest`). The id is 16 hex of a stored machine (else 404 `machine_unknown`); `rest` must
  match the allowlist (`snapshot`, `overview`, `activity`, `system`, `stream-token`, `stream`,
  `health`, `uploads`, `files/places`, `tabs*`, `panes*`, `groups*`, `worktrees*`, `tasks*`,
  `templates*`, `recent-groups*`), hold no `.`/`..` segment, empty segment, `%2F` or `%5C`, else 404
  `machine_route_forbidden` (so never `devices*`, `signins*`, `push*`, `login-links`, `logout`,
  `machines*`). Before forwarding it runs `crossSiteRejection` on every method, refuses
  `stream-token` as a navigation, checks a stream's Origin, refuses a view role's writes, caps the
  body (100 MiB for `files/upload`, else the largest other route limit; the machine applies its
  own) and extends the read deadline for a write. It removes `Cookie`, `Authorization`, `Origin`,
  `Referer`, `Forwarded`, every `Sec-Fetch-*`, `X-Termote-*`, `X-Forwarded-*`, `CF-Connecting-IP`,
  `X-Real-IP` and the configured proxy client header, sets `X-Termote-Role` from `requestRole` and
  `X-Termote-Origin-Auth`, sends the escaped path to `termote.local-socket`, and passes on only the
  answer headers in `machineResponseKeep` (content type, length, disposition, encoding and range,
  caching and validators, `Vary`, `Allow`, `Retry-After`, `Date` and `nosniff`; never the machine's
  own CSP, whose `report-uri`/`report-to` would send this origin's violation reports to a host it names,
  replaced by the sandbox policy; on a 101 only the WebSocket upgrade headers; a 2xx of `files/raw` gets the
  type this server's own `files/raw` would send, parameters dropped, else `application/octet-stream`,
  `confineMachineImageType`): an allow list, since every header a
  deny list kept missing could act on this origin (`Set-Cookie`, `Service-Worker-Allowed`,
  `Clear-Site-Data`, `NEL`/`Report-To` sending later requests' URLs to the machine's collector,
  `WWW-Authenticate` asking for a password in this origin's name) or navigate the tab (`Refresh`,
  `Location`: termote redirects on no route a machine serves); no trailer either (`resp.Trailer`
  emptied before `ReverseProxy` announces it and again when the body closes,
  `machineTrailerDrop`: a proxy in front may pass a trailer on as a header); no interim answer (a 1xx but 101, such as 103 Early
  Hints) is passed on (`machineInterimDrop`: `httputil.ReverseProxy` would send one with every header
  the machine gave it, before `ModifyResponse`, and clear this server's own headers, which are put
  back in front of the final answer's); every
  answer but a 101 gets `Content-Security-Policy: sandbox; default-src 'none'` (plus inline style and
  `data:` images) and `nosniff`, so nothing a machine serves runs as a page of this origin. A client asks
  one machine for at most 16 stream tokens per 30 s (4 for the view role; else 429 `busy`): on the machine
  every forwarded token has the same empty device. A machine that cannot be reached answers 502 `machine_offline|machine_unauthorized|
  machine_incompatible` (a changed host key is `machine_unauthorized`); transport errors are logged
  only. Writes are logged `audit: machine-request id method path=<first segment> by`
- **Machines list** (`server/machine_routes.go`): `GET /api/mux/machines` (same-site read, every role)
  → `{machines: [{id, label, status, groups?}]}`, groups cut to group/tab/pane ids and names and the
  agent's name, status and since (no title, process, metadata or path); never an alias, user or
  path. The snapshot carries `machines: [{id, label, status}]` and `caps.machines`. Listing keeps
  every machine's snapshot polled (`peek=1`, as view) every 5 s (Windows 15 s) for 60 s, or always
  with Web Push; a failed poll only changes the machine's status. `POST /api/mux/machines/reload` is
  the local socket's only (403 `cli_only` otherwise, with or without sign-in). Web Push events of a
  machine's agents go to this server's subscriptions with `machineId` (panes keyed `<id>/<paneKey>`,
  the topic too)
