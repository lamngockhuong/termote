import { describe, expect, it } from 'vitest'
import { en } from './messages/en'
import { vi } from './messages/vi'

const placeholders = (text: string) =>
  [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
const tags = (text: string) =>
  [...text.matchAll(/<(\w+)>/g)].map((m) => m[1]).sort()

describe('messages', () => {
  const viMessages: Record<string, string> = vi

  it('every Vietnamese message has the English placeholders and tags', () => {
    for (const [key, text] of Object.entries(viMessages)) {
      const source =
        (en as Record<string, string>)[key] ??
        (en as Record<string, string>)[key.replace(/_other$/, '_one')]
      expect(placeholders(text), key).toEqual(placeholders(source))
      expect(tags(text), key).toEqual(tags(source))
    }
  })

  it('every English key is translated (but _one forms)', () => {
    const missing = Object.keys(en).filter(
      (k) => !k.endsWith('_one') && !(k in viMessages),
    )
    expect(missing).toEqual([])
  })

  it('every key is named after its area', () => {
    for (const key of Object.keys(en)) expect(key).toMatch(/^[a-z]+\.\w+/)
  })
})
