import { describe, expect, it } from 'vitest'
import type { SlashCommand } from './slash-commands'
import { userMessageTokens } from './user-message-tokens'

const skill: SlashCommand = {
  name: 'ak-cook',
  source: 'user',
  kind: 'skill',
  trigger: '/',
}
const model: SlashCommand = { name: 'model', source: 'builtin' }
const codex: SlashCommand = {
  name: 'review-pr',
  source: 'user',
  kind: 'skill',
  trigger: '$',
}
const plugin: SlashCommand = {
  name: 'atk:fix',
  source: 'plugin',
  kind: 'skill',
  trigger: '/',
}
const ALL = [skill, model, codex, plugin]

const kinds = (text: string, commands = ALL) =>
  userMessageTokens(text, commands).map((t) => [t.kind, t.text])

describe('userMessageTokens', () => {
  it('keeps plain text whole, line breaks included', () => {
    expect(kinds('a\nb  c')).toEqual([['text', 'a\nb  c']])
    expect(kinds('')).toEqual([])
  })

  it('finds http(s) links and leaves the rest as text', () => {
    expect(kinds('see http://127.0.0.1:7317/?ws=a&pane=b%3Ap4 now')).toEqual([
      ['text', 'see '],
      ['link', 'http://127.0.0.1:7317/?ws=a&pane=b%3Ap4'],
      ['text', ' now'],
    ])
    // Not a URL at all
    expect(kinds('http://[x')).toEqual([['text', 'http://[x']])
    expect(kinds('ftp://x.y javascript:alert(1)')).toEqual([
      ['text', 'ftp://x.y javascript:alert(1)'],
    ])
  })

  it('leaves sentence punctuation and unopened brackets out of a link', () => {
    expect(kinds('(https://a.b/c).')).toEqual([
      ['text', '('],
      ['link', 'https://a.b/c'],
      ['text', ').'],
    ])
    expect(kinds('https://en.wikipedia.org/wiki/A_(b), ok')).toEqual([
      ['link', 'https://en.wikipedia.org/wiki/A_(b)'],
      ['text', ', ok'],
    ])
    expect(kinds('[x](https://a.b/c]')).toEqual([
      ['text', '[x]('],
      ['link', 'https://a.b/c'],
      ['text', ']'],
    ])
  })

  it('shows a known command or skill after its trigger, anywhere on a line', () => {
    expect(kinds('/model opus')).toEqual([
      ['command', '/model'],
      ['text', ' opus'],
    ])
    expect(kinds('do it\n/ak-cook\nthen $review-pr and /atk:fix')).toEqual([
      ['text', 'do it\n'],
      ['command', '/ak-cook'],
      ['text', '\nthen '],
      ['command', '$review-pr'],
      ['text', ' and '],
      ['command', '/atk:fix'],
    ])
    const [cmd] = userMessageTokens('/ak-cook', ALL)
    expect(cmd).toMatchObject({ kind: 'command', command: skill })
  })

  it('never takes a path, a word part, an unknown name or another trigger', () => {
    expect(
      kinds('/home/me and/or /tmp /ak-cook/x x/ak-cook /ak-cooked'),
    ).toEqual([
      ['text', '/home/me and/or /tmp /ak-cook/x x/ak-cook /ak-cooked'],
    ])
    // Codex's skill is typed after "$", not "/"
    expect(kinds('/review-pr $ak-cook')).toEqual([
      ['text', '/review-pr $ak-cook'],
    ])
    expect(kinds('/ak-cook', [])).toEqual([['text', '/ak-cook']])
  })

  it('leaves a command name inside a link to the link', () => {
    expect(kinds('https://h.io/ /ak-cook')).toEqual([
      ['link', 'https://h.io/'],
      ['text', ' '],
      ['command', '/ak-cook'],
    ])
    expect(kinds('https://h.io/x?a= /model')).toEqual([
      ['link', 'https://h.io/x?a='],
      ['text', ' '],
      ['command', '/model'],
    ])
  })
})
