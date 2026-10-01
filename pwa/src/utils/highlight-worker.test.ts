import { afterEach, describe, expect, it, vi } from 'vitest'
import { LANGUAGE_IDS } from './highlight-langs'
import { GRAMMARS, handleRequest, tokenize } from './highlight-worker'

describe('highlight worker', () => {
  afterEach(() => vi.restoreAllMocks())

  it('tokenizes a line with the theme of the colour scheme', async () => {
    const light = await tokenize('const a = 1\n', 'typescript', 'light')
    const dark = await tokenize('const a = 1\n', 'typescript', 'dark')
    expect(light[0][0]).toEqual(['const', expect.any(String), 0])
    expect(light[0].map((t) => t[0]).join('')).toBe('const a = 1')
    expect(light[0][0][1]).not.toBe(dark[0][0][1])
    // The trailing newline opens one more (empty) line
    expect(light).toHaveLength(2)
  })

  it.each(LANGUAGE_IDS)(
    'runs the %s grammar on the JavaScript engine',
    async (lang) => {
      const res = await handleRequest({
        id: 1,
        text: 'a = "b" # c\n',
        lang,
        theme: 'light',
      })
      expect(res.lines).not.toBeNull()
    },
  )

  // A grammar another one embeds is loaded with it, so each loader is also
  // called on its own.
  it.each(LANGUAGE_IDS)('loads the %s grammar', async (lang) => {
    expect((await GRAMMARS[lang]()).default.length).toBeGreaterThan(0)
  })

  it('has a grammar for every language', () => {
    expect(Object.keys(GRAMMARS).sort()).toEqual([...LANGUAGE_IDS].sort())
  })

  it('answers plain (null) when the grammar fails', async () => {
    const res = await handleRequest({
      id: 7,
      text: 'x',
      lang: 'nope' as never,
      theme: 'dark',
    })
    expect(res).toEqual({ id: 7, lines: null })
  })

  it('replies to each message with the request id', async () => {
    const post = vi.spyOn(self, 'postMessage').mockImplementation(() => {})
    await self.onmessage!(
      new MessageEvent('message', {
        data: { id: 3, text: 'x', lang: 'json', theme: 'light' },
      }),
    )
    // First that tokenizing started, then the tokens
    expect(post.mock.calls).toEqual([
      [{ id: 3, started: true }],
      [{ id: 3, lines: [[['x', expect.any(String), 0]]] }],
    ])
  })
})
