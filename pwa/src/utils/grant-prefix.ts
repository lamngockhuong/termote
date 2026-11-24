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
  // GNU's and the other builds of awk and make
  'gawk',
  'mawk',
  'nawk',
  'gmake',
  'git',
  // sed and ed run a program from their script (sed's e command, ed's !)
  'sed',
  'ed',
  // more interpreters, and wrappers that run the program named after them
  'gsed',
  'pythonw',
  'py',
  'pypy',
  'pypy3',
  'java',
  'jshell',
  'rscript',
  'julia',
  'tclsh',
  'wish',
  'expect',
  'osascript',
  'stdbuf',
  'setsid',
  'flock',
  'strace',
  'ltrace',
  'gdb',
  'lldb',
  'valgrind',
  'chroot',
  'unshare',
  'nsenter',
  'runuser',
  'pkexec',
  'ionice',
  'taskset',
  'chrt',
  'xvfb-run',
  'systemd-run',
  'caffeinate',
  // container engines: docker run <image> runs any image of a registry,
  // docker compose up a compose file the agent can edit (it may mount the
  // whole machine)
  'docker',
  'podman',
  'nerdctl',
  'docker-compose',
  'podman-compose',
  // wrappers that run the program named after them (corepack a package
  // manager past these rules, bundle install the Gemfile, Ruby), and task
  // runners that run a file the agent can edit, as make does
  'corepack',
  'bundle',
  'poetry',
  'pipenv',
  'conda',
  'mise',
  'rake',
  'just',
  'task',
])

// A versioned name of an interpreter: python3.12 (interpreterVersionRe)
const VERSIONED = /^(python|pypy|perl|ruby|php|lua|node|deno|bun)[0-9.]*$/

// pip under any of its versioned names: pip3, pip3.12 (pipNameRe)
const PIP_NAME = /^pip[0-9.]*$/

// Package managers with a word that runs any package: pnpm dlx x, npm exec
// x, also after options (pnpm -s exec x, pnpm --filter a exec x), so it is
// refused at any position after the program's name (delegateRunners).
// create and init fetch and run a create-* package (npm init vite is npm
// exec create-vite; innit is npm's alias). config, c and set write the
// manager's own config past the grant, npm's pkg writes package.json, and
// the last ones act on the registry with the user's login (publish...)
const RUNNERS: Record<string, string[]> = {
  npm: [
    ...['exec', 'x', 'create', 'init', 'innit', 'config', 'c', 'set', 'pkg'],
    ...['publish', 'unpublish', 'deprecate', 'dist-tag', 'dist-tags', 'owner'],
    ...['author', 'access', 'token', 'adduser', 'add-user', 'login', 'logout'],
    ...['signin', 'signout', 'team', 'org', 'star', 'unstar'],
  ],
  pnpm: [
    ...['dlx', 'exec', 'x', 'create', 'config', 'c', 'set', 'pkg', 'publish'],
    ...['unpublish', 'deprecate', 'dist-tag', 'owner', 'access', 'token'],
    ...['adduser', 'login', 'logout', 'team', 'star', 'unstar'],
  ],
  yarn: [
    ...['dlx', 'exec', 'create', 'config', 'publish', 'login', 'logout'],
    ...['owner', 'team', 'tag', 'npm'],
  ],
  bun: ['x', 'create'],
}

// npm runs a command from any unique start of its name (npm exe x is npm
// exec x): a word of two letters or more that starts one of its runner
// words is refused too, but for these, its own commands' aliases
// (delegateAbbrevNames)
const ABBREV_NAMES = ['in', 'add', 'un', 'se']

// Package managers' words that install the packages named after them
// (delegateInstallers): refused when any word after one is no option (npm
// i x, pnpm add -D x); an install with no package installs what the
// lockfile holds. npm's install-test (it) takes install's arguments, then
// runs the tests, and its link installs a package it names; pip and gem
// build and install a package, running its setup code
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
    'install-test',
    'install-tes',
    'install-te',
    'install-t',
    'it',
    'link',
    'ln',
  ],
  pip: ['install'],
  gem: ['install', 'i'],
  pnpm: ['install', 'i', 'add'],
  yarn: ['install', 'add'],
  bun: ['install', 'i', 'add', 'a'],
}

// Programs whose command, the word after the name (past one +toolchain),
// must be one of these (delegateSubcommands): cargo runs any other word as
// the program cargo-<x> on PATH, and its install builds a crate the agent
// names; cargo's aliases (b, t, c) a cargo config may redefine. go's run
// and install build and run a module the agent names (go run x@latest),
// generate the commands its source names, tool any tool, env -w GOFLAGS
const SUBCOMMANDS: Record<string, string[]> = {
  cargo: ['build', 'test', 'check', 'clippy', 'fmt'],
  go: ['build', 'test', 'vet', 'fmt', 'list', 'mod', 'version'],
}

// Windows extensions a program's name drops, each once in this order
// (commandName)
const EXTENSIONS = ['.exe', '.cmd', '.bat', '.com', '.ps1']

// empty: nothing typed; length: longer than the server takes; chars: a
// character or a spacing it refuses; interpreter: a first word (or a
// package manager's runner word, at any position, or its install word
// followed by a package, or a cargo or go command other than the ones they
// build, test or read with) that runs any code at all. The server also
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
  // A variable set before the program (X=1 bash) is what env does
  if (words[0].includes('=')) return 'interpreter'
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
  const installer = PIP_NAME.test(first) ? 'pip' : first
  if (Object.hasOwn(INSTALLERS, installer)) {
    const inst = INSTALLERS[installer]
    for (let i = 1; i < words.length; i++)
      if (
        inst.includes(words[i].toLowerCase()) &&
        words.slice(i + 1).some((w) => !w.startsWith('-'))
      )
        return 'interpreter'
  }
  if (Object.hasOwn(SUBCOMMANDS, first)) {
    let k = 1
    if (k < words.length && words[k].startsWith('+')) k++
    if (k < words.length && !SUBCOMMANDS[first].includes(words[k]))
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
