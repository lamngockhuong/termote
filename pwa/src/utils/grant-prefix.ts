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
// refused at any position after the program's name (delegateRunners).
// create and init fetch and run a create-* package (npm init vite is npm
// exec create-vite; innit is npm's alias). config, c and set write the
// manager's own config past the grant, npm's pkg writes package.json
const RUNNERS: Record<string, string[]> = {
  npm: ['exec', 'x', 'create', 'init', 'innit', 'config', 'c', 'set', 'pkg'],
  pnpm: ['dlx', 'exec', 'x', 'create', 'config', 'c', 'set'],
  yarn: ['dlx', 'exec', 'create', 'config'],
  bun: ['x', 'create'],
}

// npm runs a command from any unique start of its name (npm exe x is npm
// exec x): a word of two letters or more that starts one of its runner
// words is refused too, but for these, its own commands' aliases
// (delegateAbbrevNames)
const ABBREV_NAMES = ['in', 'se']

// Package managers' words that install the packages named after them
// (delegateInstallers): refused when any word after one is no option (npm
// i x, pnpm add -D x); an install with no package installs what the
// lockfile holds
const INSTALLERS: Record<string, string[]> = {
  npm: [
    'install',
    'i',
    'in',
    'ins',
    'inst',
    'insta',
    'instal',
    'isnt',
    'isnta',
    'isntal',
    'isntall',
    'add',
  ],
  pnpm: ['install', 'i', 'add'],
  yarn: ['install', 'add'],
  bun: ['install', 'i', 'add', 'a'],
}

// Windows extensions a program's name drops, each once in this order
// (commandName)
const EXTENSIONS = ['.exe', '.cmd', '.bat', '.com', '.ps1']

// empty: nothing typed; length: longer than the server takes; chars: a
// character or a spacing it refuses; interpreter: a first word (or a
// package manager's runner word, at any position, or its install word
// followed by a package) that runs any code at all. The server also
// refuses, which a prefix alone cannot show: a command whose words after
// the prefix start with -; under a prefix of tar's name alone, tar's
// first argument (option letters even without a dash); and a pnpm or yarn
// command whose word picking the command comes after the prefix and is no
// command of theirs (they run it as a program).
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
    for (const w of words.slice(1)) {
      const lw = w.toLowerCase()
      if (runs.includes(lw)) return 'interpreter'
      if (
        first === 'npm' &&
        lw.length >= 2 &&
        !ABBREV_NAMES.includes(lw) &&
        runs.some((r) => r.startsWith(lw))
      )
        return 'interpreter'
    }
  }
  if (Object.hasOwn(INSTALLERS, first)) {
    const inst = INSTALLERS[first]
    for (let i = 1; i < words.length; i++)
      if (
        inst.includes(words[i].toLowerCase()) &&
        words.slice(i + 1).some((w) => !w.startsWith('-'))
      )
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
