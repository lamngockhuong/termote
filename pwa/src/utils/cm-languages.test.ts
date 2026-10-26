import { describe, expect, it, vi } from 'vitest'
import { LANGUAGE_IDS } from './highlight-langs'

describe('loadLanguage', () => {
  it('loads a language for each id, or none for plain text', async () => {
    const { loadLanguage } = await import('./cm-languages')
    const plain = ['bat', 'graphql', 'hcl', 'makefile']
    for (const id of LANGUAGE_IDS) {
      const lang = await loadLanguage(id)
      if (plain.includes(id)) expect(lang, id).toBeNull()
      else expect(lang, id).not.toBeNull()
    }
    expect(await loadLanguage(undefined)).toBeNull()
  })

  it('loads each language once', async () => {
    const { loadLanguage } = await import('./cm-languages')
    expect(loadLanguage('go')).toBe(loadLanguage('go'))
  })

  it('tries a language again after its chunk failed to load', async () => {
    vi.resetModules()
    let fail = true
    vi.doMock('@codemirror/lang-rust', async (orig) => {
      if (fail) throw new Error('offline')
      return orig()
    })
    const { loadLanguage } = await import('./cm-languages')
    expect(await loadLanguage('rust')).toBeNull()
    fail = false
    vi.resetModules()
    expect(await loadLanguage('rust')).not.toBeNull()
    vi.doUnmock('@codemirror/lang-rust')
  })
})
