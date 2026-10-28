# Release Guide

## Overview

Termote uses automated release workflows with multiple triggers and multi-arch Docker builds.
A release is never public until every asset is on it and its Docker tags exist: `release.yml`
pushes the image by digest, creates (or reuses) the GitHub Release as a draft, uploads every
archive/checksum after the approval, moves the Docker tags to the signed digest, and only then
publishes the release.

## Triggers

| Method          | Command/Action                          | Use Case                        |
| --------------- | --------------------------------------- | ------------------------------- |
| Release Please  | Push to `main` (or run manually)        | Batch commits into a release PR |
| Manual (local)  | `make release VERSION=x.y.z`            | Quick release                   |
| Manual (remote) | GitHub Actions → Release → Run workflow | Remote trigger                  |
| Tag push        | `git tag -a vx.y.z && git push --tags`  | Direct tag                      |

## Version Strategy

### Semantic Versioning

```
MAJOR.MINOR.PATCH[-PRERELEASE]
  │     │     │       │
  │     │     │       └── rc.1, rc.2, etc.
  │     │     └── Bug fixes (backwards compatible)
  │     └── New features (backwards compatible)
  └── Breaking changes
```

### Version Types

| Type   | Format       | Trigger                        | Example      |
| ------ | ------------ | ------------------------------ | ------------ |
| RC     | `x.y.z-rc.N` | Test before stable             | `1.0.0-rc.1` |
| Stable | `x.y.z`      | Production ready               | `1.0.0`      |
| Patch  | `x.y.z+1`    | `fix:` commits                 | `1.0.1`      |
| Minor  | `x.y+1.0`    | `feat:` commits                | `1.1.0`      |
| Major  | `x+1.0.0`    | `feat!:` or `BREAKING CHANGE:` | `2.0.0`      |

### RC Flow

```
1.0.0-rc.1 → find bugs → fix → 1.0.0-rc.2 → stable → 1.0.0
```

**Rules:**

- Only bug fixes between RCs, no new features
- Set `release-as` and `prerelease: true` in `release-please-config.json` for an RC, bumping
  the RC number for each new one, then set `release-as` back to the plain version (and
  `prerelease: false`) for the stable release
- RC tags don't update the `latest` Docker tag or the website (the website only deploys stable
  releases; test an RC installer from the raw GitHub tag URL instead — see
  [`getting-started.md`](getting-started.md))

## Commit Conventions

Release Please uses conventional commits to determine version bump:

```bash
feat: add new feature          # Minor bump
fix: resolve bug               # Patch bump
feat!: breaking change         # Major bump
docs: update readme            # No bump
chore: update deps             # No bump
```

## Workflows

### Release Please (Recommended)

1. Push conventional commits to `main`
2. `release-please.yml` opens or updates the `chore: release x.y.z` PR (CHANGELOG, version bump)
3. Merging the PR creates the tag; `release-please.yml` then starts `release.yml` on that tag
   (`workflow_dispatch`, not `workflow_call`: a called workflow does not get the `release`
   environment's signing key, actions/runner#1490)
4. Approve the run's `release` deployment in GitHub Actions: only then is `checksums.txt` signed
   and the release published

### Manual Release

```bash
# Preview unreleased commits
make release-dry

# Create and push tag
make release VERSION=1.0.0
```

### Release Pipeline

```
Tag created
    ↓
┌──────────────────────────────────────────────────────────────────────┐
│ prepare: extract version, image tags                                 │
├──────────────────────────────────────────────────────────────────────┤
│ build-pwa ──────┐                                                    │
│ build (5 OS/arch) ──→ docker ──→ release ──→ docker-tags ──→ publish │
└──────────────────────────────────────────────────────────────────────┘
    ↓
docker:      image pushed to GHCR by digest (no tag), before the approval
release:     waits for the approval, signs checksums.txt, uploads to the draft
docker-tags: x.y.z, x.y, latest (GHCR + Docker Hub) moved to the signed digest
publish:     the draft goes public, then the website deploys
```

A `v*` tag pushed without the approval moves no tag anyone pulls through this workflow. A writer is
not stopped by it: any workflow run from a ref a writer pushes (a branch or a tag, any workflow
file) gets the repository's `DOCKERHUB_*` secrets and can ask for `packages: write`. That residual
risk is accepted (Lam Ngoc Khuong, 2026-10-23).

## Setup

### GitHub Secrets (Required)

| Secret               | Source                           | Purpose         |
| -------------------- | -------------------------------- | --------------- |
| `GITHUB_TOKEN`       | Auto-provided                    | GHCR + Release  |
| `DOCKERHUB_USERNAME` | hub.docker.com                   | Docker Hub auth |
| `DOCKERHUB_TOKEN`    | hub.docker.com/settings/security | Docker Hub auth |

### Add Docker Hub Secrets

1. Create token: https://hub.docker.com/settings/security
2. Add secrets: https://github.com/lamngockhuong/termote/settings/secrets/actions
   - `DOCKERHUB_USERNAME` = `lamngockhuong`
   - `DOCKERHUB_TOKEN` = `<token>`

## Artifacts

Each release produces, per platform (`linux`/`darwin` × `amd64`/`arm64`, plus
`windows`/`amd64`):

| Artifact                                | Description                                       |
| --------------------------------------- | ------------------------------------------------- |
| `termote-<v>-<os>-<arch>.tar.gz`/`.zip` | Archive holding `bin/termote[.exe]` and `LICENSE` |
| `termote-<v>-<os>-<arch>.tar.gz.sha256` | Checksum of that archive                          |
| `checksums.txt`                         | All checksums concatenated                        |
| `checksums.txt.sig`                     | Ed25519 signature of `checksums.txt` (1.10.0+)    |
| `checksums.txt.sshsig`                  | Same key, SSHSIG for `ssh-keygen -Y` (2.14.0+)    |

`scripts/install.sh`/`install.ps1` verify the per-archive `.sha256`; there is no separate
"full tarball" or PWA-only zip artifact in 1.0.

## Docker Images

### Registries

| Registry   | Image                           |
| ---------- | ------------------------------- |
| GHCR       | `ghcr.io/lamngockhuong/termote` |
| Docker Hub | `lamngockhuong/termote`         |

### Tags

| Tag      | Description                                |
| -------- | ------------------------------------------ |
| `latest` | Latest stable release (not RC/pre-release) |
| `x.y.z`  | Specific version                           |
| `x.y`    | Latest patch of minor                      |

**Note:** Pre-release versions (`-rc.N`) don't update the `latest` tag.

### Image

| Image     | Description                          |
| --------- | ------------------------------------ |
| `termote` | All-in-one (termote + tmux, no ttyd) |

## Website Deploys

`deploy-website.yml` does not run on pushes to `main`. `release.yml` calls it after a
stable release (not a pre-release) has been published, and it can be run by hand from GitHub
Actions for a docs-only fix. This keeps the site's root docs — and the installer scripts it
serves at `https://termote.ohnice.app/install.sh`/`install.ps1` — on the version
`releases/latest` installs, while `main` runs ahead of it. Test a pre-release installer from
the raw GitHub tag URL instead (see [`deployment-guide.md`](deployment-guide.md#pre-releases)).

## Maintaining 0.x

0.x lives on the `release/0.x` branch (cut from `v0.1.0`) and only takes security and critical
fixes; no features, refactors or non-security dependency bumps. There is no upgrade path from
0.x to 1.x — a 0.x user uninstalls following the archived
[0.x documentation](https://termote.ohnice.app/0.x/), then installs 1.x fresh.

- Fix on `main` first, then `git cherry-pick -x <sha>` onto `release/0.x`
  (open the PR against `release/0.x`). Fix on `release/0.x` directly only when
  the 1.x code no longer has the bug.
- Release Please runs on `release/0.x` with its own config there: every release
  is a patch bump (`0.1.x`), and the GitHub release is created as a draft and
  published with `make_latest: false`.
- The release workflow on `release/0.x` tags Docker images `0.1` and `0.1.x`
  only, never `latest`, and does not sync the Docker Hub README.
- The website is built from `main` only. Its 0.x docs are archived with
  `starlight-versions` under `website/src/content/docs/0.x/` (and `vi/0.x/`),
  served at `/0.x/`; fix 0.x docs there on `main`, not on `release/0.x`.

`releases/latest` must always be a 1.x release: `termote update` and the installer scripts
compare against it, so a 0.x patch marked latest would downgrade every 1.x install that runs
`update`. If a 0.x release is ever marked latest by mistake, re-mark the newest 1.x release
(`gh release edit v1.x.y --latest`).

## Troubleshooting

### Workflow fails at Docker push or Docker tags

- Check `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` secrets
- Verify Docker Hub token has Read & Write permissions
- A failed `docker-tags` leaves the release a draft: re-run the failed jobs. `release` already
  succeeded, so it does not run or wait for an approval again

### Release Please doesn't create a PR

- Ensure commits follow conventional format
- Check the workflow ran (push to `main`, or trigger it manually)

### ARM64 build slow

- Uses native ARM runner (`ubuntu-24.04-arm`)
- If unavailable, falls back to QEMU emulation

### Version mismatch

- `pwa/package.json`, `server/cli_version.go` and `herdr-plugin/herdr-plugin.toml` (the
  `# x-release-please-version` line) are synced by `release-please-config.json`'s `extra-files`;
  the release workflow's `sync-version` job also syncs `pwa/package.json` on a tag push
- `.release-please-manifest.json` tracks the Release Please version
