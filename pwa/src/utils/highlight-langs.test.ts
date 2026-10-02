import { describe, expect, it } from 'vitest'
import { languageFor, languageForName } from './highlight-langs'

describe('languageFor', () => {
  it.each([
    ['src/app.tsx', 'tsx'],
    ['a/b/main.GO', 'go'],
    ['Makefile', 'makefile'],
    ['docker/Dockerfile', 'docker'],
    ['Dockerfile.dev', 'docker'],
    ['.env.local', 'dotenv'],
    ['.env', 'dotenv'],
    ['tsconfig.json', 'jsonc'],
    ['package.json', 'json'],
    ['~/.zshrc', 'shellscript'],
  ])('%s is %s', (path, lang) => {
    expect(languageFor(path)).toBe(lang)
  })

  it.each([
    'notes.txt',
    'LICENSE',
    // A leading dot alone is a name, not an extension
    '.gitignore',
    'dir.d/',
    // Not an entry of the tables, whatever an object inherits
    'a.constructor',
    'toString',
  ])('%s is plain text', (path) => {
    expect(languageFor(path)).toBeUndefined()
  })
})

describe('languageForName', () => {
  it.each([
    ['ts', 'typescript'],
    ['typescript', 'typescript'],
    ['Go', 'go'],
    ['golang', 'go'],
    ['bash', 'shellscript'],
    ['sh', 'shellscript'],
    ['shell', 'shellscript'],
    ['yml', 'yaml'],
    ['c++', 'cpp'],
    ['c#', 'csharp'],
    ['dockerfile', 'docker'],
    ['py {linenos}', 'python'],
    ['  rust  ', 'rust'],
    ['js{1,3}', 'javascript'],
  ])('%s → %s', (info, lang) => {
    expect(languageForName(info)).toBe(lang)
  })

  it.each(['', 'mermaid', 'text', 'console', 'constructor'])(
    'leaves %s plain',
    (info) => {
      expect(languageForName(info)).toBeUndefined()
    },
  )
})
