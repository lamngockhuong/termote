# Termote Security Checklist

Project-specific checklist based on past vulnerabilities and architecture.

## Auth & Access Control

### Basic Auth
- [ ] `basicAuth()` wraps ALL routes (no path exclusions)
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
- [ ] Token endpoint requires `Sec-Fetch-Dest` != document/empty

### iframe Protection
- [ ] `iframeOnly()` blocks `Sec-Fetch-Dest: document` (direct navigation)
- [ ] `iframeOnly()` blocks empty `Sec-Fetch-Dest` (non-browser clients)
- [ ] `Sec-Fetch-Dest: iframe` requires valid token
- [ ] Sub-resources (script, style, websocket) allowed without token

## API & Command Injection

### Input Validation
- [ ] All tmux targets validated: `^[a-zA-Z0-9_\-:.]+$`, max 64 chars
- [ ] Window names validated same as targets
- [ ] Send-keys body limited (MaxBytesReader, 8KB)
- [ ] Send-keys key length limited (4096 chars)
- [ ] No user input reaches `exec.Command` without validation

### Method Enforcement
- [ ] GET-only: `/api/tmux/windows`, `/api/tmux/health`
- [ ] POST-only: `/api/tmux/select/`, `/api/tmux/new`, `/api/tmux/rename/`, `/api/tmux/send-keys`
- [ ] POST or DELETE: `/api/tmux/kill/`
- [ ] GET-only: `/api/tmux/terminal-token`

### Error Handling
- [ ] Internal errors logged server-side via `log.Printf`
- [ ] Client receives generic "tmux command failed" (not `err.Error()`)
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

| Date | Issue | Fix | Test |
|------|-------|-----|------|
| 2026-03-24 | `/terminal/` accessible without auth | Added Sec-Fetch-Dest + token system | `TestIframeOnly`, `TestTerminalTokenEndpoint` |
| 2026-03-24 | No rate limiting on basic auth | Added `authRateLimiter` (5/min/IP) | `TestAuthRateLimiter`, `TestBasicAuthRateLimiting` |
| 2026-03-24 | Error responses leaked tmux internals | Generic error via `tmuxError()` helper | `TestTmuxError` |
| 2026-03-24 | No request body size limit on send-keys | Added `MaxBytesReader` (8KB) | `TestSendKeysBodyLimit` |
| 2026-03-24 | HTTP server no timeouts (Slowloris) | Added `ReadHeaderTimeout`, `IdleTimeout` | — |
| 2026-03-24 | `/etc/passwd` world-writable in container | Changed to 664 | — |
| 2026-03-24 | WebSocket dial no timeout | Added `DialTimeout` (2s) | — |
