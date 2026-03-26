---
name: security-review
description: Comprehensive security review for Termote. Use when reviewing PRs, auditing code, or before releases. Covers auth bypass, command injection, DoS, and terminal-specific attack vectors.
allowed-tools: Read, Grep, Glob, Bash(git diff*, git log*, git show*), Agent
argument-hint: "[--full | --diff-only] [--focus auth|api|terminal|docker|shell]"
---

# Termote Security Review

Review Termote for security vulnerabilities, tailored to its architecture: Go server (tmux-api) + React PWA + shell scripts + Docker.

## Arguments

- `--full`: Scan entire codebase (default if no unstaged changes)
- `--diff-only`: Only review changed files
- `--focus <area>`: Focus on specific area (auth, api, terminal, docker, shell)

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

## Step 2: Review by Area

Launch parallel review agents for each relevant area. Pass the diff or file contents to each agent.

### Area: Auth & Access Control (`tmux-api/serve.go`)

Check against [checklist.md](checklist.md#auth--access-control):
- Basic auth on ALL endpoints (no bypass paths)
- Rate limiting on auth failures
- Constant-time password comparison
- `/terminal/` 3-layer protection: auth + Sec-Fetch-Dest + single-use token
- Token entropy (>= 128 bits), TTL (<= 30s), single-use enforcement
- No auth credentials in logs or error responses

### Area: API & Command Injection (`tmux-api/tmux.go`)

Check against [checklist.md](checklist.md#api--command-injection):
- All tmux targets validated against `validTmuxID` regex
- No user input passed to shell commands without validation
- Request body size limits on POST endpoints
- Method enforcement on all handlers (GET/POST/DELETE)
- Error responses don't leak internal details (tmux paths, socket info)
- Keys length limit on send-keys endpoint

### Area: Terminal & WebSocket (`tmux-api/serve.go`, `pwa/src/`)

Check against [checklist.md](checklist.md#terminal--websocket-proxy):
- ttyd binds to localhost only (not 0.0.0.0)
- WebSocket proxy has dial timeout
- iframeOnly middleware blocks direct navigation
- PostMessage uses explicit origin (not `*`)
- No XSS via terminal bridge (sendData, sendKeyToTerminal)
- HTTP server has ReadHeaderTimeout (Slowloris protection)

### Area: Docker & Container (`Dockerfile`, `entrypoint.sh`)

Check against [checklist.md](checklist.md#docker--container):
- No world-writable sensitive files (/etc/passwd, /etc/shadow)
- No secrets in image layers
- Minimal installed packages
- Non-root user where possible
- Sensitive host dirs excluded from mounts (.ssh, .gnupg)

### Area: Shell Scripts (`scripts/termote.sh`, `scripts/get.sh`)

Check against [checklist.md](checklist.md#shell-scripts):
- Variables quoted in commands ("$VAR" not $VAR)
- No eval or unquoted command substitution with user input
- Input validation on ports, IPs, hostnames
- Download verification (checksums) in get.sh
- No secrets logged to files

## Step 3: Report

Output a structured report:

```
## Security Review Report

### Summary
- Scope: [full / diff-only / focused]
- Files reviewed: N
- Issues: X critical, Y medium, Z low

### Critical (must fix)
| # | Area | File:Line | Issue | Recommendation |

### Medium (should fix)
| # | Area | File:Line | Issue | Recommendation |

### Low / Informational
| # | Area | File:Line | Issue | Recommendation |

### Passed Checks
- [list of areas that passed cleanly]
```

## Step 4: Fix (if requested)

If the user asks to fix issues, apply changes directly. For each fix:
1. Edit the source file
2. Run `go build` to verify (for Go changes)
3. Run `go test` to verify tests pass
