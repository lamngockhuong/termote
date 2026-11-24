import { describe, expect, it } from 'vitest'
import {
  grantPrefixProblem,
  grantPrefixTooWide,
  MAX_GRANT_PREFIX,
} from './grant-prefix'

describe('grantPrefixProblem', () => {
  it('takes plain words with one space between them', () => {
    for (const p of [
      'pnpm test',
      'go test ./...',
      './scripts/check.sh fast',
      ' cargo test ',
    ])
      expect(grantPrefixProblem(p), p).toBeNull()
  })

  it('wants something typed', () => {
    expect(grantPrefixProblem('')).toBe('empty')
    expect(grantPrefixProblem('   ')).toBe('empty')
  })

  it('refuses a prefix longer than the server takes', () => {
    expect(grantPrefixProblem('a'.repeat(MAX_GRANT_PREFIX))).toBeNull()
    expect(grantPrefixProblem('a'.repeat(MAX_GRANT_PREFIX + 1))).toBe('length')
  })

  it('refuses what a shell would read as more than words', () => {
    for (const p of [
      'pnpm test; rm -rf /',
      'echo $HOME',
      'ls *',
      'cat ~/x',
      'a && b',
      'a | b',
      'a > b',
      "echo 'x'",
      'echo "x"',
      'echo `x`',
      'echo \\x',
      'a!',
      'a #b',
      'a\tb',
      'a\nb',
      'pnpm  test',
      'café',
      'a​b',
    ])
      expect(grantPrefixProblem(p), p).toBe('chars')
  })

  it('refuses a program that runs any code, by its base name', () => {
    for (const p of [
      'bash',
      'sh -c',
      'npx vitest',
      'make test',
      'env FOO=1 ls',
      'Python3 x',
      '/usr/bin/env ls',
      'node_modules/.bin/../../bin/node x',
      '. ./x',
      '/bin/sh/ x',
      'git status',
      'python3.12 x',
      'node22 x',
      'uvx ruff',
      'ts-node x',
      'BASH.EXE',
      'sh.cmd.exe',
      'sed',
      'sed -n',
      '/usr/bin/SED.exe x',
      'ed',
    ])
      expect(grantPrefixProblem(p), p).toBe('interpreter')
    // An extension is dropped once, in the server's order
    expect(grantPrefixProblem('sh.exe.cmd')).toBeNull()
  })

  it('refuses a package manager running any package', () => {
    for (const p of [
      'pnpm dlx x',
      'pnpm EXEC x',
      'npm x y',
      'yarn dlx z',
      // after options too, at any position after the program's name
      'pnpm -s exec',
      'pnpm --filter termote exec',
      'pnpm --filter termote dlx',
      'npm --prefix a x',
      'yarn workspace a exec',
      'npm run build EXEC',
      // create and init run a create-* package from the registry
      'npm create vite',
      'npm init vite',
      'npm innit vite',
      'npm init',
      'npm --prefix pwa init',
      'pnpm create vite',
      'pnpm --filter termote create',
      'yarn create vite',
      'yarn workspace a create',
      'bun create vite',
      'npm CREATE',
      // an install that names a package fetches it and runs its scripts
      'npm install evil',
      'npm i evil',
      'npm isntall evil',
      'npm --prefix pwa install evil',
      'npm install --save-dev evil',
      'pnpm add evil',
      'pnpm --filter termote add -D evil',
      'pnpm install --filter termote',
      'yarn add evil',
      'yarn workspace a add evil',
      'bun a evil',
      'npm ADD evil',
    ])
      expect(grantPrefixProblem(p), p).toBe('interpreter')
    for (const p of [
      'pnpm test',
      'npm run build',
      'yarn',
      'gcc -c x.c',
      'pnpm --filter termote test',
      'yarn x',
      'npm dlx',
      'cargo exec',
      'pnpm init',
      'yarn init',
      'cargo init',
      'go mod init',
      'npm install',
      'npm i',
      'npm ci',
      'pnpm install --frozen-lockfile',
      'pnpm --filter termote install',
      'pnpm add',
      'yarn install',
      'cargo add serde',
    ])
      expect(grantPrefixProblem(p), p).toBeNull()
  })

  it('reads a name of slashes alone as itself', () => {
    expect(grantPrefixProblem('/ x')).toBeNull()
  })
})

describe('grantPrefixTooWide', () => {
  it('warns of a prefix of one word', () => {
    expect(grantPrefixTooWide('pnpm')).toBe(true)
    expect(grantPrefixTooWide(' pnpm ')).toBe(true)
    expect(grantPrefixTooWide('pnpm test')).toBe(false)
    expect(grantPrefixTooWide('')).toBe(false)
  })
})
