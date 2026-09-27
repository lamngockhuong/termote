# Termote Security Checklist

Project-specific checklist based on past vulnerabilities and the 1.0 architecture (one Go binary: server + CLI; no ttyd, no `/terminal/` iframe).

## Auth & Access Control

### Basic Auth (`serve.go`)

- [ ] `basicAuth()` wraps ALL routes; only `isPWAPublicPath` (manifest, `sw.js`, `workbox-*.js`) skips it
- [ ] Empty `TERMOTE_PASS` without `TERMOTE_NO_AUTH=true` is fatal (`validateConfig`), never silently disables auth
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

- [ ] Socket path from `HERDR_SOCKET_PATH` or `~/.config/herdr/herdr.sock`; Unix only (Windows build refuses)
- [ ] Requests built with `json.Marshal`, < 1 MiB (`herdrMaxRequest`); replies bounded (`herdrMaxReply`, 16 MiB)
- [ ] Every call has a deadline (`muxTimeout`); cancel closes the connection
- [ ] `herdr terminal session observe <pane> --cols N --rows N`: pane validated by regex (never starts with '-'), sizes are integers
- [ ] Observe NDJSON: undecodable lines skipped; only `terminal.frame` bytes reach the client
- [ ] Input queue per pane capped (`herdrMaxQueuedInput`, 1 MiB); overflow ends the stream instead of growing
- [ ] `SelectTab` unsupported: the PWA never changes what the desktop shows

## Go CLI

### Config & Secrets (`cli_config.go`)

- [ ] Config dir created 0700, file written via temp + rename with 0600 (Unix) / `restrictToOwner` ACL (Windows)
- [ ] Unix config parsed as `KEY="value"` lines, never sourced; values containing `"` or newlines refused on write
- [ ] Password: openssl-compatible `aes-256-cbc -pbkdf2` (10000 iters, random salt) with the machine-derived key (obfuscation, not a secret); Windows: DPAPI CurrentUser
- [ ] Undecryptable password → new password, never auth off
- [ ] Generated password from `crypto/rand` (12 alphanumerics)
- [ ] Password printed only on first set; `show-password` is explicit

### Update (`cli_update.go`)

- [ ] `--version` and the GitHub `tag_name` match `versionRe`
- [ ] Download over HTTPS, sha256 compared with `checksums.txt`; mismatch aborts before anything is stopped
- [ ] Extraction: `stripTopDir` rejects backslashes and non-local paths; only dirs and regular files are written (no symlinks, no setuid bits)
- [ ] Hands over to the new shim with `exec` (Unix) or a child PowerShell (Windows)

### External Commands (`cli_install.go`, `cli_link.go`)

- [ ] `sudo tailscale serve --bg --https=<int> http://127.0.0.1:<int>`: host validated by `validateHostName`, ports numeric
- [ ] `tailscale serve reset` only when Termote configured Tailscale before (it resets the whole serve config)
- [ ] `podman`/`docker compose`: secrets passed via environment, not argv; override file contains only bind/port integers
- [ ] PowerShell: elevated scripts via `-EncodedCommand`; interpolated values are integers or `'`-escaped
- [ ] `--allow-host` / `--tailscale` names match `hostNameRe`; `*` refused

### Process Matching (`stopNative`)

- [ ] Unix: kill only when the command line is exactly the server binary path (no arguments), or the PID file names a process whose image starts with `termote`
- [ ] Windows: image path equals `server\termote-server.exe` (`sameWindowsPath`: case-insensitive, 8.3 short names via `os.SameFile`)
- [ ] Legacy ttyd killed only on the exact 0.x argument list / 0.x `scripts\ttyd.exe`
- [ ] The CLI's own PID is skipped

## Docker & Container

### Image Security

- [ ] Based on `debian:stable-slim` pinned by digest; `tini -s` as PID 1
- [ ] `/etc/passwd` and `/etc/group` permissions <= 644 (never 666)
- [ ] No secrets in Dockerfile or image layers
- [ ] `rm -rf /var/lib/apt/lists/*` after apt-get install; `--no-install-recommends`
- [ ] Binary copied with explicit `chmod +x`, temp files cleaned

### Runtime

- [ ] Compose `user:` maps to the host UID/GID
- [ ] `HOME` directory writable but not world-writable for sensitive files
- [ ] Sensitive host dirs excluded from mounts (.ssh, .gnupg, .aws); CLI warns when `WORKSPACE` contains them
- [ ] Password auto-generated if not provided (12 chars, alphanumeric); shown once, not logged to a file
- [ ] `TERMOTE_PASS` not exported into the tmux session started by `entrypoint.sh`
- [ ] No terminal can read `TERMOTE_PASS` via `env`: `scrubSecretEnv` after config load, `terminalEnv`
      filters `secretEnvKeys`, `scrubTmuxSecrets` clears a tmux server that 0.x started with it.
      Known limit: `/proc/<pid>/environ` of `termote` (and tini in the container) still holds the
      startup value; only the same uid/root can read it, and they can decrypt the config anyway

## Shell Scripts

### Shims (`termote.sh`, `termote.ps1`)

- [ ] Only resolve the install dir and run the binary; no secret handling
- [ ] All variables double-quoted: `"$VAR"`; `set -eo pipefail`

### Online Installers (`get.sh`, `get.ps1`)

- [ ] Downloads from GitHub releases (HTTPS)
- [ ] `--version` validated with the semver regex
- [ ] SHA256 checksum verification; `--strict` fails when unavailable
- [ ] Config read with `grep`/`cut`, never sourced
- [ ] User confirmation before install (unless `--yes` / `--update`)

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
