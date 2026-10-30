import { describe, expect, it } from 'vitest'
import { tFor } from '../i18n/i18n-context'
import { en } from '../i18n/messages/en'
import { vi as viMessages } from '../i18n/messages/vi'
import { errorKey, serverErrorText } from './server-error'

// Every code the server answers a refusal with: a codedError (by position or
// code:), an agentFailure, a fail(status, code, …), a jsonErrorCode(w, code,
// …) and a {"code": …} body written by hand.
const CODE_PATTERNS = [
  /codedError\{\s*"([a-z_]+)"/g,
  /\bcode:\s*"([a-z_]+)"/g,
  /"code":\s*"([a-z_]+)"/g,
  /\bfail\(http\.\w+,\s*"([a-z_]+)"/g,
  /jsonErrorCode\(w,\s*"([a-z_]+)"/g,
]

function serverCodes(): string[] {
  const sources = import.meta.glob<string>(
    ['../../../server/*.go', '!../../../server/*_test.go'],
    { query: '?raw', import: 'default', eager: true },
  )
  const codes = new Set<string>()
  for (const text of Object.values(sources)) {
    for (const re of CODE_PATTERNS) {
      for (const m of text.matchAll(re)) codes.add(m[1])
    }
  }
  return [...codes].sort()
}

describe('errors', () => {
  const codes = serverCodes()

  it('reads the codes from the server', () => {
    // A pattern that stopped matching would pass every check below
    expect(codes.length).toBeGreaterThan(100)
    expect(codes).toEqual(
      expect.arrayContaining(['view_only', 'no_client', 'input_not_ready']),
    )
  })

  it('has a sentence in English and Vietnamese for every code', () => {
    const missing = codes.filter(
      (code) =>
        !Object.hasOwn(en, `errors.${code}`) ||
        !Object.hasOwn(viMessages, `errors.${code}`),
    )
    expect(missing).toEqual([])
  })

  it('has no sentence for a code the server no longer sends', () => {
    const stale = Object.keys(en)
      .filter((k) => k.startsWith('errors.'))
      .map((k) => k.slice('errors.'.length))
      // unknown stands for every code this version does not know, whether
      // or not the server sends one by that name
      .filter((code) => code !== 'unknown' && !codes.includes(code))
    expect(stale).toEqual([])
  })
})

describe('errorKey', () => {
  it('finds the sentence of a known code', () => {
    expect(errorKey('view_only')).toBe('errors.view_only')
    expect(errorKey('unknown')).toBe('errors.unknown')
  })

  it('tells any other code as the generic failure', () => {
    expect(errorKey('agent_busy')).toBe('errors.unknown')
    // Not a way into another area's messages
    expect(errorKey('')).toBe('errors.unknown')
    expect(errorKey('../common.ok')).toBe('errors.unknown')
  })
})

describe('serverErrorText', () => {
  const t = tFor('en')

  it('words a refusal by its code, never with the server text', () => {
    expect(serverErrorText({ code: 'view_only', message: 'x' }, t)).toBe(
      'This device is view-only',
    )
    expect(serverErrorText({ code: 'agent_busy', message: 'busy!' }, t)).toBe(
      'The server could not finish this. Try again',
    )
  })

  it("keeps the server's words for a refusal with no code", () => {
    expect(
      serverErrorText({ code: '', message: 'mux command failed' }, t),
    ).toBe('mux command failed')
  })

  it('speaks Vietnamese', () => {
    expect(
      serverErrorText({ code: 'tab_gone', message: 'x' }, tFor('vi')),
    ).toBe('Tab đã đóng')
  })
})
