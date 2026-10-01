import { describe, expect, it } from 'vitest'
import { languageFor } from './highlight-langs'

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
  ])('%s is plain text', (path) => {
    expect(languageFor(path)).toBeUndefined()
  })
})
