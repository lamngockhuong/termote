# Termote Security Checklist

Project-specific checklist based on past vulnerabilities and architecture.

## Auth & Access Control

### Basic Auth

- [ ] `basicAuth()` wraps ALL routes (no path exclusions)
- [ ] Empty `TERMOTE_PASS` without `TERMOTE_NO_AUTH=true` is fatal (`validateConfig`), never silently disables auth
- [ ] Constant-time comparison via `subtle.ConstantTimeCompare`
- [ ] Rate limiter blocks after 5 failures/min per IP
- [ ] Rate limiter cleans up expired entries (no memory leak)
- [ ] `WWW-Authenticate` header set on 401 responses
- [ ] No auth credentials in error responses or logs

### Terminal Token System

- [ ] Token generated with `crypto/rand` (not math/rand)
- [ ] Token entropy >= 128 bits (16 bytes → 32 hex chars)
- [ ] Token TTL <= 30 seconds
- [ ] Token is single-use (deleted after validation)
- [ ] Expired tokens swept on generate (prevent unbounded map growth)
- [ ] Token endpoint requires `Sec-Fetch-Dest` != document (missing header allowed for mobile compatibility)

### Request Guards (`guard.go`)

- [ ] `hostGuard` checks `Host` on every request against loopback + `TERMOTE_ALLOWED_HOSTS`; no `*`/off switch
- [ ] Rejection message names the fix (`--allow-host` / `-AllowHost`) but leaks nothing else
- [ ] `writeGuard` on every non-GET `/api/` request: `Sec-Fetch-Site` must be `same-origin` if present
- [ ] `Origin`, if present, must be in the Host allowlist (not compared to `r.Host`)
- [ ] `Content-Type: application/json` required on all writes, including body-less DELETE/select (415 otherwise)
- [ ] `X-Forwarded-Proto` trusted only from a loopback `RemoteAddr` (`requestIsHTTPS`)
- [ ] Unknown `/api/*` → JSON 404 (never the SPA `index.html`)

### iframe Protection

- [ ] `iframeOnly()` blocks `Sec-Fetch-Dest: document` (direct navigation)
- [ ] `iframeOnly()` allows missing `Sec-Fetch-Dest` (mobile browser compatibility)
- [ ] `Sec-Fetch-Dest: iframe` requires valid token
- [ ] Sub-resources (script, style, websocket) allowed without token

## API & Command Injection

### Input Validation

- [ ] Tab/pane IDs: `validTmuxID` — no control chars, max 64, no ':' (other session), no leading '-' (flag)
- [ ] Names and keys: no leading '-' (psmux ignores `--`, so it cannot be used as the guard)
- [ ] Targets always built server-side as `TMUX_SESSION:<id>` (`qualifyTarget`)
- [ ] Send-keys body limited (MaxBytesReader, 8KB)
- [ ] Send-keys key length limited (4096 chars)
- [ ] No user input reaches `exec.Command` without validation

### Method Enforcement

- [ ] GET-only: `/api/mux/snapshot`, `/api/mux/health`, `/api/mux/stream-token`, `/api/mux/stream` (WebSocket upgrade required, 400 otherwise)
- [ ] POST-only: `/api/mux/tabs`, `/api/mux/tabs/{id}/select`, `/api/mux/panes/{id}/keys`
- [ ] PATCH or DELETE: `/api/mux/tabs/{id}`
- [ ] Wrong method → JSON 405 (patterns carry no method, handlers check)

### Error Handling

- [ ] Internal errors logged server-side via `log.Printf`
- [ ] Client receives generic "mux command failed" (not `err.Error()`); only `inputError` text is echoed
- [ ] WebSocket errors don't leak internal details

## Terminal & WebSocket Proxy

### Network Binding

- [ ] ttyd binds to localhost only (`-i lo` / `-i lo0`)
- [ ] tmux-api binds to localhost by default (`TERMOTE_BIND=127.0.0.1` unless `--lan`)
- [ ] Container mode: ttyd on 7681 (internal), tmux-api on 7680 (exposed)

### WebSocket Proxy

- [ ] `net.DialTimeout` used (not `net.Dial`) — prevents hanging connections
- [ ] Timeout <= 2 seconds for localhost connections
- [ ] Bidirectional copy waits for both goroutines (no goroutine leak)
- [ ] Hijack errors don't leak to client

### Terminal Stream (`/api/mux/stream`, `stream.go`)

- [ ] Behind basic auth and `hostGuard` like every route
- [ ] `Sec-Fetch-Site`, if present, must be `same-origin`; `Origin`, if present, must be in the Host allowlist (not `r.Host`); library origin check is skipped only after this
- [ ] Missing `Origin` (websocat, curl) still needs auth + a valid single-use token
- [ ] Token from `/api/mux/stream-token`: 30s, single-use, store capped at 32 live tokens (oldest dropped first)
- [ ] Token travels in the query: no code path logs `r.URL`
- [ ] `pane` must exist in the backend's current snapshot and pass the backend's ID validation
- [ ] `cols`/`rows` (query and `resize` frames) clamped to [1, 500]
- [ ] Client message limit 64 KiB (`SetReadLimit`), exceeding closes the stream
- [ ] At most 8 streams server-wide; the oldest is evicted, never an unbounded pool
- [ ] Write timeout 10s per frame; ping every 15s, no pong within 30s closes
- [ ] Terminal env drops `TMUX`/`TMUX_PANE` (no nested-session surprises), sets `TERM=xterm-256color`
- [ ] Errors to the client are generic (`failed to open terminal`); details only in server logs

### Terminal Process Lifecycle (`pty_*.go`)

- [ ] Closing a stream ends the whole process tree, within 5s + kill
- [ ] Linux: `Pdeathsig: SIGKILL` on the child; the group (`Setsid`) is killed via `-pid`
- [ ] macOS: startup reaps `tmux attach` clients re-parented to PID 1 whose command line matches exactly
- [ ] Windows: child (never tmux-api itself) in a `KILL_ON_JOB_CLOSE` Job Object; job terminated before `ClosePseudoConsole`
- [ ] SIGTERM/SIGINT: `srv.Shutdown`, then the stream hub closes every stream and waits

### HTTP Server

- [ ] `ReadHeaderTimeout` set (Slowloris protection)
- [ ] `IdleTimeout` set (resource cleanup)
- [ ] No-cache headers on non-asset responses

### Frontend

- [ ] `postMessage` uses explicit origin (not `*`)
- [ ] Terminal iframe uses `allow="clipboard-read; clipboard-write"` only
- [ ] No `dangerouslySetInnerHTML` with user input
- [ ] IME/keyboard input sanitized before sending to terminal

## Docker & Container

### Image Security

- [ ] Based on minimal image (tsl0922/ttyd:latest)
- [ ] `/etc/passwd` and `/etc/group` permissions <= 664 (not 666)
- [ ] No secrets in Dockerfile or image layers
- [ ] `rm -rf /var/lib/apt/lists/*` after apt-get install
- [ ] Binary copied with explicit `chmod +x`, temp files cleaned

### Runtime

- [ ] Container runs as non-root where possible
- [ ] `HOME` directory writable but not world-writable for sensitive files
- [ ] Sensitive host dirs excluded from mounts (.ssh, .gnupg, .aws)
- [ ] Password auto-generated if not provided (12 chars, alphanumeric)
- [ ] Password shown once on startup, not logged to file

## Shell Scripts

### Input Handling

- [ ] All variables double-quoted in commands: `"$VAR"`
- [ ] Port validated as numeric 1-65535
- [ ] IP validated with regex pattern
- [ ] No `eval` with user input
- [ ] `set -e` enabled for early failure

### Secret Handling

- [ ] Password generated via `openssl rand` (not predictable source)
- [ ] Password not written to log files
- [ ] Password shown to terminal only (stderr/stdout, not logged)
- [ ] `TERMOTE_PASS` exported only for child process, not persisted

### Download Security (get.sh)

- [ ] Downloads from GitHub releases (HTTPS)
- [ ] SHA256 checksum verification
- [ ] Graceful fallback if checksum unavailable
- [ ] User confirmation before install (unless `--yes`)
- [ ] Services stopped before binary replacement (avoid "Text file busy")

## Known Past Vulnerabilities

Track issues that were found and fixed, to prevent regression:

| Date       | Issue                                     | Fix                                      | Test                                               |
| ---------- | ----------------------------------------- | ---------------------------------------- | -------------------------------------------------- |
| 2026-03-24 | `/terminal/` accessible without auth      | Added Sec-Fetch-Dest + token system      | `TestIframeOnly`, `TestTerminalTokenEndpoint`      |
| 2026-03-24 | No rate limiting on basic auth            | Added `authRateLimiter` (5/min/IP)       | `TestAuthRateLimiter`, `TestBasicAuthRateLimiting` |
| 2026-03-24 | Error responses leaked tmux internals     | Generic error via `tmuxError()` helper   | `TestTmuxError`                                    |
| 2026-03-24 | No request body size limit on send-keys   | Added `MaxBytesReader` (8KB)             | `TestSendKeysBodyLimit`                            |
| 2026-03-24 | HTTP server no timeouts (Slowloris)       | Added `ReadHeaderTimeout`, `IdleTimeout` | —                                                  |
| 2026-03-24 | `/etc/passwd` world-writable in container | Changed to 664                           | —                                                  |
| 2026-03-24 | WebSocket dial no timeout                 | Added `DialTimeout` (2s)                 | —                                                  |
