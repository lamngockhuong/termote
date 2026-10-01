import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ViewProps } from '../app-views'
import { AgentRequestError } from '../hooks/use-mux-api'
import { byteLength, ChatComposer, MAX_MESSAGE_BYTES } from './chat-composer'

const transcript = { cursor: 'cur1' as string | undefined, refresh: vi.fn() }
vi.mock('../hooks/use-agent-transcript', () => ({
  useAgentTranscript: () => ({
    entries: [],
    loaded: true,
    loadingOlder: false,
    cursor: transcript.cursor,
    refresh: transcript.refresh,
    loadOlder: vi.fn(),
  }),
}))

const mockSend = vi.fn()
vi.mock('../hooks/use-mux-api', async (orig) => ({
  ...(await orig<typeof import('../hooks/use-mux-api')>()),
  sendAgentMessage: (...a: unknown[]) => mockSend(...a),
}))

const showView = vi.fn()
const props = (over: Partial<ViewProps> = {}): ViewProps => ({
  mux: {
    backend: 'tmux',
    caps: { clientSideSelect: false, copyMode: true, agentChat: true },
  },
  session: {
    id: '0',
    name: 'claude',
    icon: '',
    description: '',
    paneId: '%3',
    hasAgent: true,
    agentName: 'claude',
  },
  readOnly: false,
  isMobile: false,
  setSidePanel: vi.fn(),
  showView,
  ...over,
})

const box = () =>
  screen.getByRole('textbox', { name: 'Message to Claude Code' })
const sendButton = () => screen.getByRole('button', { name: 'Send' })
const type = (v: string) => fireEvent.change(box(), { target: { value: v } })
const send = async () => {
  await act(async () => {
    fireEvent.click(sendButton())
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  sessionStorage.clear()
  transcript.cursor = 'cur1'
  mockSend.mockResolvedValue(undefined)
})

describe('ChatComposer', () => {
  it('sends the text with the cursor, clears the draft and refreshes', async () => {
    render(<ChatComposer {...props()} />)
    expect(sendButton()).toBeDisabled()
    type('line 1\nline 2')
    expect(sessionStorage.getItem('termote-chat-draft:%3')).toBe(
      'line 1\nline 2',
    )
    expect(box()).toHaveAttribute('rows', '2')
    await send()
    expect(mockSend).toHaveBeenCalledWith('%3', 'line 1\nline 2', 'cur1')
    expect(box()).toHaveValue('')
    expect(sessionStorage.getItem('termote-chat-draft:%3')).toBeNull()
    expect(transcript.refresh).toHaveBeenCalled()
  })

  it('grows to six rows at most', () => {
    render(<ChatComposer {...props()} />)
    type('1\n2\n3\n4\n5\n6\n7\n8')
    expect(box()).toHaveAttribute('rows', '6')
  })

  it('keeps a draft per pane across remounts', () => {
    sessionStorage.setItem('termote-chat-draft:%3', 'saved')
    const { rerender } = render(<ChatComposer {...props()} />)
    expect(box()).toHaveValue('saved')
    rerender(
      <ChatComposer
        {...props({ session: { ...props().session, paneId: '%4' } })}
      />,
    )
    expect(box()).toHaveValue('')
  })

  it('works without storage', () => {
    const get = vi
      .spyOn(Storage.prototype, 'getItem')
      .mockImplementation(() => {
        throw new Error('denied')
      })
    const setItem = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new Error('denied')
      })
    render(<ChatComposer {...props()} />)
    type('hi')
    expect(box()).toHaveValue('hi')
    get.mockRestore()
    setItem.mockRestore()
  })

  it('Ctrl/Cmd+Enter sends on desktop; Enter alone does not', async () => {
    render(<ChatComposer {...props()} />)
    type('hi')
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(mockSend).not.toHaveBeenCalled()
    await act(async () => {
      fireEvent.keyDown(box(), { key: 'Enter', metaKey: true })
    })
    expect(mockSend).toHaveBeenCalledTimes(1)
    type('again')
    await act(async () => {
      fireEvent.keyDown(box(), { key: 'Enter', ctrlKey: true })
    })
    expect(mockSend).toHaveBeenCalledTimes(2)
  })

  it('on a phone Enter is a new line, even with Ctrl', () => {
    render(<ChatComposer {...props({ isMobile: true })} />)
    type('hi')
    fireEvent.keyDown(box(), { key: 'Enter', ctrlKey: true })
    expect(mockSend).not.toHaveBeenCalled()
    expect(box()).toHaveAttribute('placeholder', 'Message')
  })

  it('counts bytes, not characters, and blocks past 16 KB', () => {
    expect(byteLength('tiếng')).toBe(7)
    render(<ChatComposer {...props()} />)
    type('ệ'.repeat(Math.floor(MAX_MESSAGE_BYTES / 3) + 1))
    expect(sendButton()).toBeDisabled()
    expect(
      screen.getByText(/of 16 KB: shorten the message/),
    ).toBeInTheDocument()
  })

  it('cannot send blank text or before the conversation is read', () => {
    render(<ChatComposer {...props()} />)
    type('   ')
    expect(sendButton()).toBeDisabled()
    transcript.cursor = undefined
    type('hi')
    expect(sendButton()).toBeDisabled()
  })

  it('a leading space does not hide a shell command', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<ChatComposer {...props()} />)
    type('  !ls')
    await send()
    expect(confirm).toHaveBeenCalled()
    expect(mockSend).not.toHaveBeenCalled()
    confirm.mockRestore()
  })

  it('a refusal is announced through a live region; the limit is described', async () => {
    mockSend.mockRejectedValue(
      new AgentRequestError(409, 'input_not_ready', 'a dialog is open'),
    )
    const { container } = render(<ChatComposer {...props()} />)
    const live = container.querySelector('[aria-live="polite"]')!
    expect(live).toHaveTextContent('')
    type('hello')
    await send()
    expect(live).toHaveTextContent('Not sent: a dialog is open.')
    type('ệ'.repeat(Math.floor(MAX_MESSAGE_BYTES / 3) + 1))
    const id = box().getAttribute('aria-describedby')!
    expect(document.getElementById(id)).toHaveTextContent(/shorten the message/)
  })

  it('asks before sending a shell command', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<ChatComposer {...props()} />)
    type('!rm -rf build')
    await send()
    expect(confirm).toHaveBeenCalledWith(
      'Run this as a shell command in Claude Code?',
    )
    expect(mockSend).not.toHaveBeenCalled()
    confirm.mockReturnValue(true)
    await send()
    expect(mockSend).toHaveBeenCalledWith('%3', '!rm -rf build', 'cur1')
    confirm.mockRestore()
  })

  it.each([
    [
      'input_not_ready',
      409,
      'a dialog is open',
      'Not sent: a dialog is open.',
      true,
    ],
    [
      'paste_not_confirmed',
      409,
      'x',
      'Not sent: the text did not show in the input box. It may be there now; check in the terminal.',
      true,
    ],
    [
      'delivered_not_submitted',
      502,
      'x',
      'The text was pasted but not submitted. Check the terminal before sending again.',
      true,
    ],
    ['text_too_long', 413, 'x', 'Too long: the limit is 16 KB.', false],
    [
      'target_changed',
      409,
      'the agent is no longer in this pane',
      'Not sent: the agent is no longer in this pane.',
      true,
    ],
    ['', 500, 'mux command failed', 'Not sent: mux command failed.', false],
  ])(
    'a %s refusal keeps the draft and says why',
    async (code, status, msg, shown, terminal) => {
      mockSend.mockRejectedValue(
        new AgentRequestError(
          status,
          code,
          msg,
          code === 'text_too_long' ? 16384 : undefined,
        ),
      )
      render(<ChatComposer {...props()} />)
      type('hello')
      await send()
      expect(screen.getByRole('status')).toHaveTextContent(shown)
      expect(box()).toHaveValue('hello')
      expect(sessionStorage.getItem('termote-chat-draft:%3')).toBe('hello')
      // Never sent again on its own
      expect(mockSend).toHaveBeenCalledTimes(1)
      const open = screen.queryByRole('button', { name: 'Open terminal' })
      expect(!!open).toBe(terminal)
      if (open) {
        fireEvent.click(open)
        expect(showView).toHaveBeenCalledWith('terminal')
      }
    },
  )

  it('a too-long refusal without a limit uses the default', async () => {
    mockSend.mockRejectedValue(new AgentRequestError(413, 'text_too_long', 'x'))
    render(<ChatComposer {...props()} />)
    type('hello')
    await send()
    expect(screen.getByRole('status')).toHaveTextContent(
      'Too long: the limit is 16 KB.',
    )
  })

  it('a changed session reloads the conversation', async () => {
    mockSend.mockRejectedValue(
      new AgentRequestError(409, 'session_changed', 'x'),
    )
    render(<ChatComposer {...props()} />)
    type('hello')
    await send()
    expect(transcript.refresh).toHaveBeenCalled()
    expect(screen.getByRole('status')).toHaveTextContent(
      'The conversation changed',
    )
  })

  it('a network failure says the message was not sent', async () => {
    mockSend.mockRejectedValue(new TypeError('Failed to fetch'))
    render(<ChatComposer {...props()} />)
    type('hello')
    await send()
    expect(screen.getByRole('status')).toHaveTextContent(
      'Could not reach the server; the message was not sent.',
    )
  })

  it('locks while sending', async () => {
    let resolve!: () => void
    mockSend.mockImplementation(
      () =>
        new Promise<void>((r) => {
          resolve = r
        }),
    )
    render(<ChatComposer {...props()} />)
    type('hello')
    await send()
    // Read-only, not disabled: the box keeps focus and the keyboard
    expect(box()).toHaveAttribute('readonly')
    expect(box()).toHaveAttribute('aria-busy', 'true')
    expect(sendButton()).toBeDisabled()
    // A second send while one is in flight does nothing
    await act(async () => {
      fireEvent.keyDown(box(), { key: 'Enter', ctrlKey: true })
    })
    expect(mockSend).toHaveBeenCalledTimes(1)
    await act(async () => resolve())
    expect(box()).not.toHaveAttribute('readonly')
  })

  it('a pane-less session has an empty pane id', async () => {
    render(
      <ChatComposer
        {...props({ session: { ...props().session, paneId: undefined } })}
      />,
    )
    type('x')
    await send()
    expect(mockSend).toHaveBeenCalledWith('', 'x', 'cur1')
  })

  it('502 delivered_not_submitted never retries, even after time passes', async () => {
    vi.useFakeTimers()
    mockSend.mockRejectedValueOnce(
      new AgentRequestError(502, 'delivered_not_submitted', 'x'),
    )
    render(<ChatComposer {...props()} />)
    type('hello')
    await send()
    expect(screen.getByRole('status')).toHaveTextContent(
      'The text was pasted but not submitted',
    )
    // Advance time and ensure no automatic retry is attempted
    await act(async () => {
      vi.advanceTimersByTime(10000)
    })
    expect(mockSend).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })
})
