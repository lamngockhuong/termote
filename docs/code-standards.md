# Code Standards

## File Naming

- **kebab-case** for all files: `keyboard-toolbar.tsx`, `use-gestures.ts`
- Hooks prefixed with `use-`: `use-session.ts`, `use-font-size.ts`
- Types in `types/` directory: `session.ts`

## Component Structure

```tsx
// Functional components only
export function ComponentName({ prop1, prop2 }: Props) {
  // Hooks at top
  const [state, setState] = useState();
  const ref = useRef();

  // Callbacks with useCallback
  const handleAction = useCallback(() => {
    // ...
  }, [deps]);

  // Effects
  useEffect(() => {
    // ...
  }, [deps]);

  // Render
  return <div>...</div>;
}
```

## TypeScript

- Explicit interfaces for props and state
- Avoid `any`, prefer `unknown` or proper types
- Export types from dedicated files in `types/`

```typescript
export interface Session {
  id: string;
  name: string;
  icon: string;
  description: string;
}
```

## React Patterns

- `useState` for local state
- `useCallback` for handler functions passed as props
- `useMemo` for expensive computations
- `useRef` for mutable values and DOM refs
- `forwardRef` + `useImperativeHandle` for exposing methods
- `useSyncExternalStore` for persistent state (localStorage) — see `use-settings.ts`

## Persistent State (localStorage)

When storing user preferences:

```tsx
// Use useSyncExternalStore with listener pattern
const STORAGE_KEY = "termote-settings";
const listeners = new Set<() => void>();

export interface Settings {
  imeSendBehavior: "send-only" | "send-enter";
  toolbarDefaultExpanded: boolean;
  disableContextMenu: boolean;
  pollInterval: number; // seconds
}

const DEFAULTS: Settings = {
  imeSendBehavior: "send-only",
  toolbarDefaultExpanded: false,
  disableContextMenu: true,
  pollInterval: 5,
};

function getSnapshot() {
  const json = localStorage.getItem(STORAGE_KEY) ?? "";
  return json ? { ...DEFAULTS, ...JSON.parse(json) } : DEFAULTS;
}

function writeSettings(settings: Settings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  listeners.forEach((fn) => fn());
}

export function useSettings() {
  const settings = useSyncExternalStore(subscribe, getSnapshot, () => DEFAULTS);
  const updateSetting = useCallback(
    <K extends keyof Settings>(key: K, value: Settings[K]) => {
      writeSettings({ ...settings, [key]: value });
    },
    [settings],
  );
  return { settings, updateSetting };
}
```

**Key points:**

- Define explicit Settings interface with all properties
- Provide sensible defaults for all settings
- Cache values to avoid repeated JSON parsing
- Use explicit listener subscription for SSR compatibility
- Return DEFAULTS on server/SSR to avoid hydration mismatch

## Styling

- TailwindCSS utility classes only
- Mobile-first responsive: base → `sm:` → `md:` → `lg:`
- Touch targets: `touch-manipulation` class for buttons
- Safe areas: `pb-safe` for bottom padding

```tsx
<button className="px-3 py-2 bg-zinc-700 active:bg-zinc-600 touch-manipulation">
  Click
</button>
```

## Imports Order

1. React/external libraries
2. Local components
3. Hooks
4. Utils
5. Types

```tsx
import { useState, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { KeyboardToolbar } from "./components/keyboard-toolbar";
import { useGestures } from "./hooks/use-gestures";
import { sendKeyToTerminal } from "./utils/terminal-bridge";
import type { Session } from "./types/session";
```

## Error Handling

- Async operations: try/catch with graceful fallback
- API calls: `.catch(() => {})` for non-critical failures
- Console warnings for debug info: `console.warn('[module] message')`

## Comments

- Inline comments for non-obvious logic only
- Interface comments for API documentation
- No redundant comments

## Go Standards

File layout is flat `package main` in `tmux-api/`: server code (`serve.go`, `guard.go`,
`mux*.go`, `stream.go`, `pty_*.go`) and CLI code (`cli*.go`) share the package and its build
tags (`cli_unix.go`/`cli_windows.go`, `pty_linux.go`/`pty_bsd.go`/`pty_windows.go`).

### File Naming

- **snake_case** for Go files: `serve_test.go`, `integration_test.go`
- Test files: `*_test.go`
- Server files group by concern (`mux_tmux.go`, `mux_herdr.go`); CLI files by subcommand
  (`cli_install.go`, `cli_update.go`, `cli_logs.go`, ...)
- Build tags split OS-specific code: `//go:build !windows` / `//go:build windows`

### CLI Conventions

The CLI carries every external dependency (process runner, HTTP client, clock-like state) in
a `*cli` struct (see `tmux-api/cli.go`) so tests can substitute fakes instead of touching the
real filesystem, network or OS processes:

- A subcommand is a `c.cmd*(args []string) error` method; `runCLI` maps a returned
  `*exitError` to a process exit code, anything else to exit 1
- Flags use the standard library `flag` package only (no third-party CLI/TUI library); a
  repeatable flag like `--allow-host` implements `flag.Value` (see `stringList`)
- User-facing output goes through `c.infof`/`c.warnf`/`c.errorf`, matching the `[INFO]`/`[WARN]`/`[ERROR]`
  lines 0.x printed, with ANSI color only when stdout is a terminal
- A CLI change that touches the shim contract (paths, flag names, exit behavior a 0.x install
  depends on when it relaunches the new installer during `update`) needs a fixture test
  against `testdata/config-0.1.0/` or the shim's own test suite; see
  [`upgrade-1.0.md`](upgrade-1.0.md) for what that contract covers

### Server Security

- **Input validation**: pane/tab/group IDs and request bodies are size-limited (see
  `maxJSONBody`, `maxKeysLen` in `mux.go`)
- **HTTP methods**: enforced per route (`requireMethod`), wrong method gets a JSON 405
- **Constant-time comparison**: password verification uses `subtle.ConstantTimeCompare`
- **Request guards**: every `/api/` route passes through the Host allowlist and, for write
  methods, the Origin/`Sec-Fetch-Site`/Content-Type guard — see `guard.go` and
  [`system-architecture.md`](system-architecture.md#security-model)

### Testing

**Go:**

```bash
go test ./...              # Unit + integration tests
go test ./... -cover       # With coverage
```

CI runs `go test ./...` on Ubuntu, macOS and Windows (see `.github/workflows/ci.yml`).

**PWA:**

```bash
pnpm test                         # Run all Vitest unit tests
pnpm test:e2e                     # Run Playwright e2e tests
pnpm test:e2e:ui                  # Run e2e tests with UI debugger
```

### Error Handling

- Return JSON errors with `jsonError(w, msg, code)`
- Validate all user inputs before passing to `exec.Command`
- Handle JSON decode errors explicitly (`decodeJSON` in `mux.go`)

## Shell Script Standards (termote.sh / termote.ps1)

`scripts/termote.sh` and `scripts/termote.ps1` are shims only: they resolve or build the
`tmux-api` binary and `exec` it with the same arguments (Windows maps `-Flag` to `--flag`
first). They carry no install/update/health logic — that all lives in Go (`tmux-api/cli*.go`,
see above). What remains in the shims:

- **OS/arch detection:** `$(uname)` for Darwin vs Linux, `$(uname -m)` for x86_64/aarch64,
  since the installed release ships one binary per platform (`tmux-api-<os>-<arch>`)
- **Checkout vs install:** a git checkout rebuilds `tmux-api/tmux-api-native[.exe]` when any
  Go source is newer than the binary; an installed release runs the pre-built binary next to
  the script
- **Symlink resolution (Unix):** `CDPATH= cd -P` plus a manual `readlink` loop, so the shim
  finds its own directory even when invoked through the `termote` symlink
- **0.x compatibility (contract, not convention):** the shim's path and every flag name/shape
  0.x's own `update` relies on (including `-Ttyd`) must keep working — see
  [`upgrade-1.0.md`](upgrade-1.0.md)

### Shell Testing

```bash
make test-cli   # Run tests/test-termote.sh (shim behavior only)
```

Test patterns: fake `tmux-api` binaries, capture output with command substitution, assert on
the argument list the shim passed through.
