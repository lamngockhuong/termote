---
title: atk project profile
status: APPROVED
owner: Lam Ngoc Khuong
approver: Lam Ngoc Khuong
created: 2026-10-05
updated: 2026-10-05
ticket: none
---

# atk project profile

Written by `/atk:init`. Read by the atk skills that need project facts. Re-check it with
`/atk:init --audit`.

Committed on purpose: the next person on the team inherits it.

## Project

- Name: Termote
- Repository: lamngockhuong/termote
- Shape: monorepo
- Package manager: pnpm <!-- source: pnpm-lock.yaml, pnpm-workspace.yaml -->; go modules for `server/` <!-- source: server/go.sum -->

## Layers

| Layer       | Directory                                              | Standards                                  | Reference module                                     |
| ----------- | ------------------------------------------------------ | ------------------------------------------ | ---------------------------------------------------- |
| server (Go) | `server/`                                              | `docs/code-standards.md`                   | `server/files_raw.go` (+ `server/files_raw_test.go`) |
| pwa         | `pwa/`                                                 | `docs/code-standards.md`, `pwa/biome.json` | `pwa/src/hooks/use-git-changes.ts`                   |
| website     | `website/`                                             | `dprint.json`                              | `website/src/content/docs/`                          |
| scripts     | `scripts/`, `tests/`, `entrypoint.sh`, `herdr-plugin/` | `docs/code-standards.md`                   | `tests/test-install.sh`                              |

<!-- source: pnpm-workspace.yaml (pwa, website), server/go.mod, CLAUDE.md "Project Structure" -->

## Commands

| App or package     | Repository | Test                                                                             | Build                                  | Lint                            | Extra                                                                                                                                  |
| ------------------ | ---------- | -------------------------------------------------------------------------------- | -------------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| pwa (`termote`)    | -          | `pnpm --filter termote test:coverage`, `pnpm --filter termote exec tsc --noEmit` | `pnpm --filter termote build`          | `pnpm --filter termote lint:ci` | E2E (needs a running server, see Verify): `pnpm --filter termote exec playwright test --workers=1 --grep-invert "Capture screenshots"` |
| server             | -          | `cd server && go test ./...`                                                     | `make build-api`                       | `cd server && go vet ./...`     | `cd server && go run golang.org/x/vuln/cmd/govulncheck@v1.8.0 ./...`                                                                   |
| website            | -          | none                                                                             | `pnpm --filter @termote/website build` | none                            | none                                                                                                                                   |
| scripts            | -          | `make test-cli test-install test-entrypoints test-herdr-plugin`                  | none                                   | none                            | none                                                                                                                                   |
| docs/markdown/yaml | -          | none                                                                             | none                                   | `make fmt-check`                | none                                                                                                                                   |

- Setup: `pnpm install`

<!-- source: .github/workflows/ci.yml:77-98 (pwa), :132-172 (server), :273-283 (scripts), :394-399 (website), :409 (format); Makefile:50-89 -->
<!-- `pnpm --filter termote lint` runs `biome check --write` and edits files; use lint:ci to check only. -->
<!-- `test` is `vitest run` (safe); `test:watch` is the watch mode. Coverage provider @vitest/coverage-v8 is a devDependency. -->
<!-- CI gate: go-test runs on ubuntu, macos and windows; test-windows runs tests/*.ps1, which cannot run locally on Linux. -->

## Docs

- Docs root: `docs/`
- Authored language: `en`
- Language mirrors: `docs/vi/`
- Conventions: `docs/code-standards.md`, `CONTRIBUTING.md`, `pwa/biome.json`, `dprint.json`, `.github/PULL_REQUEST_TEMPLATE.md` (review checklist: none yet)
- Designs: `docs/design-guidelines.md`
- Contract: `code`
- Agent instructions: `CLAUDE.md`

## Tracker

- Tracker: GitHub Issues
- Repository owner: lamngockhuong
- Spec lives in: GitHub Issues of lamngockhuong/termote, plus `docs/`

<!-- source: git remote origin (git@lamngockhuong.github.com:lamngockhuong/termote.git, an SSH alias for github.com) -->

## Team

| Role      | Name            | Host identifier | Approves                                                     |
| --------- | --------------- | --------------- | ------------------------------------------------------------ |
| PM        | Lam Ngoc Khuong | @lamngockhuong  | scope, requirements, releases                                |
| Tech Lead | Lam Ngoc Khuong | @lamngockhuong  | profile, designs, code review, fixes, security residual risk |

- Working language: Vietnamese (artifacts); code, comments and `docs/` stay in English

## Verify

- Runs from: -
- Start: `pnpm --filter termote build && find server/webui/dist -mindepth 1 ! -name .gitkeep -delete && cp -R pwa/dist/. server/webui/dist/ && (cd server && CGO_ENABLED=0 go build -o termote-dev .)`, then `TERMOTE_NO_AUTH=true TERMOTE_BIND=127.0.0.1 TERMOTE_PORT=7681 XDG_CONFIG_HOME=<tmp>/xdg XDG_CACHE_HOME=<tmp>/cache TMUX_SOCKET=<tmp>/tmux.sock ./server/termote-dev serve`
- Ready when: `curl -fsS http://localhost:7681/api/mux/health` succeeds
- Logs: the `serve` process stdout/stderr (redirect to `<tmp>/serve.log`)
- Data check: `curl -fsS http://localhost:7681/api/mux/snapshot`; `tmux -S <tmp>/tmux.sock list-windows -a`
- Prepare: none (no data store)
- Shared stores: none (tmux socket, config and upload dirs are all under `<tmp>`)
- Cleanup: stop the `serve` process (SIGTERM), then `tmux -S <tmp>/tmux.sock kill-server`
- Local only: binds `127.0.0.1:7681`; port 7680 is left to the installed service. `XDG_CONFIG_HOME` must point at `<tmp>` so the saved config in `~/.config/termote` is not read

<!-- source: .github/workflows/ci.yml:183-243 (env, build, start, readiness, playwright), server/serve.go:64, server/mux_tmux.go:17-21, Makefile:50-54 -->
<!-- Not `make start`: it registers and starts an OS service. -->
