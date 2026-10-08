// Names a pane's shell has while it waits for input, as the server knows
// them (knownShells in server/mux_process.go, both read
// server/testdata/known-shells.json in their tests).
const KNOWN_SHELLS = new Set([
  'ash',
  'bash',
  'cmd',
  'csh',
  'dash',
  'elvish',
  'fish',
  'ksh',
  'mksh',
  'nu',
  'powershell',
  'pwsh',
  'sh',
  'tcsh',
  'xonsh',
  'yash',
  'zsh',
])

export const knownShells = (): string[] => [...KNOWN_SHELLS]

// A process name is a shell's: compared lower-case, without ".exe".
export function isShell(name?: string): boolean {
  if (!name) return false
  return KNOWN_SHELLS.has(name.toLowerCase().replace(/\.exe$/, ''))
}
