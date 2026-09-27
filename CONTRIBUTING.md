# Contributing to Termote

## Getting Started

```bash
git clone https://github.com/lamngockhuong/termote.git
cd termote
make build
make container-up   # or: make start (native, through the dev shim)
```

## Development Setup

### Prerequisites

- Node.js 18+
- pnpm
- Go 1.24+
- Docker (optional)

### Workspace Setup

This repo is a **pnpm workspace** (`pwa` + `website`) with a single root `pnpm-lock.yaml`.
Install everything once from the repo root:

```bash
pnpm install      # Installs all workspace packages
```

### PWA Development

```bash
# From repo root (workspace-aware):
pnpm --filter termote dev   # Dev server at http://localhost:5173
pnpm --filter termote build

# Or from the package directory:
cd pwa
pnpm dev          # Dev server at http://localhost:5173
pnpm tsc --noEmit # Type check
pnpm lint         # Biome
```

### Website Development

```bash
pnpm --filter @termote/website dev    # Docs site
pnpm --filter @termote/website build
```

### Server Development

```bash
cd server
go build -o termote-dev .
./termote-dev serve  # Runs on :7680 (no saved config: reads TERMOTE_* env vars)
```

## Code Standards

- **File naming**: kebab-case (`keyboard-toolbar.tsx`)
- **Hooks**: Prefix with `use-` (`use-gestures.ts`)
- **Components**: Functional components with TypeScript
- **Styling**: TailwindCSS utilities

See [docs/code-standards.md](docs/code-standards.md) for details.

## Formatting

```bash
make fmt         # Format markdown/mdx files
make fmt-check   # Check formatting (CI)
```

**MDX Caveat:** When editing MDX files with Astro components (`<Steps>`, `<Tabs>`), ensure closing tags are NOT indented:

```mdx
<Steps>
1. Step one
2. Step two

</Steps>   <!-- Correct: at line start -->
```

Indented closing tags break the build.

## Testing

```bash
make test              # All tests: go test, dev shim, install.sh, entrypoints
make test-go           # go test ./... in server/
make test-cli          # tests/test-termote.sh (dev shim behavior)
make test-install      # tests/test-install.sh (install.sh, fake curl)
make test-entrypoints  # Docker entrypoint tests

# E2E (requires running server, e.g. `make start`)
pnpm --filter termote test:e2e
```

## Commit Messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add new gesture support
fix: resolve WebSocket reconnection issue
docs: update deployment guide
refactor: simplify session management
test: add e2e tests for sidebar
chore: update dependencies
```

## Pull Request Process

1. Fork and create feature branch from `main`
2. Make changes with tests
3. Run `make test` and `pnpm tsc --noEmit`
4. Submit PR with clear description

### PR Checklist

- [ ] Code follows project conventions
- [ ] Tests pass locally
- [ ] TypeScript compiles without errors
- [ ] Commit messages follow conventional format
- [ ] Documentation updated if needed

## Project Structure

```
termote/
├── pwa/           # React PWA frontend
├── server/        # Go server + CLI (PWA + terminal stream + API + auth)
├── scripts/       # Shell scripts
├── tests/         # Test suite
└── docs/          # Documentation
```

## Reporting Issues

- Use GitHub Issues
- Include: OS, browser, deployment mode
- Provide steps to reproduce
- Attach logs if applicable

## License

By contributing, you agree that your contributions will be licensed under MIT.
