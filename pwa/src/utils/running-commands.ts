// Names in order, each once, without empty ones.
export function uniqueNames(names: (string | undefined)[]): string[] {
  return [...new Set(names.filter((n): n is string => !!n))]
}

// The sentence a close confirmation adds about what it will stop, or ''
// when nothing is known to run.
export function formatRunning(names: string[]): string {
  return names.length ? `Running: ${names.join(', ')}.` : ''
}
