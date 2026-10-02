// The languages Files highlights, by file extension or whole file name. The
// worker holds a grammar loader for each id; this table has no imports, so
// the main bundle can pick a language without pulling Shiki in.

export const LANGUAGE_IDS = [
  'bat',
  'c',
  'cpp',
  'csharp',
  'css',
  'dart',
  'diff',
  'docker',
  'dotenv',
  'go',
  'graphql',
  'hcl',
  'html',
  'ini',
  'java',
  'javascript',
  'json',
  'jsonc',
  'jsx',
  'kotlin',
  'lua',
  'makefile',
  'markdown',
  'php',
  'powershell',
  'proto',
  'python',
  'ruby',
  'rust',
  'scss',
  'shellscript',
  'sql',
  'svelte',
  'swift',
  'toml',
  'tsx',
  'typescript',
  'vue',
  'xml',
  'yaml',
] as const

export type LanguageId = (typeof LANGUAGE_IDS)[number]

const BY_EXTENSION: Record<string, LanguageId> = {
  bat: 'bat',
  cmd: 'bat',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  css: 'css',
  dart: 'dart',
  diff: 'diff',
  patch: 'diff',
  env: 'dotenv',
  go: 'go',
  gql: 'graphql',
  graphql: 'graphql',
  hcl: 'hcl',
  tf: 'hcl',
  tfvars: 'hcl',
  htm: 'html',
  html: 'html',
  cfg: 'ini',
  conf: 'ini',
  ini: 'ini',
  java: 'java',
  cjs: 'javascript',
  js: 'javascript',
  mjs: 'javascript',
  json: 'json',
  jsonc: 'jsonc',
  json5: 'jsonc',
  jsx: 'jsx',
  kt: 'kotlin',
  kts: 'kotlin',
  lua: 'lua',
  mk: 'makefile',
  md: 'markdown',
  markdown: 'markdown',
  php: 'php',
  ps1: 'powershell',
  psm1: 'powershell',
  proto: 'proto',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  scss: 'scss',
  bash: 'shellscript',
  sh: 'shellscript',
  zsh: 'shellscript',
  sql: 'sql',
  svelte: 'svelte',
  swift: 'swift',
  toml: 'toml',
  tsx: 'tsx',
  cts: 'typescript',
  mts: 'typescript',
  ts: 'typescript',
  vue: 'vue',
  svg: 'xml',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
}

// A table's own entry: what a name like "constructor" inherits is not a
// language (every entry is a string)
function lookup(
  table: Record<string, LanguageId>,
  key: string,
): LanguageId | undefined {
  const lang: unknown = table[key]
  return typeof lang === 'string' ? (lang as LanguageId) : undefined
}

// Whole names (lower case) that say more than their extension
const BY_NAME: Record<string, LanguageId> = {
  '.bash_profile': 'shellscript',
  '.bashrc': 'shellscript',
  '.profile': 'shellscript',
  '.zshrc': 'shellscript',
  containerfile: 'docker',
  dockerfile: 'docker',
  gemfile: 'ruby',
  gnumakefile: 'makefile',
  makefile: 'makefile',
  'tsconfig.json': 'jsonc',
}

// The language of the file at path ("/"-separated), or undefined for plain text
export function languageFor(path: string): LanguageId | undefined {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  const byName = lookup(BY_NAME, name)
  if (byName) return byName
  if (name.startsWith('.env')) return 'dotenv'
  if (name.startsWith('dockerfile.')) return 'docker'
  const dot = name.lastIndexOf('.')
  return dot > 0 ? lookup(BY_EXTENSION, name.slice(dot + 1)) : undefined
}

// Names a fenced code block uses that are neither an id nor an extension
const BY_ALIAS: Record<string, LanguageId> = {
  'c#': 'csharp',
  'c++': 'cpp',
  dockerfile: 'docker',
  golang: 'go',
  make: 'makefile',
  protobuf: 'proto',
  pwsh: 'powershell',
  shell: 'shellscript',
  terraform: 'hcl',
  yml: 'yaml',
}

// The language a fenced code block names in its info string ("ts",
// "bash {linenos}", "Go"), or undefined for plain text
export function languageForName(info: string): LanguageId | undefined {
  const name = info.trim().split(/[\s{]/, 1)[0].toLowerCase()
  if ((LANGUAGE_IDS as readonly string[]).includes(name))
    return name as LanguageId
  return lookup(BY_ALIAS, name) ?? lookup(BY_EXTENSION, name)
}
