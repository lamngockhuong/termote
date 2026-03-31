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
}

const DEFAULTS: Settings = {
  imeSendBehavior: "send-only",
  toolbarDefaultExpanded: false,
  disableContextMenu: true,
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
import { Terminal } from "xterm";
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

### File Naming

- **snake_case** for Go files: `serve_test.go`, `integration_test.go`
- Test files: `*_test.go`
- Integration tests: use `//go:build integration` tag

### Security

- **Input validation**: All tmux targets validated with regex `^[a-zA-Z0-9_\-:.]+$`
- **HTTP methods**: Mutations require POST/DELETE, reads require GET
- **Length limits**: Keys limited to 4096 bytes, targets to 64 chars
- **Constant-time comparison**: Password verification uses `subtle.ConstantTimeCompare`

### Testing

**Go:**

```bash
go test                           # Unit tests only (59%)
go test -tags=integration         # Unit + Integration (71%)
go test -tags=integration -cover  # With coverage
```

**PWA:**

```bash
pnpm test                         # Run all Vitest unit tests
pnpm test:e2e                     # Run Playwright e2e tests
pnpm test:e2e:ui                  # Run e2e tests with UI debugger
```

### Error Handling

- Return JSON errors with `jsonError(w, msg, code)`
- Validate all user inputs before passing to exec.Command
- Handle JSON decode errors explicitly
