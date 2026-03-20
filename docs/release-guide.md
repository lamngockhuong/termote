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

| Image     | Description                  |
| --------- | ---------------------------- |
| `termote` | All-in-one (tmux-api + ttyd) |

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
