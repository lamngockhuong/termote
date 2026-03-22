# Contributing to Termote

## Getting Started

```bash
git clone https://github.com/lamngockhuong/termote.git
cd termote
make build
make deploy-container
```

## Development Setup

### Prerequisites

- Node.js 18+
- pnpm
- Go 1.21+
- Docker (optional)

### PWA Development

```bash
cd pwa
pnpm install
pnpm dev          # Dev server at http://localhost:5173
pnpm tsc --noEmit # Type check
pnpm lint         # Biome
```

### tmux-api Development

```bash
cd tmux-api
go build -o tmux-api .
./tmux-api        # Runs on :7682
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
make test              # All tests
make test-deploy       # Deploy script tests
make test-uninstall    # Uninstall script tests

# E2E (requires running server)
cd pwa && pnpm test:e2e
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
├── tmux-api/      # Go server (PWA + proxy + API + auth)
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
