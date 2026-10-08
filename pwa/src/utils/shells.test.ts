import { describe, expect, it } from 'vitest'
import sharedJson from '../../../server/testdata/known-shells.json?raw'
import { isShell, knownShells } from './shells'

describe('isShell', () => {
  it('lists the shells the server knows', () => {
    const shared: { shells: string[] } = JSON.parse(sharedJson)
    expect(knownShells().sort()).toEqual([...shared.shells].sort())
  })

  it('takes a shell name in any case, with or without .exe', () => {
    expect(isShell('bash')).toBe(true)
    expect(isShell('ZSH')).toBe(true)
    expect(isShell('pwsh.exe')).toBe(true)
    expect(isShell('cmd.EXE')).toBe(true)
  })

  it('refuses anything else', () => {
    expect(isShell('vim')).toBe(false)
    expect(isShell('claude')).toBe(false)
    expect(isShell('bash2')).toBe(false)
    expect(isShell('')).toBe(false)
    expect(isShell(undefined)).toBe(false)
  })
})
