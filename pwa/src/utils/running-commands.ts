import { visibleUnsafe } from './unsafe-chars'

// Names in order, each once, without empty ones.
export function uniqueNames(names: (string | undefined)[]): string[] {
  return [...new Set(names.filter((n): n is string => !!n))]
}

// The sentence a close confirmation adds about what it will stop, or ''
// when nothing is known to run. A process names itself, so its hidden
// characters show as ⟨U+XXXX⟩.
export function formatRunning(names: string[]): string {
  return names.length
    ? `Running: ${names.map((n) => visibleUnsafe(n)).join(', ')}.`
    : ''
}
