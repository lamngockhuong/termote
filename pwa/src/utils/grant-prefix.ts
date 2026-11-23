// The rules a grant's command prefix is held to, as the server holds it
// (checkDelegateCommand in server/agent_delegate_rules.go): checked here
// first so the form says what is wrong; the server's answer is final.

// The longest prefix the server takes (maxGrantPrefix)
export const MAX_GRANT_PREFIX = 200

// What chains, substitutes, expands, redirects or quotes in a shell
const BAD_CHARS = ';&|$(){}*?[]~\\\'"`><!#'

// First words a prefix never starts with: a shell, an interpreter, or a
// program that runs another one (delegateInterpreters). git runs any
// program through its options and its config.
const INTERPRETERS = new Set([
  'bash',
  'sh',
  'zsh',
  'dash',
  'fish',
  'ksh',
  'csh',
  'tcsh',
  'pwsh',
  'powershell',
  'cmd',
  'env',
  'sudo',
  'doas',
  'su',
  'command',
  'builtin',
  'nice',
  'time',
  'script',
  'ssh',
  'npx',
  'pnpx',
  'bunx',
  'dlx',
  'uvx',
  'uv',
  'pipx',
  'tsx',
  'ts-node',
  'busybox',
  'node',
  'deno',
  'bun',
  'python',
  'perl',
  'ruby',
  'php',
  'lua',
  'awk',
  'eval',
  'exec',
  'source',
  '.',
  'xargs',
  'find',
  'nohup',
  'timeout',
  'watch',
  'make',
  'git',
  // sed and ed run a program from their script (sed's e command, ed's !)
  'sed',
  'ed',
])

// A versioned name of an interpreter: python3.12 (interpreterVersionRe)
const VERSIONED = /^(python|perl|ruby|php|lua|node|deno|bun)[0-9.]*$/

// Package managers with a word that runs any package: pnpm dlx x, npm exec
// x, also after options (pnpm -s exec x, pnpm --filter a exec x), so it is
// refused at any position after the program's name (delegateRunners)
const RUNNERS: Record<string, string[]> = {
  npm: ['exec', 'x'],
  pnpm: ['dlx', 'exec', 'x'],
  yarn: ['dlx', 'exec'],
  bun: ['x'],
}

// Windows extensions a program's name drops, each once in this order
// (commandName)
const EXTENSIONS = ['.exe', '.cmd', '.bat', '.com', '.ps1']

// empty: nothing typed; length: longer than the server takes; chars: a
// character or a spacing it refuses; interpreter: a first word (or a
// package manager's runner word, at any position) that runs any code at
// all. The server also refuses a command whose words after the prefix
// start with -, which a prefix alone cannot show.
export type PrefixProblem = 'empty' | 'length' | 'chars' | 'interpreter'

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
  const first = commandName(words[0])
  if (INTERPRETERS.has(first) || VERSIONED.test(first)) return 'interpreter'
  if (Object.hasOwn(RUNNERS, first)) {
    const runs = RUNNERS[first]
    if (words.slice(1).some((w) => runs.includes(w.toLowerCase())))
      return 'interpreter'
  }
  return null
}

// A command's first word as its program is found: its base name (as
// filepath.Base reads it: /usr/bin/env is env), lowercased, without a
// Windows extension
function commandName(word: string): string {
  const base = word.replace(/\/+$/, '').split('/').pop() || '/'
  let name = base.toLowerCase()
  for (const ext of EXTENSIONS)
    if (name.endsWith(ext)) name = name.slice(0, -ext.length)
  return name
}

// A prefix of one word ("pnpm") covers every command of that program
export function grantPrefixTooWide(prefix: string): boolean {
  const p = prefix.trim()
  return p !== '' && !p.includes(' ')
}
