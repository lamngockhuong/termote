# Termote Security Checklist

Project-specific checklist based on past vulnerabilities and the 1.0 architecture (one Go
binary: server + CLI, `termote start`/`container up`/`update`/...; no `install` command, no
ttyd, no `/terminal/` iframe).

## Auth & Access Control

### Basic Auth (`serve.go`)

- [ ] `basicAuth()` wraps ALL routes; only `isPWAPublicPath` (manifest, `sw.js`, `workbox-*.js`) skips it
- [ ] `termote serve` reads the saved config when one exists and ignores every `TERMOTE_*`
      variable then; only without a saved config (container, manual run) does `validateConfig`
      read the environment — either way, an empty password without `--no-auth`/`TERMOTE_NO_AUTH=true`
      is fatal, never a silent no-auth start
- [ ] `TERMOTE_NO_AUTH=true` with `TERMOTE_MUX=herdr` is fatal unless `TERMOTE_HERDR_ALLOW_NO_AUTH=true` (CLI: `--allow-herdr-no-auth`)
- [ ] Constant-time comparison via `subtle.ConstantTimeCompare` (user and password)
- [ ] Rate limiter blocks after 5 failures/min per IP; a valid session cookie is checked before the limiter
- [ ] Rate limiter cleans up expired entries (no memory leak)
- [ ] Session cookie: `crypto/rand` 128-bit, `HttpOnly`, `SameSite=Strict`, `Secure` when `requestIsHTTPS`; store bounded
- [ ] `WWW-Authenticate` header set on 401 responses
- [ ] No auth credentials in error responses, logs, or the environment of terminal child processes (`terminalEnv`)

### Request Guards (`guard.go`)

- [ ] `hostGuard` checks `Host` on every request against loopback + `TERMOTE_ALLOWED_HOSTS`; no `*`/off switch
- [ ] Rejection message names the fix (`--allow-host` / `-AllowHost`) but leaks nothing else; reject log rate-limited
- [ ] `writeGuard` on every non-GET/HEAD/OPTIONS `/api/` request: `Sec-Fetch-Site` must be `same-origin` if present
- [ ] `Origin`, if present, must be in the Host allowlist (not compared to `r.Host`); note the allowlist ignores the port
- [ ] `Content-Type: application/json` required on all writes, including body-less DELETE/select (415 otherwise)
- [ ] `X-Forwarded-Proto` only influences the `Secure` cookie flag (`requestIsHTTPS`, accepted: trusted from any source)
- [ ] Unknown `/api/*` → JSON 404 (never the SPA `index.html`); `/terminal/` → JSON 410
- [ ] Unclean paths (`//api/...`) are redirected by `ServeMux`, never dispatched past `writeGuard`

## API & Command Injection

### Input Validation

- [ ] Tab/pane IDs (tmux): `validTmuxID` — no control chars, max 64, no ':' (other session), no leading '-' (flag)
- [ ] Names and keys (tmux): no leading '-' (psmux ignores `--`, so it cannot be used as the guard)
- [ ] Targets always built server-side as `TMUX_SESSION:<id>` (`qualifyTarget`)
- [ ] herdr IDs: `herdrWorkspaceIDRe` / `herdrTabIDRe` / `herdrPaneIDRe`, then must exist in the snapshot (`requireGroup/Tab/Pane`)
- [ ] Request body limited (`MaxBytesReader`, 8KB); send-keys key length limited (4096)
- [ ] No user input reaches `exec.Command` without validation; argv entries only, never a shell string

### Method Enforcement

- [ ] GET-only: `/api/mux/snapshot`, `/api/mux/health`, `/api/mux/stream-token`, `/api/mux/stream` (WebSocket upgrade required, 400 otherwise)
- [ ] POST-only: `/api/mux/tabs`, `/api/mux/tabs/{id}/select`, `/api/mux/panes/{id}/keys`
- [ ] PATCH or DELETE: `/api/mux/tabs/{id}`
- [ ] Wrong method → JSON 405 (patterns carry no method, handlers check)

### Error Handling

- [ ] Internal errors logged server-side via `log.Printf`
- [ ] Client receives generic "mux command failed" (not `err.Error()`); only `inputError` text is echoed (herdr: only `*_not_found` codes)
- [ ] WebSocket errors don't leak internal details

## Terminal Stream

### Network Binding

- [ ] termote binds to `127.0.0.1` unless `--lan` (CLI sets `TERMOTE_BIND`; the binary's own default is `0.0.0.0`)
- [ ] Container: port published as `127.0.0.1:<port>:7680` unless `--lan`; Windows LAN only via netsh portproxy
- [ ] No second listener: the terminal runs inside termote, nothing else binds a port

### `/api/mux/stream` (`stream.go`)

- [ ] Behind basic auth and `hostGuard` like every route
- [ ] `Sec-Fetch-Site`, if present, must be `same-origin`; `Origin`, if present, must be in the Host allowlist; the library origin check is skipped only after this
- [ ] Missing `Origin` (websocat, curl) still needs auth + a valid single-use token
- [ ] Token from `/api/mux/stream-token`: `crypto/rand` 128-bit, 30s, single-use, store capped at 32 live tokens (oldest dropped first); direct navigation (`Sec-Fetch-Dest: document`) and cross-site callers (`Sec-Fetch-Site` other than `same-origin`) refused
- [ ] Token travels in the query: no code path logs `r.URL`
- [ ] `pane` must exist in the backend's current snapshot and pass the backend's ID validation
- [ ] `cols`/`rows` (query and `resize` frames) clamped to [1, 500]
- [ ] Client message limit 64 KiB (`SetReadLimit`), exceeding closes the stream
- [ ] At most 8 streams server-wide; the oldest is evicted (close code 4001), never an unbounded pool
- [ ] Write timeout 10s per frame; ping every 15s, no pong within 30s closes
- [ ] Terminal env drops `TMUX`/`TMUX_PANE` (no nested-session surprises), sets `TERM=xterm-256color`
- [ ] Errors to the client are generic (`failed to open terminal`); details only in server logs

### Terminal Process Lifecycle (`pty_*.go`, `herdr_stream.go`)

- [ ] Closing a stream ends the whole process tree, within 5s + kill
- [ ] Linux: `Pdeathsig: SIGKILL` on the child; the group (`Setsid` / `Setpgid`) is killed via `-pid`, only while the pid is not yet reaped
- [ ] macOS: startup reaps only clients re-parented to PID 1 whose command line matches (`isTmuxAttachCmdline` exact, `isHerdrObserveCmdline` prefix)
- [ ] Windows: child (never termote itself) in a `KILL_ON_JOB_CLOSE` Job Object; job terminated before `ClosePseudoConsole`
- [ ] SIGTERM/SIGINT: `srv.Shutdown`, then the stream hub closes every stream and waits

### HTTP Server

- [ ] `ReadHeaderTimeout` set (Slowloris protection)
- [ ] `IdleTimeout` set (resource cleanup)
- [ ] No-cache headers on non-asset responses

### Frontend (`pwa/src`)

- [ ] Stream URL built from `window.location.host` only; token fetched right before connecting
- [ ] All writes send `Content-Type: application/json`; IDs in paths `encodeURIComponent`-escaped
- [ ] No `dangerouslySetInnerHTML` / `innerHTML` with server data (tab names, pane titles, agent names)
- [ ] Service worker: `navigateFallbackDenylist` covers `/api/`; API responses are not precached

## Herdr Backend

- [ ] Socket path from `HERDR_SOCKET_PATH`, else `herdr.sock` in Herdr's config dir (`XDG_CONFIG_HOME/herdr` → `~/.config/herdr`; Windows: `XDG_CONFIG_HOME` → `%APPDATA%` → `%USERPROFILE%\AppData\Roaming` → `HOME\.config`)
- [ ] Windows: connects to the named pipe `\\.\pipe\<socket path>` and keeps it only if the pipe's server process runs as the same user (`checkPipeServerUser`; pipe names are machine-wide, so another user could create it first)
- [ ] Windows: `herdr terminal session observe` runs in a `KILL_ON_JOB_CLOSE` Job Object, so it dies with the server (`Stop-Process -Force` included)
- [ ] Requests built with `json.Marshal`, < 1 MiB (`herdrMaxRequest`); replies bounded (`herdrMaxReply`, 16 MiB)
- [ ] Every call has a deadline (`muxTimeout`); cancel closes the connection
- [ ] `herdr terminal session observe <pane> --cols N --rows N`: pane validated by regex (never starts with '-'), sizes are integers
- [ ] Observe NDJSON: undecodable lines skipped; only `terminal.frame` bytes reach the client
- [ ] Input queue per pane capped (`herdrMaxQueuedInput`, 1 MiB); overflow ends the stream instead of growing
- [ ] `SelectTab` unsupported: the PWA never changes what the desktop shows

## Go CLI

### Config & Secrets (`cli_config.go`, `install_layout.go`)

- [ ] Config dir created 0700, file written via temp + rename with 0600 (Unix) / `restrictToOwner` ACL (Windows)
- [ ] Unix config parsed as `KEY="value"` lines, never sourced; values containing `"` or newlines refused on write
- [ ] Password: openssl-compatible `aes-256-cbc -pbkdf2` (10000 iters, random salt) keyed by a
      random per-install `secret` file (0600) — file permissions protect it, not the
      derivation — plus a separate HMAC over the ciphertext so a missing/replaced `secret` file
      is detected instead of "decrypting" to garbage; Windows: DPAPI CurrentUser
- [ ] Undecryptable password → `start` warns and sets a new one, never auth off; `serve` alone
      (no `start`) exits 78 instead of looping with a stale key
- [ ] Generated password from `crypto/rand` (12 alphanumerics)
- [ ] Password printed only on first set; `show-password` is explicit; never written to the
      systemd unit, launchd plist, Scheduled Task or any process command line
- [ ] Versioned install layout (`versions/<v>`, `current` pointer): `update` switches `current`
      atomically (temp + rename); a half-written version is never made current

### Update (`cli_update.go`)

- [ ] `--version` and the GitHub tag match `versionRe`; only stable 1.x tags are picked
      automatically (never `releases/latest`, never a 0.x or pre-release tag)
- [ ] Download over HTTPS, sha256 compared against the archive's own `.sha256` (mandatory, no
      way to skip); mismatch aborts before anything is stopped
- [ ] Extraction: `stripTopDir` rejects backslashes and non-local paths; only dirs and regular files are written (no symlinks, no setuid bits)
- [ ] Restarts the service to run the new `current` version; refuses in a git checkout and for
      a binary not installed by the installer

### External Commands (`cli_container.go`, `tailscale.go`, `cli_link.go`)

- [ ] `tailscale serve --bg --https=<int> http://127.0.0.1:<int>`: host validated by `validateHostName`, ports numeric, **never run with `sudo`**
- [ ] `tailscale serve --https=<port> off` only for Termote's own port, never `tailscale serve reset` (which would drop mappings that are not Termote's)
- [ ] `podman`/`docker run`: the password and Host allowlist are passed as `-e NAME` values read
      from the CLI's own process environment — never an argv value, never an env file on disk
- [ ] Container runs `--user <uid>:<gid>` (rootless podman: `--userns=keep-id`; rootless Docker:
      no `--user`); the workspace is mounted with `--mount`, not a shell-interpolated `-v` string
- [ ] PowerShell: elevated scripts via `-EncodedCommand`; interpolated values are integers or `'`-escaped
- [ ] `--allow-host` / `--tailscale` names match `hostNameRe`; `*` refused

### Process Matching (`stopNative`)

- [ ] Unix: kill only when the command line is exactly the server binary path (no arguments), or the PID file names a process whose image starts with `termote`
- [ ] Windows: image path equals the installed `termote.exe` (`sameWindowsPath`: case-insensitive, 8.3 short names via `os.SameFile`)
- [ ] The CLI's own PID is skipped

## Docker & Container

### Image Security

- [ ] Based on `debian:stable-slim` pinned by digest; `tini -s` as PID 1
- [ ] `/etc/passwd` and `/etc/group` permissions <= 644 (never 666)
- [ ] No secrets in Dockerfile or image layers
- [ ] `rm -rf /var/lib/apt/lists/*` after apt-get install; `--no-install-recommends`
- [ ] Binary copied with explicit `chmod +x`, temp files cleaned
- [ ] The herdr binary is pinned by `HERDR_VERSION` and a sha256 per arch, checked before install

### Runtime

- [ ] `container up` runs the image as `--user <uid>:<gid>` (rootless podman: `--userns=keep-id`;
      rootless Docker: no `--user`)
- [ ] `HOME` directory writable but not world-writable for sensitive files
- [ ] Sensitive host dirs excluded from `--workspace` mounts (.ssh, .gnupg, .aws); CLI warns when it contains them
- [ ] Password auto-generated if not provided (12 chars, alphanumeric); shown once, not logged to a file
- [ ] The password and Host allowlist reach the container only as `-e NAME` values from the
      CLI's own process environment (never an env file on disk, never an argv value); `docker
      inspect`/`podman inspect` still show a running container's env, like any container
- [ ] No terminal can read `TERMOTE_PASS` via `env`: `serve` calls `scrubTermoteEnv` on its own
      process after loading the config, `terminalEnv()` filters every `TERMOTE_*` variable (and
      `TMUX`/`TMUX_PANE`) from a spawned pane's environment, and `scrubTmuxSecrets` clears a
      tmux server that was already running with one.
      Known limit: `/proc/<pid>/environ` of `termote` (and tini in the container) still holds the
      startup value; only the same uid/root can read it, and they can decrypt the config anyway
- [ ] `TERMOTE_MUX=herdr`: `herdr server` starts through `env -u TERMOTE_*` (panes inherit its
      env) as a child of tini; only `HERDR_SOCKET_PATH` is exported to `termote serve`, never
      `XDG_CONFIG_HOME=/tmp`, or serve would read its config from a world-writable directory

## Shell Scripts

### Dev Shims (`termote.sh`, `termote.ps1`, checkout-only)

- [ ] Only resolve/build `termote-dev` and run it; no secret handling, never run against an
      installed release
- [ ] All variables double-quoted: `"$VAR"`; `set -eo pipefail`

### Online Installers (`install.sh`, `install.ps1`)

- [ ] Downloads from GitHub releases (HTTPS), newest stable 1.x tag or `TERMOTE_VERSION`
- [ ] `TERMOTE_VERSION` validated with the semver (+ `-rc.N`) regex
- [ ] SHA256 checksum verification against the archive's own `.sha256`; mandatory, no flag skips it
- [ ] Never starts the server or touches the saved config; only lays out the versioned install
      and prints `termote start`

## Known Past Vulnerabilities

Track issues that were found and fixed, to prevent regression. Rows marked (0.x) cover code removed in 1.0 (ttyd, `/terminal/`); keep them for history.

| Date       | Issue                                              | Fix                                                       | Test                                               |
| ---------- | -------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------- |
| 2026-03-24 | (0.x) `/terminal/` accessible without auth         | Sec-Fetch-Dest + token system (route now returns 410)     | `TestRemovedTerminalRoute`                         |
| 2026-03-24 | No rate limiting on basic auth                     | Added `authRateLimiter` (5/min/IP)                        | `TestAuthRateLimiter`, `TestBasicAuthRateLimiting` |
| 2026-03-24 | Error responses leaked tmux internals              | Generic error via `muxError()`                            | `TestMuxRouteErrors`                               |
| 2026-03-24 | No request body size limit on send-keys            | `MaxBytesReader` (8KB) in `decodeJSON`                    | `TestMuxRouteErrors`                               |
| 2026-03-24 | HTTP server no timeouts (Slowloris)                | Added `ReadHeaderTimeout`, `IdleTimeout`                  | —                                                  |
| 2026-03-24 | `/etc/passwd` world-writable in container          | Changed to 644                                            | —                                                  |
| 2026-03-24 | (0.x) WebSocket dial to ttyd had no timeout        | `DialTimeout` (2s); proxy removed in 1.0                  | —                                                  |
| 1.0        | Empty password silently disabled auth              | `validateConfig` refuses to start                         | `TestValidateConfig`                               |
| 1.0        | DNS rebinding / cross-site writes against the API  | `hostGuard` + `writeGuard`                                | `TestHostGuardThroughServer`, `TestWriteGuard`     |
| 1.0        | Update tarball could write outside the install dir | `stripTopDir` (IsLocal, no backslash), regular files only | `TestExtractTarballRejectsEscapingPaths`           |
