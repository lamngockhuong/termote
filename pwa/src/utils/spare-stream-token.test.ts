import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  refill,
  resetSpareForTest,
  SPARE_MAX_AGE_MS,
  takeToken,
} from './spare-stream-token'

const fetchTerminalToken = vi.fn()
vi.mock('../hooks/use-mux-api', () => ({
  fetchTerminalToken: () => fetchTerminalToken(),
}))

const fetchMock = vi.fn()
const reply = (status: number, body: unknown) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  )
const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
}

beforeEach(() => {
  resetSpareForTest()
  fetchTerminalToken.mockReset()
  fetchTerminalToken.mockResolvedValue('fresh')
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('takeToken', () => {
  it('fetches a token when there is no spare', async () => {
    expect(await takeToken()).toEqual({ token: 'fresh', spare: false })
    expect(fetchTerminalToken).toHaveBeenCalledTimes(1)
  })

  it('passes a fetch failure on', async () => {
    fetchTerminalToken.mockRejectedValueOnce(new Error('down'))
    await expect(takeToken()).rejects.toThrow('down')
  })

  it(`uses a spare younger than ${SPARE_MAX_AGE_MS} ms once, then fetches again`, async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    fetchMock.mockReturnValueOnce(reply(200, { token: 'kept' }))
    refill()
    await settle()
    vi.setSystemTime(Date.now() + SPARE_MAX_AGE_MS - 1)
    expect(await takeToken()).toEqual({ token: 'kept', spare: true })
    expect(fetchTerminalToken).not.toHaveBeenCalled()
    expect(await takeToken()).toEqual({ token: 'fresh', spare: false })
  })

  it('drops a spare that is too old', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    fetchMock.mockReturnValueOnce(reply(200, { token: 'kept' }))
    refill()
    await settle()
    vi.setSystemTime(Date.now() + SPARE_MAX_AGE_MS)
    expect(await takeToken()).toEqual({ token: 'fresh', spare: false })
    // Gone, not kept for later
    expect(await takeToken()).toEqual({ token: 'fresh', spare: false })
    expect(fetchTerminalToken).toHaveBeenCalledTimes(2)
  })

  it('drops the spare when asked for a fresh token', async () => {
    fetchMock.mockReturnValueOnce(reply(200, { token: 'kept' }))
    refill()
    await settle()
    expect(await takeToken(false)).toEqual({ token: 'fresh', spare: false })
    expect(await takeToken()).toEqual({ token: 'fresh', spare: false })
  })

  it('never gives one spare to two streams', async () => {
    fetchMock.mockReturnValueOnce(reply(200, { token: 'kept' }))
    refill()
    await settle()
    const [a, b] = await Promise.all([takeToken(), takeToken()])
    expect([a, b]).toEqual([
      { token: 'kept', spare: true },
      { token: 'fresh', spare: false },
    ])
  })
})

describe('refill', () => {
  it('sends one request at a time and none while a spare is kept', async () => {
    let answer: (r: Response) => void = () => {}
    fetchMock.mockReturnValueOnce(new Promise((r) => (answer = r)))
    refill()
    refill()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith('/api/mux/stream-token')
    answer(await reply(200, { token: 'kept' }))
    await settle()
    refill()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await takeToken()
    fetchMock.mockReturnValueOnce(reply(200, { token: 'next' }))
    refill()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['a refusal', () => reply(429, { error: 'rate_limited' })],
    ['a network error', () => Promise.reject(new TypeError('offline'))],
    ['a reply without a token', () => reply(200, {})],
    ['an empty token', () => reply(200, { token: '' })],
  ])(
    'keeps nothing after %s, and tries again on the next call',
    async (_n, answer) => {
      fetchMock.mockImplementationOnce(answer)
      refill()
      await settle()
      expect(await takeToken()).toEqual({ token: 'fresh', spare: false })
      fetchMock.mockReturnValueOnce(reply(200, { token: 'kept' }))
      refill()
      expect(fetchMock).toHaveBeenCalledTimes(2)
    },
  )
})
