# Release Guide

## Overview

Termote uses automated release workflows with multiple triggers and multi-arch Docker builds.

## Triggers

| Method          | Command/Action                          | Use Case                   |
| --------------- | --------------------------------------- | -------------------------- |
| Release Please  | GitHub Actions UI → Run workflow        | Batch commits into release |
| Manual (local)  | `make release VERSION=x.y.z`            | Quick release              |
| Manual (remote) | GitHub Actions → Release → Run workflow | Remote trigger             |
| Tag push        | `git tag -a vx.y.z && git push --tags`  | Direct tag                 |

## Version Strategy

### Semantic Versioning

```
MAJOR.MINOR.PATCH[-PRERELEASE]
  │     │     │       │
  │     │     │       └── rc1, rc2, beta1, etc.
  │     │     └── Bug fixes (backwards compatible)
  │     └── New features (backwards compatible)
  └── Breaking changes
```

### Version Types

| Type   | Format      | Trigger                        | Example     |
| ------ | ----------- | ------------------------------ | ----------- |
| RC     | `x.y.z-rc1` | Test before stable             | `1.0.0-rc1` |
| Stable | `x.y.z`     | Production ready               | `1.0.0`     |
| Patch  | `x.y.z+1`   | `fix:` commits                 | `1.0.1`     |
| Minor  | `x.y+1.0`   | `feat:` commits                | `1.1.0`     |
| Major  | `x+1.0.0`   | `feat!:` or `BREAKING CHANGE:` | `2.0.0`     |

### Pre-1.0 Version Rules

While version < 1.0.0, bump behavior is conservative:

| Commit             | Normal (≥1.0) | Pre-1.0 (current) |
| ------------------ | ------------- | ----------------- |
| `fix:`             | Patch         | **Patch**         |
| `feat:`            | Minor         | **Patch**         |
| `feat!:`           | Major         | **Minor**         |
| `BREAKING CHANGE:` | Major         | **Minor**         |

**Example** (current 0.0.9):

- `fix: bug` → 0.0.10
- `feat: new feature` → 0.0.10 (not 0.1.0)
- `feat!: breaking change` → 0.1.0 (not 1.0.0)

This is configured via `bump-minor-pre-major` and `bump-patch-for-minor-pre-major` in `release-please-config.json`.

### RC Flow

```
1.0.0-rc1 → find bugs → fix → 1.0.0-rc2 → stable → 1.0.0
```

**Rules:**

- Only bug fixes between RCs, no new features
- When RC has no bugs → release stable
- RC tags don't update `latest` Docker tag

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

1. Push commits to `main` with conventional format
2. Go to **Actions** → **Release Please** → **Run workflow**
3. Creates PR with CHANGELOG and version bump
4. Merge PR → automatically triggers release

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
┌─────────────────────────────────────────┐
│ prepare: extract version                │
├─────────────────────────────────────────┤
│ build-pwa ──────┐                       │
│ build-api-amd64 ├──→ docker ──→ release │
│ build-api-arm64 ┘                       │
└─────────────────────────────────────────┘
    ↓
Docker images pushed (GHCR + Docker Hub)
GitHub Release created with artifacts
```

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

Each release produces:

| Artifact                | Description          |
| ----------------------- | -------------------- |
| `termote-vX.Y.Z.tar.gz` | Full release tarball |
| `pwa-dist-vX.Y.Z.zip`   | PWA static files     |
| `tmux-api-linux-amd64`  | API binary (x86_64)  |
| `tmux-api-linux-arm64`  | API binary (ARM64)   |
| `termote.sh`            | Unified CLI          |
| `checksums.txt`         | SHA256 checksums     |

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

**Note:** Pre-release versions (`-rc1`, `-beta`) don't update `latest` tag.

### Image

| Image     | Description                           |
| --------- | ------------------------------------- |
| `termote` | All-in-one (tmux-api + tmux, no ttyd) |

## 1.0.0 Release Procedure

1.0.0 is a breaking release developed on the long-lived `feat/1.0` branch,
kept separate from `main` so `main` could keep shipping 0.1.x patches. To
release it:

1. Make sure the `release/0.x` maintenance branch exists (cut from `v0.1.0`,
   see [Maintaining 0.x](#maintaining-0x)) so 0.x patches have somewhere to
   ship once `main` becomes 1.x.
2. Merge `feat/1.0` into `main` once (a merge commit with a `feat!:` subject
   and a `BREAKING CHANGE:` footer), with the breaking changes documented in
   [`upgrade-1.0.md`](upgrade-1.0.md).
3. Before running Release Please, set `release-as: 1.0.0` for the package in
   `release-please-config.json`. Without it, `bump-minor-pre-major: true`
   would turn the `feat!:` merge into `0.2.0` instead of `1.0.0`.
4. Run the release as usual (see Workflows above).
5. Remove `release-as` from `release-please-config.json` right after the
   release goes out, or every later release stays pinned to 1.0.0.

## Maintaining 0.x

After 1.0.0, `main` is the 1.x line. 0.x lives on the `release/0.x` branch
(cut from `v0.1.0`) and only takes security and critical fixes; no features,
refactors or non-security dependency bumps.

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

`releases/latest` must always be a 1.x release: `termote update`, `get.sh`,
`get.ps1` and the PWA update check all install or compare against it, so a 0.x
patch marked latest would downgrade every 1.x install that runs `update`. If a
0.x release is ever marked latest by mistake, re-mark the newest 1.x release
(`gh release edit v1.x.y --latest`).

## Troubleshooting

### Workflow fails at Docker push

- Check `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` secrets
- Verify Docker Hub token has Read & Write permissions

### Release Please doesn't create PR

- Ensure commits follow conventional format
- Check workflow was triggered manually

### ARM64 build slow

- Uses native ARM runner (`ubuntu-24.04-arm`)
- If unavailable, falls back to QEMU emulation

### Version mismatch

- `package.json` synced by release workflow (tag push) or Release Please (workflow_call)
- `.release-please-manifest.json` tracks Release Please version
