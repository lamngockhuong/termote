import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RequestError } from '../hooks/use-mux-api'
import { sendToAgent } from './send-to-agent'

const mockTranscript = vi.fn()
const mockSend = vi.fn()

vi.mock('../hooks/use-mux-api', async (orig) => ({
  ...(await orig<typeof import('../hooks/use-mux-api')>()),
  fetchTranscript: (...a: unknown[]) => mockTranscript(...a),
  sendAgentMessage: (...a: unknown[]) => mockSend(...a),
}))

beforeEach(() => {
  mockTranscript.mockReset()
  mockSend.mockReset()
})

describe('sendToAgent', () => {
  it("sends after the transcript's cursor", async () => {
    mockTranscript.mockResolvedValue({ cursor: 'c1' })
    mockSend.mockResolvedValue({ queued: true })
    await expect(sendToAgent('%1', 'hi')).resolves.toEqual({ queued: true })
    expect(mockSend).toHaveBeenCalledWith('%1', 'hi', 'c1')
  })

  it('tries once more with a fresh cursor after session_changed', async () => {
    mockTranscript
      .mockResolvedValueOnce({ cursor: 'c1' })
      .mockResolvedValueOnce({ cursor: 'c2' })
    mockSend
      .mockRejectedValueOnce(new RequestError(409, 'session_changed', 'moved'))
      .mockResolvedValueOnce({ queued: false })
    await expect(sendToAgent('%1', 'hi')).resolves.toEqual({ queued: false })
    expect(mockSend).toHaveBeenLastCalledWith('%1', 'hi', 'c2')
  })

  it('throws any other refusal', async () => {
    mockTranscript.mockResolvedValue({ cursor: 'c1' })
    mockSend.mockRejectedValue(new RequestError(409, 'not_idle', 'busy'))
    await expect(sendToAgent('%1', 'hi')).rejects.toMatchObject({
      code: 'not_idle',
    })
    expect(mockSend).toHaveBeenCalledOnce()
  })
})
