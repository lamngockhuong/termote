// The rules a grant's command prefix is held to, as the server holds it
// (checkGrantPrefix in server/agent_delegate_rules.go): checked here first
// so the form says what is wrong; the server's answer is final. The table
// below is a copy of server/delegate_programs.json, which the tests check
// it against, and both run server/testdata/grant-prefix-cases.json.

// The longest prefix the server takes (maxGrantPrefix)
export const MAX_GRANT_PREFIX = 200

// What chains, substitutes, expands, redirects or quotes in a shell
const BAD_CHARS = ';&|$(){}*?[]~\\\'"`><!#'

// A program with commands: the word that picks its command must be in the
// prefix and one of these. commands take any word after them; script ones
// run a script by the name that must follow them in the prefix (npm run
// lint); bare ones take no word but options (npm ci, pnpm install, npm
// audit); toolchain lets one +x come before the command (cargo +nightly)
export interface DelegateProgram {
  commands?: string[]
  script?: string[]
  bare?: string[]
  toolchain?: boolean
}

// Programs of one purpose: every word after the name is an argument
// (eslint, jest and pytest still run their config and test files, as any
// test command does)
export const TOOLS = [
  'rg',
  'grep',
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  'diff',
  'tsc',
  'eslint',
  'jest',
  'pytest',
]

export const PROGRAMS: Record<string, DelegateProgram> = {
  npm: {
    commands: ['test', 'start', 'ls', 'outdated', 'explain'],
    script: ['run'],
    bare: ['ci', 'audit'],
  },
  pnpm: {
    commands: ['test', 'start', 'ls', 'list', 'outdated', 'why'],
    script: ['run'],
    bare: ['install'],
  },
  yarn: {
    commands: ['test', 'start', 'why'],
    script: ['run'],
    bare: ['install'],
  },
  cargo: {
    commands: ['build', 'test', 'check', 'clippy', 'fmt'],
    toolchain: true,
  },
  go: { commands: ['build', 'test', 'vet', 'fmt', 'list', 'mod', 'version'] },
  dotnet: { commands: ['build', 'test'] },
  pip: { commands: ['list', 'show'] },
  vitest: { commands: ['run', 'list'] },
  biome: { commands: ['check', 'format', 'lint', 'ci'] },
  ruff: { commands: ['check', 'format'] },
}

// Options taking no value: any other option without = takes the word
// after it, so the word picking the command is never an option's value
export const FLAG_OPTIONS = [
  '-r',
  '--recursive',
  '-s',
  '--silent',
  '-w',
  '--workspace-root',
  '--parallel',
  '--stream',
  '--if-present',
  '--aggregate-output',
  '--bail',
  '--no-bail',
  '--sequential',
  '--color',
  '--no-color',
  '--frozen-lockfile',
  '--prod',
  '--dev',
  '--offline',
  '--prefer-offline',
  '--reverse',
  '--include-workspace-root',
  '-D',
  '-P',
  '-O',
]

// empty: nothing typed; length: longer than the server takes; chars: a
// character or a spacing it refuses; program: a first word that is not a
// program of the table, spelled as it spells it (no path, no extension, no
// other case); command: a program without one of its commands, a script
// command without the script's name, or a bare command with a word that
// is no option; path: a tool's word that is an absolute path, a Windows
// drive or holds a .. component. The server also refuses, which a prefix
// alone cannot show: a command whose words after the prefix look like
// options, and a tool run outside the grant's folder or led out of it
// through a link
export type PrefixProblem =
  | 'empty'
  | 'length'
  | 'chars'
  | 'program'
  | 'command'
  | 'path'

// What is wrong with prefix, or null when the server would take it. The
// prefix is checked as typed: the server trims it, but a space typed inside
// is refused there too.
export function grantPrefixProblem(prefix: string): PrefixProblem | null {
  const p = prefix.trim()
  if (p === '') return 'empty'
  if (p.length > MAX_GRANT_PREFIX) return 'length'
  for (const c of p) {
    const code = c.codePointAt(0) as number
    if (code < 0x20 || code > 0x7e || BAD_CHARS.includes(c)) return 'chars'
  }
  const words = p.split(' ')
  // One space between words, none around
  if (words.includes('')) return 'chars'
  // A tool reads the files its words name: none may be absolute or climb
  // out with .. (the server also holds where it runs to the grant's folder)
  if (TOOLS.includes(words[0]))
    return words.slice(1).some(pathWordLeaves) ? 'path' : null
  if (!Object.hasOwn(PROGRAMS, words[0])) return 'program'
  const prog = PROGRAMS[words[0]]
  const start = prog.toolchain && words[1]?.startsWith('+') ? 2 : 1
  const k = commandWord(words, start)
  if (k < 0) return 'command'
  const c = words[k]
  if (prog.commands?.includes(c)) return null
  if (prog.script?.includes(c))
    return commandWord(words, k + 1) < 0 ? 'command' : null
  if (prog.bare?.includes(c))
    return words.slice(k + 1).every((w) => w.startsWith('-')) ? null : 'command'
  return 'command'
}

// The path a word of a tool may name: the word, an option's value after =,
// a short option's attached value (-fx), what follows @ or +; '' for an
// option with none (pathWordValue)
function pathWordValue(w: string): string {
  if (w.startsWith('-')) {
    const i = w.indexOf('=')
    if (i >= 0) return w.slice(i + 1)
    return !w.startsWith('--') && w.length > 2 ? w.slice(2) : ''
  }
  if (w.startsWith('@') || w.startsWith('+')) return w.slice(1)
  return w
}

// An absolute path, a Windows drive (C:x) or a .. component (pathWordLeaves)
function pathWordLeaves(w: string): boolean {
  const v = pathWordValue(w)
  return (
    v.startsWith('/') || /^[A-Za-z]:/.test(v) || v.split('/').includes('..')
  )
}

// The index of the word picking a program's command, from start on, past
// options and their values, or -1 (commandWord)
function commandWord(words: string[], start: number): number {
  for (let i = start; i < words.length; i++) {
    const w = words[i]
    if (!w.startsWith('-')) return i
    if (!w.includes('=') && !FLAG_OPTIONS.includes(w)) i++
  }
  return -1
}
