---
name: security-review
description: Comprehensive security review for Termote. Use when reviewing PRs, auditing code, or before releases. Covers auth bypass, request guards (Host/Origin/Content-Type), terminal WebSocket stream, child-process lifetime, command/argument injection (tmux, psmux, herdr), the Go CLI (install layout, saved config, update, service registration, process kill) and container setup.
allowed-tools: Read, Grep, Glob, Bash(git diff*, git log*, git show*), Agent
argument-hint: "[--full | --diff-only] [--focus auth|api|stream|herdr|cli|docker|shell]"
---

# Termote Security Review

Review Termote for security vulnerabilities, tailored to its 1.0 architecture: one Go binary (`termote`) that is both the server (PWA + `/api/mux/*` + terminal WebSocket stream + auth) and the CLI (`termote start`/`container up`/`update`/...), a React PWA, an online installer (`scripts/install.sh`/`install.ps1`) plus a checkout-only dev shim (`scripts/termote.sh`/`termote.ps1`), and a Docker image. There is no `install` command, no ttyd and no `/terminal/` iframe any more: the server runs the terminal itself on a PTY (Unix) or ConPTY (Windows) and streams it over `/api/mux/stream`. Backends: tmux (psmux on Windows) and herdr (Unix only, via its socket and CLI).

## Arguments

- `--full`: Scan entire codebase (default if no unstaged changes)
- `--diff-only`: Only review changed files
- `--focus <area>`: Focus on specific area (auth, api, stream, herdr, cli, docker, shell)

Current arguments: $ARGUMENTS

## Step 1: Determine Scope

```
If --diff-only or there are uncommitted/staged changes:
  Run git diff + git diff --cached to get changed files
If --full or clean tree:
  Scan all key files
If --focus specified:
  Filter to relevant files only
```

For a release review, diff against the previous tag:
`git diff <prev-tag>..HEAD -- server pwa/src scripts Dockerfile entrypoint.sh docker-compose.yml`.

## Step 2: Review by Area

Launch parallel review agents for each relevant area. Pass the diff or file contents to each agent.

### Area: Auth & Request Guards (`server/serve.go`, `server/guard.go`)

Check against [checklist.md](checklist.md#auth--access-control):

- Basic auth on ALL routes except the PWA public paths (manifest, `sw.js`, `workbox-*.js`)
- When a saved config exists (`server/serve_config.go`), `termote serve` reads it and ignores
  every `TERMOTE_*` variable; only without one (container, manual run) does
  `validateConfig`/the environment apply — empty password without `TERMOTE_NO_AUTH=true`
  refuses to start either way
- herdr with auth off needs `TERMOTE_HERDR_ALLOW_NO_AUTH=true` (`--allow-herdr-no-auth`)
- Host allowlist (`hostGuard`, `TERMOTE_ALLOWED_HOSTS`) on every request (DNS rebinding); no wildcard
- Cross-site writes rejected (`writeGuard`): `Sec-Fetch-Site`, `Origin` in the allowlist, JSON-only `Content-Type` on every non-GET `/api/` method
- Rate limiting on auth failures; constant-time password comparison
- Session cookie: `HttpOnly`, `SameSite=Strict`, `Secure` when HTTPS; bounded store
- No credentials in logs, error responses or child-process environments

### Area: API & Command Injection (`server/mux.go`, `server/mux_tmux.go`, `server/mux_herdr.go`)

Check against [checklist.md](checklist.md#api--command-injection):

- tmux targets validated with `validTmuxID` (no ':' → no other session, no leading '-' → no flag injection) and qualified server-side
- herdr IDs match `herdrWorkspaceIDRe` / `herdrTabIDRe` / `herdrPaneIDRe` and must exist in the current snapshot
- No user input reaches `exec.Command` without validation; herdr socket calls go through `json.Marshal`
- Body size limit (8KB) and keys length limit (4096) on writes
- Method enforcement on every handler; wrong method → JSON 405
- Error responses generic (`mux command failed`); only `inputError` text is echoed

### Area: Terminal Stream (`server/stream.go`, `server/pty_*.go`, `server/herdr_stream.go`)

Check against [checklist.md](checklist.md#terminal-stream):

- `/api/mux/stream` requires auth + Host allowlist + `Sec-Fetch-Site`/`Origin` check + single-use 30s token
- Size limits: `cols`/`rows` clamped to [1, 500], 64 KiB client messages, at most 8 streams, 32 live tokens
- Keepalive and write timeouts; no URL (token) logging
- Closing a stream, SIGTERM and a hard kill of the server all end the whole child process tree (process group / `Pdeathsig` / Job Object); orphan reaping never matches unrelated processes

### Area: Herdr Backend (`server/herdr_rpc.go`, `server/mux_herdr.go`, `server/herdr_stream.go`)

Check against [checklist.md](checklist.md#herdr-backend):

- Socket JSON-RPC: one request per connection, request < 1 MiB, reply bounded, deadlines from ctx
- `herdr terminal session observe <pane>` argv built from a validated pane ID and integer sizes only
- NDJSON frames decoded defensively (bad lines skipped, never executed or echoed)
- Input queue bounded per pane; writes ordered

### Area: Go CLI (`server/cli*.go`, `server/install_layout.go`, `server/tailscale.go`)

Check against [checklist.md](checklist.md#go-cli):

- Config file 0600 (Unix) / owner-only ACL (Windows), atomic write; password AES-256-CBC with an
  HMAC keyed by a random per-install `secret` file (0600) on Unix, DPAPI on Windows
- The password never ends up in the systemd unit, launchd plist, Scheduled Task or any process
  command line (container: passed as `-e NAME` from the CLI's own environment, not a file)
- `update`: version regex, HTTPS download, sha256 check (mandatory), tar extraction refuses
  escaping paths, symlinks and backslashes; the versioned install layout (`install_layout.go`)
  switches `current` atomically and never partially removes a version
- External commands (`tailscale serve` — never with `sudo`, `off` never `reset` — `podman`/`docker run`,
  `powershell -EncodedCommand`, `netsh`) get only validated values as separate argv entries
- Process matching before kill: exact command line / image path, PID file cross-checked; never kill unrelated processes

### Area: Docker & Container (`Dockerfile`, `entrypoint.sh`, `docker-compose.yml`)

Check against [checklist.md](checklist.md#docker--container):

- Base image pinned by digest; `tini` as PID 1
- No world-writable sensitive files (/etc/passwd, /etc/group)
- No secrets in image layers; minimal installed packages
- Port published on 127.0.0.1 unless `--lan`; password and allowed hosts passed as `-e NAME`
  values from the CLI's own environment, never an env file or a command-line argument
- Runs as `--user <uid>:<gid>` (rootless podman: `--userns=keep-id`; rootless Docker: no
  `--user`); the workspace is mounted with `--mount`, not `-v`
- Sensitive host dirs excluded from mounts (.ssh, .gnupg, .aws)

### Area: Shell Scripts (`scripts/install.sh`, `scripts/install.ps1`, `scripts/termote.sh`, `scripts/termote.ps1`)

Check against [checklist.md](checklist.md#shell-scripts):

- `install.sh`/`install.ps1` (release installers): version validated, HTTPS download, `.sha256`
  checksum verification mandatory (no way to skip it), never start the server themselves
- `termote.sh`/`termote.ps1` (checkout-only dev shims): only resolve/build the `termote-dev`
  binary and `exec` it; no logic that handles secrets
- Variables quoted; no `eval` or sourcing of the saved config file

## Step 3: Report

Output a structured report:

```
## Security Review Report

### Summary
- Scope: [full / diff-only / focused]
- Files reviewed: N
- Issues: X critical, Y high, Z medium, W low

### Critical / High (must fix)
| # | Area | File:Line | Issue | Exploit path | Recommendation |

### Medium (should fix)
| # | Area | File:Line | Issue | Exploit path | Recommendation |

### Low / Informational
| # | Area | File:Line | Issue | Recommendation |

### Passed Checks
- [list of areas that passed cleanly]
```

Known, accepted decisions (do not re-raise as findings):

- `requestIsHTTPS` trusts `X-Forwarded-Proto` from any source (only affects that client's own cookie)
- Container running as root is out of scope (rejected hardening scope) — note `container up`
  otherwise runs as `--user <uid>:<gid>` (rootless podman: `--userns=keep-id`; rootless Docker:
  no `--user`)

## Step 4: Fix (if requested)

If the user asks to fix issues, apply changes directly. For each fix:

1. Edit the source file
2. Run `go build` to verify (for Go changes)
3. Run `go test` to verify tests pass
