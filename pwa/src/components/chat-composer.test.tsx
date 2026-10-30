import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ViewProps } from '../app-views'
import { resetChatAttachments } from '../hooks/use-chat-attachments'
import {
  type AgentCommand,
  type AgentPrompt,
  AgentRequestError,
} from '../hooks/use-mux-api'
import { requestDraftInsert } from '../utils/chat-draft'
import {
  onTemplateFill,
  type TemplateFill,
  takeTemplateFill,
} from '../utils/template-fill-request'
import { byteLength, ChatComposer, MAX_MESSAGE_BYTES } from './chat-composer'

const transcript = {
  cursor: 'cur1' as string | undefined,
  status: 'idle' as string | undefined,
  refresh: vi.fn(),
}
const mockAnswerPrompt = vi.fn(() => Promise.resolve())
const promptStore = {
  loaded: true,
  prompt: null as AgentPrompt | null,
  refresh: vi.fn(),
  show: vi.fn(),
  status: undefined as unknown,
}
vi.mock('../hooks/use-agent-prompt', () => ({
  useAgentPrompt: (_pane: string, status: unknown) => {
    promptStore.status = status
    return {
      prompt: promptStore.prompt,
      loaded: promptStore.loaded,
      refresh: promptStore.refresh,
      show: promptStore.show,
    }
  },
}))
vi.mock('../hooks/use-agent-transcript', () => ({
  useAgentTranscript: () => ({
    entries: [],
    loaded: true,
    loadingOlder: false,
    cursor: transcript.cursor,
    status: transcript.status,
    refresh: transcript.refresh,
    loadOlder: vi.fn(),
  }),
}))

const commandsStore = {
  enabled: false,
  list: [] as AgentCommand[],
}
vi.mock('../hooks/use-agent-commands', () => ({
  useAgentCommands: (_pane: string, enabled: boolean) => {
    commandsStore.enabled = enabled
    return commandsStore.list
  },
}))

const promptTemplates = vi.hoisted(() => ({
  templates: [] as {
    id: string
    name: string
    text: string
    updated: string
  }[],
  refresh: vi.fn(async () => {}),
}))
vi.mock('../hooks/use-prompt-templates', () => ({
  usePromptTemplates: () => ({
    templates: promptTemplates.templates,
    readOnly: false,
    loaded: true,
    loading: false,
    error: false,
    refresh: promptTemplates.refresh,
  }),
}))
const mockSend = vi.fn()
vi.mock('../hooks/use-mux-api', async (orig) => ({
  ...(await orig<typeof import('../hooks/use-mux-api')>()),
  sendAgentMessage: (...a: unknown[]) => mockSend(...a),
  answerAgentPrompt: (...a: unknown[]) => mockAnswerPrompt(...(a as [])),
}))

const mockUpload = vi.fn()
const mockPick = vi.fn()
vi.mock('../utils/upload-image', async (orig) => ({
  ...(await orig<typeof import('../utils/upload-image')>()),
  uploadImage: (...a: unknown[]) => mockUpload(...a),
  pickImageFile: () => mockPick(),
}))
const mockThumb = vi.fn()
vi.mock('../utils/image-thumbnail', () => ({
  imageThumbnail: (...a: unknown[]) => mockThumb(...a),
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
  notify: vi.fn(),
  showView,
  ...over,
})

// The composer of whichever agent the test renders
const box = () => screen.getByRole('textbox', { name: /^Message to / })
const sendButton = () => screen.getByRole('button', { name: 'Send' })
const type = (v: string) => fireEvent.change(box(), { target: { value: v } })
const send = async () => {
  await act(async () => {
    fireEvent.click(sendButton())
  })
}

beforeEach(() => {
  resetChatAttachments()
  vi.clearAllMocks()
  sessionStorage.clear()
  transcript.cursor = 'cur1'
  transcript.status = 'idle'
  promptStore.prompt = null
  promptStore.loaded = true
  mockAnswerPrompt.mockResolvedValue(undefined)
  mockSend.mockResolvedValue({ queued: false })
  commandsStore.enabled = false
  commandsStore.list = []
  mockThumb.mockResolvedValue(null)
  mockPick.mockResolvedValue(null)
  let n = 0
  mockUpload.mockImplementation(async () => {
    n++
    return {
      ok: true,
      upload: { id: `id${n}`, path: `/c/id${n}.png`, insert: `/c/id${n}.png` },
    }
  })
})

const uploadsProps = (over: Partial<ViewProps> = {}) =>
  props({
    mux: {
      backend: 'tmux',
      caps: {
        clientSideSelect: false,
        copyMode: true,
        agentChat: true,
        uploads: true,
      },
    },
    ...over,
  })
const png = (name = 'a.png') => new File(['x'], name, { type: 'image/png' })
const attachButton = () => screen.getByRole('button', { name: 'Attach image' })
const attach = async (file = png()) => {
  mockPick.mockResolvedValueOnce(file)
  await act(async () => {
    fireEvent.click(attachButton())
  })
}
const pasteImage = async (types = ['Files']) => {
  const file = png()
  await act(async () => {
    fireEvent.paste(box(), {
      clipboardData: {
        types,
        items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }],
      },
    })
  })
}

describe('ChatComposer images', () => {
  it('no attach button without uploads on the server, or view only', () => {
    const { unmount } = render(<ChatComposer {...props()} />)
    expect(screen.queryByRole('button', { name: 'Attach image' })).toBeNull()
    unmount()
    render(<ChatComposer {...uploadsProps({ readOnly: true })} />)
    expect(screen.queryByRole('button', { name: 'Attach image' })).toBeNull()
  })

  it('attaches, shows a thumbnail and sends the ids with the text', async () => {
    mockThumb.mockResolvedValue('data:image/png;base64,AA==')
    render(<ChatComposer {...uploadsProps()} />)
    type('what are these?')
    await attach()
    await attach()
    expect(mockUpload).toHaveBeenCalledTimes(2)
    expect(
      screen.getByRole('img', { name: 'Attachment 1, ready' }),
    ).toHaveAttribute('src', 'data:image/png;base64,AA==')
    // Never focused: each token goes at the end
    expect(box()).toHaveValue('what are these? [Image #1] [Image #2]')
    await send()
    expect(mockSend).toHaveBeenCalledWith(
      '%3',
      'what are these?  ',
      'cur1',
      ['id1', 'id2'],
      [16, 17],
    )
    expect(screen.queryByRole('list', { name: 'Attached images' })).toBeNull()
  })

  it('sends images without text', async () => {
    render(<ChatComposer {...uploadsProps()} />)
    expect(sendButton()).toBeDisabled()
    await attach()
    expect(sendButton()).toBeEnabled()
    await send()
    expect(mockSend).toHaveBeenCalledWith('%3', '', 'cur1', ['id1'], [0])
  })

  it('a cancelled picker attaches nothing', async () => {
    render(<ChatComposer {...uploadsProps()} />)
    await act(async () => {
      fireEvent.click(attachButton())
    })
    expect(mockUpload).not.toHaveBeenCalled()
  })

  it('send waits while an image uploads', async () => {
    let finish: (v: unknown) => void = () => {}
    mockUpload.mockImplementationOnce(
      () =>
        new Promise((r) => {
          finish = r
        }),
    )
    render(<ChatComposer {...uploadsProps()} />)
    type('hi')
    await attach()
    expect(
      screen.getByRole('img', { name: 'Attachment 1, uploading' }),
    ).toBeTruthy()
    expect(sendButton()).toBeDisabled()
    await act(async () => {
      finish({ ok: true, upload: { id: 'late', path: '/p', insert: '/p' } })
    })
    expect(sendButton()).toBeEnabled()
  })

  it('a failed upload is announced, marked and blocks send until removed', async () => {
    mockUpload.mockResolvedValueOnce({ ok: false, reason: 'too_large' })
    render(<ChatComposer {...uploadsProps()} />)
    type('hi')
    await attach()
    expect(screen.getAllByText('Image is larger than 10 MB.').length).toBe(2)
    expect(
      screen.getByRole('img', {
        name: 'Attachment 1, Image is larger than 10 MB',
      }),
    ).toBeTruthy()
    expect(sendButton()).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Remove image 1' }))
    expect(sendButton()).toBeEnabled()
  })

  it('at most five images', async () => {
    render(<ChatComposer {...uploadsProps()} />)
    for (let i = 0; i < 5; i++) await attach()
    expect(attachButton()).toBeDisabled()
    await pasteImage()
    expect(mockUpload).toHaveBeenCalledTimes(5)
    expect(
      screen.getAllByText('At most 5 images per message.').length,
    ).toBeGreaterThan(0)
  })

  it('a pasted image is attached; an image with text pastes the text', async () => {
    render(<ChatComposer {...uploadsProps()} />)
    await pasteImage(['Files', 'text/plain'])
    expect(mockUpload).not.toHaveBeenCalled()
    await pasteImage()
    expect(mockUpload).toHaveBeenCalledTimes(1)
  })

  it('without uploads a pasted image is left to the browser', async () => {
    render(<ChatComposer {...props()} />)
    await pasteImage()
    expect(mockUpload).not.toHaveBeenCalled()
  })

  it('a refusal keeps the images; ids the host lost are marked', async () => {
    render(<ChatComposer {...uploadsProps()} />)
    type('hi')
    await attach()
    await attach()
    mockSend.mockRejectedValueOnce(
      new AgentRequestError(
        400,
        'invalid_request',
        'an image is no longer on the server',
        { images: ['id2'] },
      ),
    )
    await send()
    expect(
      screen.getAllByText(/an image is no longer on the host/).length,
    ).toBeGreaterThan(0)
    expect(
      screen.getByRole('img', { name: 'Attachment 1, ready' }),
    ).toBeTruthy()
    expect(
      screen.getByRole('img', { name: 'Attachment 2, No longer on the host' }),
    ).toBeTruthy()
    expect(sendButton()).toBeDisabled()
    expect(box()).toHaveValue('hi [Image #1] [Image #2]')
  })

  it.each([
    ['partial_paste', 409, /holds part of this message/],
    ['uploads_unavailable', 503, /cannot take images/],
    [
      'invalid_request',
      400,
      /Not sent: The server could not use this request\./,
    ],
  ])('%s is explained', async (code, status, text) => {
    render(<ChatComposer {...uploadsProps()} />)
    await attach()
    mockSend.mockRejectedValueOnce(
      new AgentRequestError(status, code, 'too many images'),
    )
    await send()
    expect(screen.getAllByText(text).length).toBeGreaterThan(0)
    expect(screen.getAllByRole('listitem').length).toBe(1)
  })

  it('another pane starts without the images', async () => {
    const { rerender } = render(<ChatComposer {...uploadsProps()} />)
    await attach()
    expect(screen.getAllByRole('listitem').length).toBe(1)
    rerender(
      <ChatComposer
        {...uploadsProps({
          session: { ...uploadsProps().session, paneId: '%4' },
        })}
      />,
    )
    expect(screen.queryAllByRole('listitem').length).toBe(0)
  })

  it('with images, "!" and "/" are text: no shell question, no terminal', async () => {
    const confirm = vi.spyOn(window, 'confirm')
    render(<ChatComposer {...uploadsProps()} />)
    type('!ls')
    await attach()
    await send()
    expect(confirm).not.toHaveBeenCalled()
    expect(mockSend).toHaveBeenLastCalledWith(
      '%3',
      '!ls ',
      'cur1',
      ['id1'],
      [4],
    )
    type('/model')
    await act(async () => {
      fireEvent.keyDown(box(), { key: 'Escape' })
    })
    await attach()
    await send()
    expect(mockSend).toHaveBeenLastCalledWith(
      '%3',
      '/model ',
      'cur1',
      ['id2'],
      [7],
    )
    expect(showView).not.toHaveBeenCalled()
    confirm.mockRestore()
  })

  it('a token left in the draft keeps its number: a new image gets the next', async () => {
    render(<ChatComposer {...uploadsProps()} />)
    type('xem [Image #1] nhé')
    await attach()
    expect(box()).toHaveValue('xem [Image #1] nhé [Image #2]')
    await send()
    expect(mockSend).toHaveBeenCalledWith(
      '%3',
      'xem [Image #1] nhé ',
      'cur1',
      ['id1'],
      [new TextEncoder().encode('xem [Image #1] nhé ').length],
    )
  })

  it('an image picked as the pane changes goes to the pane shown', async () => {
    let pick: (f: File) => void = () => {}
    mockPick.mockImplementationOnce(
      () =>
        new Promise((r) => {
          pick = r
        }),
    )
    const { rerender } = render(<ChatComposer {...uploadsProps()} />)
    type('first pane')
    fireEvent.click(attachButton())
    rerender(
      <ChatComposer
        {...uploadsProps({
          session: { ...uploadsProps().session, paneId: '%4' },
        })}
      />,
    )
    await act(async () => {
      pick(png())
    })
    expect(box()).toHaveValue('[Image #1]')
    expect(screen.getAllByRole('listitem').length).toBe(1)
    expect(sessionStorage.getItem('termote-chat-draft:%3')).toBe('first pane')
    expect(sessionStorage.getItem('termote-chat-draft:%4')).toBe('[Image #1]')
  })

  it('a pasted image goes where the caret is, its token in the text', async () => {
    render(<ChatComposer {...uploadsProps()} />)
    type('ảnh số 1 ảnh số 2')
    fireEvent.focus(box())
    ;(box() as HTMLTextAreaElement).setSelectionRange(9, 9)
    await pasteImage()
    expect(box()).toHaveValue('ảnh số 1 [Image #1] ảnh số 2')
    const end = (box() as HTMLTextAreaElement).value.length
    ;(box() as HTMLTextAreaElement).setSelectionRange(end, end)
    await pasteImage()
    expect(box()).toHaveValue('ảnh số 1 [Image #1] ảnh số 2 [Image #2]')
    await send()
    const enc = new TextEncoder()
    expect(mockSend).toHaveBeenCalledWith(
      '%3',
      'ảnh số 1  ảnh số 2 ',
      'cur1',
      ['id1', 'id2'],
      [
        enc.encode('ảnh số 1 ').length,
        enc.encode('ảnh số 1  ảnh số 2 ').length,
      ],
    )
  })

  it('deleting a token removes its image; removing an image, its token', async () => {
    render(<ChatComposer {...uploadsProps()} />)
    type('a b')
    await attach()
    await attach()
    expect(screen.getAllByRole('listitem').length).toBe(2)
    fireEvent.click(screen.getByRole('button', { name: 'Remove image 1' }))
    expect(box()).toHaveValue('a b [Image #2]')
    expect(screen.getAllByRole('listitem').length).toBe(1)
    type('a b ')
    expect(screen.queryAllByRole('listitem').length).toBe(0)
  })

  it('a slash command picked from the list goes without the images', async () => {
    render(<ChatComposer {...uploadsProps()} />)
    await attach()
    type('/model')
    await act(async () => {
      fireEvent.keyDown(box(), { key: 'Enter' })
    })
    expect(mockSend).toHaveBeenCalledWith('%3', '/model', 'cur1', [], [])
  })
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
    expect(mockSend).toHaveBeenCalledWith(
      '%3',
      'line 1\nline 2',
      'cur1',
      [],
      [],
    )
    expect(box()).toHaveValue('')
    expect(sessionStorage.getItem('termote-chat-draft:%3')).toBeNull()
    expect(transcript.refresh).toHaveBeenCalled()
  })

  it('a send that lands after the pane id shifted clears the draft where it is now', async () => {
    let finish: () => void = () => {}
    mockSend.mockImplementationOnce(
      () =>
        new Promise((r) => {
          finish = () => r({ queued: false })
        }),
    )
    const { rerender } = render(<ChatComposer {...props()} />)
    type('hello')
    fireEvent.click(sendButton())
    // A move: this pane is %5 now, and %3 names another pane with its own draft
    sessionStorage.setItem('termote-chat-draft:%5', 'hello')
    sessionStorage.setItem('termote-chat-draft:%3', 'other pane')
    rerender(
      <ChatComposer
        {...props({ session: { ...props().session, paneId: '%5' } })}
      />,
    )
    await act(async () => {
      finish()
    })
    expect(sessionStorage.getItem('termote-chat-draft:%5')).toBeNull()
    expect(sessionStorage.getItem('termote-chat-draft:%3')).toBe('other pane')
  })

  it('grows to six rows at most', () => {
    render(<ChatComposer {...props()} />)
    type('1\n2\n3\n4\n5\n6\n7\n8')
    expect(box()).toHaveAttribute('rows', '6')
  })

  describe('a command from the command palette', () => {
    const compact = { name: 'compact', source: 'builtin' as const }

    it('goes in front of the draft, caret after it, nothing sent', () => {
      sessionStorage.setItem('termote-chat-draft:%3', 'keep this')
      render(<ChatComposer {...props()} />)
      act(() => requestDraftInsert('%3', compact))
      expect(box()).toHaveValue('/compact keep this')
      expect(box()).toHaveFocus()
      expect((box() as HTMLTextAreaElement).selectionStart).toBe(9)
      expect(sessionStorage.getItem('termote-chat-draft:%3')).toBe(
        '/compact keep this',
      )
      expect(mockSend).not.toHaveBeenCalled()
    })

    it('only focuses the box when asked with no command', () => {
      sessionStorage.setItem('termote-chat-draft:%3', 'keep')
      render(<ChatComposer {...props()} />)
      act(() => requestDraftInsert('%3'))
      expect(box()).toHaveValue('keep')
      expect(box()).toHaveFocus()
    })

    it('reaches a composer mounted later, or on another pane once shown', () => {
      requestDraftInsert('%3', compact)
      requestDraftInsert('%4', { ...compact, name: 'review' })
      const { rerender } = render(<ChatComposer {...props()} />)
      expect(box()).toHaveValue('/compact ')
      rerender(
        <ChatComposer
          {...props({ session: { ...props().session, paneId: '%4' } })}
        />,
      )
      expect(box()).toHaveValue('/review ')
    })

    it('uses the agent trigger ($ for a Codex skill), storage failing', () => {
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('blocked')
      })
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('blocked')
      })
      const codex = {
        ...props().session,
        name: 'codex',
        agentName: 'codex',
      }
      render(<ChatComposer {...props({ session: codex })} />)
      type('hi')
      act(() =>
        requestDraftInsert('%3', {
          name: 'review',
          source: 'user',
          trigger: '$',
        }),
      )
      expect(box()).toHaveValue('$review hi')
      vi.restoreAllMocks()
    })
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

  it('the buttons sit on a row under the box, the hint only with a keyboard', () => {
    const actions = () => screen.getByTestId('composer-actions')
    const after = (a: Node, b: Node) =>
      !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
    const { unmount } = render(
      <ChatComposer {...uploadsProps({ isMobile: true })} />,
    )
    expect(actions().contains(box())).toBe(false)
    expect(after(box(), actions())).toBe(true)
    expect(actions()).toContainElement(attachButton())
    expect(actions()).toContainElement(
      screen.getByRole('button', { name: 'Send' }),
    )
    expect(box()).toHaveAttribute('placeholder', 'Message')
    expect(box()).not.toHaveAttribute('aria-describedby')
    expect(screen.queryByText('Ctrl+Enter to send')).toBeNull()
    unmount()
    render(<ChatComposer {...uploadsProps()} />)
    expect(box()).toHaveAccessibleDescription('Ctrl+Enter to send')
  })

  it('a tap on the empty part of the card focuses the box', () => {
    render(<ChatComposer {...uploadsProps({ isMobile: true })} />)
    fireEvent.pointerDown(screen.getByTestId('composer-actions'))
    expect(box()).toHaveFocus()
    box().blur()
    fireEvent.pointerDown(attachButton())
    expect(box()).not.toHaveFocus()
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
    expect(live).toHaveTextContent(
      'Not sent: The agent cannot take input right now.',
    )
    type('ệ'.repeat(Math.floor(MAX_MESSAGE_BYTES / 3) + 1))
    expect(box()).toHaveAccessibleDescription(/shorten the message/)
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
    expect(mockSend).toHaveBeenCalledWith('%3', '!rm -rf build', 'cur1', [], [])
    confirm.mockRestore()
  })

  it.each([
    [
      'input_not_ready',
      409,
      'a dialog is open',
      'Not sent: The agent cannot take input right now.',
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
      'Not sent: The agent is no longer in this pane.',
      true,
    ],
    // No code: the server's words, as it wrote them
    ['', 500, 'mux command failed', 'Not sent: mux command failed.', false],
  ])(
    'a %s refusal keeps the draft and says why',
    async (code, status, msg, shown, terminal) => {
      mockSend.mockRejectedValue(
        new AgentRequestError(status, code, msg, {
          limit: code === 'text_too_long' ? 16384 : undefined,
        }),
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
        new Promise((r) => {
          resolve = () => r({ queued: false })
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
    expect(mockSend).toHaveBeenCalledWith('', 'x', 'cur1', [], [])
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

  it("an open dialog takes the composer's place", async () => {
    transcript.status = 'blocked'
    promptStore.prompt = {
      promptId: 'id1',
      kind: 'permission',
      title: 'Bash command',
      options: [{ index: 1, label: 'Yes' }],
    }
    render(<ChatComposer {...props()} />)
    expect(promptStore.status).toBe('blocked')
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(
      screen.getByRole('alertdialog', { name: 'Bash command' }),
    ).toBeInTheDocument()
    // Answered: the dialog and the conversation are read again
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /1\.\s*Yes/ }))
    })
    expect(promptStore.refresh).toHaveBeenCalled()
    expect(transcript.refresh).toHaveBeenCalled()
  })

  it('waiting with no dialog read points to the terminal', () => {
    transcript.status = 'blocked'
    render(<ChatComposer {...props()} />)
    expect(screen.queryByRole('textbox')).toBeNull()
    // The card, and the live region that announces it
    expect(
      screen.getAllByText('Claude Code is waiting for you in the terminal.'),
    ).toHaveLength(2)
  })

  it('no waiting card before the first dialog read', () => {
    transcript.status = 'blocked'
    promptStore.loaded = false
    render(<ChatComposer {...props()} />)
    expect(
      screen.getByRole('textbox', { name: 'Message to Claude Code' }),
    ).toBeInTheDocument()
  })

  it('a dialog is announced; a dialog gone before the answer says so', async () => {
    promptStore.prompt = {
      promptId: 'id1',
      kind: 'permission',
      title: 'Bash command',
      options: [{ index: 1, label: 'Yes' }],
    }
    mockAnswerPrompt.mockRejectedValueOnce(
      new AgentRequestError(409, 'prompt_changed', 'x'),
    )
    const { container, rerender } = render(<ChatComposer {...props()} />)
    expect(
      container.querySelector('[aria-live="polite"].sr-only'),
    ).toHaveTextContent('Claude Code asks: Bash command')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /1\.\s*Yes/ }))
    })
    expect(promptStore.show).toHaveBeenCalledWith(null)
    promptStore.prompt = null
    rerender(<ChatComposer {...props()} />)
    expect(screen.getByRole('status')).toHaveTextContent(
      'The dialog closed before the answer was sent.',
    )
  })

  it('a changed dialog replaces the card without a notice', async () => {
    const next: AgentPrompt = {
      promptId: 'id2',
      kind: 'permission',
      title: 'Edit file',
      options: [{ index: 1, label: 'Yes' }],
    }
    promptStore.prompt = {
      promptId: 'id1',
      kind: 'permission',
      title: 'Bash command',
      options: [{ index: 1, label: 'Yes' }],
    }
    mockAnswerPrompt.mockRejectedValueOnce(
      new AgentRequestError(409, 'prompt_changed', 'x', { prompt: next }),
    )
    render(<ChatComposer {...props()} />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /1\.\s*Yes/ }))
    })
    expect(promptStore.show).toHaveBeenCalledWith(next)
  })

  it('another tab of a wizard starts without the last notice, even with the same question', async () => {
    const tab = (current: number): AgentPrompt => ({
      promptId: `id${current}`,
      kind: 'select',
      title: 'Pick one?',
      options: [{ index: 1, label: 'A' }],
      steps: [
        { label: 'Q', current: current === 0 },
        { label: 'Q', current: current === 1 },
        { label: 'Submit' },
      ],
    })
    promptStore.prompt = tab(0)
    mockAnswerPrompt.mockRejectedValueOnce(
      new AgentRequestError(409, 'prompt_changed', 'x'),
    )
    const { rerender } = render(<ChatComposer {...props()} />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /1\.\s*A/ }))
    })
    expect(
      screen.getByText('The screen changed; check the dialog again.'),
    ).toBeInTheDocument()
    promptStore.prompt = tab(1)
    rerender(<ChatComposer {...props()} />)
    expect(
      screen.queryByText('The screen changed; check the dialog again.'),
    ).toBeNull()
  })

  it('an untitled dialog is still announced', () => {
    promptStore.prompt = { kind: 'unsupported', title: '' }
    const { container } = render(<ChatComposer {...props()} />)
    expect(
      container.querySelector('[aria-live="polite"].sr-only'),
    ).toHaveTextContent('Claude Code asks: a question')
  })

  describe('slash commands', () => {
    const options = () => screen.queryAllByRole('option')
    const names = () =>
      options().map((o) => o.querySelector('span span')?.textContent)
    const key = (k: string, init: Partial<KeyboardEventInit> = {}) =>
      fireEvent.keyDown(box(), { key: k, ...init })

    it('opens on "/" at the start, filters and picks without sending', async () => {
      render(<ChatComposer {...props()} />)
      expect(screen.queryByRole('listbox')).toBeNull()
      expect(commandsStore.enabled).toBe(false)
      type('/')
      expect(commandsStore.enabled).toBe(true)
      expect(names()[0]).toBe('/exit')
      expect(box()).toHaveAttribute(
        'aria-controls',
        screen.getByRole('listbox').id,
      )
      expect(box()).toHaveAttribute('aria-activedescendant', options()[0].id)
      type('/comp')
      expect(names()).toEqual(['/compact'])
      key('Enter')
      expect(box()).toHaveValue('/compact ')
      expect((box() as HTMLTextAreaElement).selectionStart).toBe(9)
      expect(screen.queryByRole('listbox')).toBeNull()
      expect(mockSend).not.toHaveBeenCalled()
      // Enter is a new line again once arguments are being typed
      key('Enter')
      expect(mockSend).not.toHaveBeenCalled()
    })

    it('not in the middle of a message; a space or a new line closes it', () => {
      render(<ChatComposer {...props()} />)
      type('hello /comp')
      expect(screen.queryByRole('listbox')).toBeNull()
      type('/compact ')
      expect(screen.queryByRole('listbox')).toBeNull()
      type('/compact\n')
      expect(screen.queryByRole('listbox')).toBeNull()
    })

    it('arrow keys move and wrap; Tab picks the highlighted row', () => {
      render(<ChatComposer {...props()} />)
      type('/co')
      const n = options().length
      expect(n).toBeGreaterThan(3)
      key('ArrowUp')
      expect(options()[n - 1]).toHaveAttribute('aria-selected', 'true')
      key('ArrowDown')
      expect(options()[0]).toHaveAttribute('aria-selected', 'true')
      key('ArrowDown')
      key('ArrowDown')
      expect(options()[2]).toHaveAttribute('aria-selected', 'true')
      expect(names()[2]).toBe('/context')
      key('Tab')
      expect(box()).toHaveValue('/context ')
    })

    it('Shift+Enter is a new line, Ctrl+Enter sends, with the list open', async () => {
      render(<ChatComposer {...props()} />)
      type('/comp')
      key('Enter', { shiftKey: true })
      expect(box()).toHaveValue('/comp')
      await act(async () => {
        key('Enter', { ctrlKey: true })
      })
      expect(mockSend).toHaveBeenCalledWith('%3', '/comp', 'cur1', [], [])
    })

    it('Escape closes it until the "/" is gone', () => {
      render(<ChatComposer {...props()} />)
      type('/co')
      key('Escape')
      expect(screen.queryByRole('listbox')).toBeNull()
      expect(box()).not.toHaveAttribute('aria-activedescendant')
      type('/com')
      expect(screen.queryByRole('listbox')).toBeNull()
      type('')
      type('/')
      expect(screen.getByRole('listbox')).toBeTruthy()
      // Escape with the list closed does nothing special
      type('x')
      key('Escape')
    })

    it('says when nothing matches, and the keys do nothing then', () => {
      render(<ChatComposer {...props()} />)
      type('/zzzz')
      expect(screen.getByText('No matching command')).toBeTruthy()
      expect(box()).not.toHaveAttribute('aria-controls')
      key('Enter')
      expect(box()).toHaveValue('/zzzz')
    })

    it('lists the project and user commands after the built-ins, tapped to pick', () => {
      commandsStore.list = [
        {
          name: 'deploy',
          description: 'Ship it',
          source: 'project',
          kind: 'command',
        },
        { name: 'compact', description: 'mine', source: 'user', kind: 'skill' },
      ]
      render(<ChatComposer {...props({ isMobile: true })} />)
      type('/dep')
      expect(names()).toEqual(['/deploy'])
      type('/compact')
      // The built-in wins over a custom command of the same name
      expect(options()).toHaveLength(1)
      expect(options()[0].textContent).toContain('built-in')
      type('/dep')
      fireEvent.click(options()[0])
      expect(box()).toHaveValue('/deploy ')
    })

    it('on a phone Enter picks while the list is open', () => {
      render(<ChatComposer {...props({ isMobile: true })} />)
      type('/comp')
      key('Enter')
      expect(box()).toHaveValue('/compact ')
    })

    it('an agent without built-ins lists only its "/" commands', () => {
      commandsStore.list = [{ name: 'mine', source: 'user', kind: 'command' }]
      const p = props()
      render(
        <ChatComposer {...p} session={{ ...p.session, agentName: 'other' }} />,
      )
      type('/')
      expect(names()).toEqual(['/mine'])
      type('$')
      expect(screen.queryByRole('listbox')).toBeNull()
    })

    it('a session without an agent name gets no built-ins either', () => {
      commandsStore.list = [{ name: 'mine', source: 'user', kind: 'command' }]
      const p = props()
      render(
        <ChatComposer
          {...p}
          session={{ ...p.session, agentName: undefined }}
        />,
      )
      type('/')
      expect(names()).toEqual(['/mine'])
    })

    it('a terminal-only command is sent and shows the terminal', async () => {
      render(<ChatComposer {...props()} />)
      type('/mod')
      expect(options()[0].textContent).toContain('opens in Terminal')
      await act(async () => {
        key('Enter')
      })
      expect(mockSend).toHaveBeenCalledWith('%3', '/model', 'cur1', [], [])
      expect(showView).toHaveBeenCalledWith('terminal')
      expect(box()).toHaveValue('')
    })

    it('typed with arguments, it stays in the chat; a refusal stays too', async () => {
      render(<ChatComposer {...props()} />)
      type('/model sonnet')
      await send()
      expect(mockSend).toHaveBeenCalledWith(
        '%3',
        '/model sonnet',
        'cur1',
        [],
        [],
      )
      expect(showView).not.toHaveBeenCalled()
      mockSend.mockRejectedValueOnce(
        new AgentRequestError(409, 'input_not_ready', 'busy'),
      )
      type('/model')
      await send()
      expect(showView).not.toHaveBeenCalled()
    })

    it('/exit asks first, picked or typed; Cancel sends nothing', async () => {
      HTMLDialogElement.prototype.showModal = vi.fn(function (
        this: HTMLDialogElement,
      ) {
        this.setAttribute('open', '')
      })
      HTMLDialogElement.prototype.close = vi.fn()
      render(<ChatComposer {...props()} />)
      type('/ex')
      key('Enter')
      expect(screen.getByText('Exit Claude Code?')).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(mockSend).not.toHaveBeenCalled()
      type('/quit')
      await send()
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Exit' }))
      })
      expect(mockSend).toHaveBeenCalledWith('%3', '/quit', 'cur1', [], [])
      expect(box()).toHaveValue('')
    })

    describe('Codex', () => {
      const codex = (over: Partial<ViewProps> = {}) => {
        const p = props(over)
        return render(
          <ChatComposer
            {...p}
            session={{ ...p.session, agentName: 'codex' }}
          />,
        )
      }
      // Moves the caret (or selects) as a tap or the arrow keys would
      const select = (start: number, end = start) => {
        ;(box() as HTMLTextAreaElement).setSelectionRange(start, end)
        fireEvent.select(box())
      }

      beforeEach(() => {
        commandsStore.list = [
          {
            name: 'skill-a',
            description: 'First',
            source: 'user',
            kind: 'skill',
          },
          { name: 'imagegen', source: 'system', kind: 'skill' },
          { name: 'review', source: 'project', kind: 'skill' },
        ]
      })

      it('"/" lists the Codex built-ins only', () => {
        codex()
        expect(
          screen.getByRole('textbox', { name: 'Message to Codex' }),
        ).toBeInTheDocument()
        type('/')
        expect(names()[0]).toBe('/exit')
        expect(commandsStore.enabled).toBe(false)
        // The skill named review is not a "/" command
        type('/rev')
        expect(names()).toEqual(['/review', '/approve'])
        expect(options()[0].textContent).toContain('built-in')
        type('/mod')
        expect(options()[0].textContent).toContain('opens in Terminal')
      })

      it('"$" at the start lists the skills and picks one', () => {
        codex()
        type('$')
        expect(commandsStore.enabled).toBe(true)
        expect(screen.getByRole('listbox')).toHaveAttribute(
          'aria-label',
          'Skills',
        )
        expect(names()).toEqual(['$skill-a', '$imagegen', '$review'])
        expect(options()[1].textContent).toContain('system')
        type('$zz')
        expect(screen.getByText('No matching skill')).toBeTruthy()
        type('$ima')
        key('Tab')
        expect(box()).toHaveValue('$imagegen ')
        expect((box() as HTMLTextAreaElement).selectionStart).toBe(10)
        expect(screen.queryByRole('listbox')).toBeNull()
        expect(mockSend).not.toHaveBeenCalled()
      })

      it('"$" in the middle of a message replaces only that word', () => {
        codex()
        type('xem $sk')
        expect(names()).toEqual(['$skill-a'])
        key('Enter')
        expect(box()).toHaveValue('xem $skill-a ')
        expect((box() as HTMLTextAreaElement).selectionStart).toBe(13)
        expect(sessionStorage.length).toBeGreaterThan(0)
      })

      it('a pick that changes nothing leaves later typing alone', () => {
        codex()
        type('$skill-a\nfoo')
        select(8)
        key('Enter')
        const el = box() as HTMLTextAreaElement
        expect(el).toHaveValue('$skill-a\nfoo')
        type('$skill-a\nfoox')
        expect(el.selectionStart).toBe(13)
      })

      it('a select-all right after a pick is not undone a frame later', async () => {
        codex()
        type('$sk')
        key('Enter')
        const el = box() as HTMLTextAreaElement
        expect(el).toHaveValue('$skill-a ')
        // What replacing the whole text starts with, before its typing
        el.setSelectionRange(0, el.value.length)
        await act(() => new Promise((ok) => setTimeout(ok, 50)))
        expect([el.selectionStart, el.selectionEnd]).toEqual([0, 9])
      })

      it('follows the caret: inside a word, out of it, a selection', () => {
        codex()
        type('xem $sk ngay')
        expect(screen.queryByRole('listbox')).toBeNull()
        select(7)
        expect(names()).toEqual(['$skill-a'])
        select(4, 7)
        expect(screen.queryByRole('listbox')).toBeNull()
        select(6)
        fireEvent.click(options()[0])
        expect(box()).toHaveValue('xem $skill-a ngay')
      })

      it('Escape closes it for that word only', () => {
        codex()
        type('$sk')
        key('Escape')
        expect(screen.queryByRole('listbox')).toBeNull()
        type('$ski')
        expect(screen.queryByRole('listbox')).toBeNull()
        type('$ski $')
        expect(screen.getByRole('listbox')).toBeTruthy()
      })

      it('a message with a skill is sent without asking', async () => {
        codex()
        type('dùng $skill-a đi')
        await send()
        expect(mockSend).toHaveBeenCalledWith(
          '%3',
          'dùng $skill-a đi',
          'cur1',
          [],
          [],
        )
        expect(box()).toHaveValue('')
        expect(screen.queryByRole('listbox')).toBeNull()
        // Ending with a skill name: a space keeps Codex's list from taking Enter
        type('dùng $skill-a')
        await send()
        expect(mockSend).toHaveBeenLastCalledWith(
          '%3',
          'dùng $skill-a ',
          'cur1',
          [],
          [],
        )
      })

      it('/quit and /logout ask first; /cwd goes as it is', async () => {
        HTMLDialogElement.prototype.showModal = vi.fn(function (
          this: HTMLDialogElement,
        ) {
          this.setAttribute('open', '')
        })
        HTMLDialogElement.prototype.close = vi.fn()
        codex()
        type('/quit')
        await send()
        expect(screen.getByText('Exit Codex?')).toBeTruthy()
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
        type('/logout')
        await send()
        expect(mockSend).not.toHaveBeenCalled()
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
        type('/cwd')
        await send()
        expect(mockSend).toHaveBeenCalledWith('%3', '/cwd', 'cur1', [], [])
      })

      it('Claude Code opens nothing on "$", and sends it as typed', async () => {
        render(<ChatComposer {...props()} />)
        type('$sk')
        expect(screen.queryByRole('listbox')).toBeNull()
        await send()
        expect(mockSend).toHaveBeenCalledWith('%3', '$sk', 'cur1', [], [])
      })

      it('follows the caret before the agent turns to Codex', () => {
        const p = props()
        const { rerender } = render(<ChatComposer {...p} />)
        type('$sk and more')
        ;(box() as HTMLTextAreaElement).setSelectionRange(3, 3)
        fireEvent.select(box())
        rerender(
          <ChatComposer
            {...p}
            session={{ ...p.session, agentName: 'codex' }}
          />,
        )
        expect(names()).toEqual(['$skill-a'])
      })
    })

    it('nothing is sent before the conversation is read or while too long', async () => {
      transcript.cursor = undefined
      const { rerender } = render(<ChatComposer {...props()} />)
      type('/mod')
      await act(async () => {
        key('Enter')
      })
      expect(mockSend).not.toHaveBeenCalled()
      transcript.cursor = 'cur1'
      rerender(<ChatComposer {...props()} />)
      type(`/${'a'.repeat(MAX_MESSAGE_BYTES + 1)}`)
      await act(async () => {
        key('Enter', { ctrlKey: true })
      })
      expect(mockSend).not.toHaveBeenCalled()
    })
  })
})

describe('ChatComposer prompt templates', () => {
  const withTemplates = (over: Partial<ViewProps> = {}) =>
    props({
      mux: {
        backend: 'tmux',
        caps: {
          clientSideSelect: false,
          copyMode: true,
          agentChat: true,
          templates: true,
        },
      },
      ...over,
    })
  const review = {
    id: 't1',
    name: 'Code review',
    text: 'Review {{input}}',
    updated: 'u',
  }
  const deploy = {
    id: 't2',
    name: 'Zebra deploy',
    text: 'ship it',
    updated: 'u',
  }
  const options = () => screen.queryAllByRole('option')
  const key = (k: string, init: Partial<KeyboardEventInit> = {}) =>
    fireEvent.keyDown(box(), { key: k, ...init })
  // Picks made, as the fill dialog takes them
  let fills: TemplateFill[] = []
  let off = () => {}

  beforeEach(() => {
    promptTemplates.templates = [review, deploy]
    fills = []
    off = onTemplateFill(() => {
      const f = takeTemplateFill()
      if (f) fills.push(f)
    })
    HTMLDialogElement.prototype.showModal = vi.fn(function (
      this: HTMLDialogElement,
    ) {
      this.setAttribute('open', '')
    })
    HTMLDialogElement.prototype.close = vi.fn()
  })
  afterEach(() => off())

  it('has no Templates button or group without them on the server', () => {
    render(<ChatComposer {...props()} />)
    expect(screen.queryByRole('button', { name: 'Templates' })).toBeNull()
    type('/zeb')
    expect(screen.queryByText('Templates')).toBeNull()
    expect(promptTemplates.refresh).not.toHaveBeenCalled()
  })

  it('the Templates button picks one for the fill dialog; Manage opens Settings', () => {
    const openSettings = vi.fn()
    const { rerender } = render(
      <ChatComposer {...withTemplates({ openSettings })} />,
    )
    const button = screen.getByRole('button', { name: 'Templates' })
    expect(button).toHaveAttribute('aria-haspopup', 'dialog')
    fireEvent.click(button)
    expect(promptTemplates.refresh).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('option', { name: /Zebra deploy/ }))
    expect(fills).toEqual([{ paneId: '%3', templateId: 't2', agent: 'claude' }])
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(mockSend).not.toHaveBeenCalled()

    fireEvent.click(button)
    fireEvent.click(screen.getByRole('button', { name: 'Manage templates…' }))
    expect(openSettings).toHaveBeenCalledWith('templates')
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(button)
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()

    // No Settings to open: no Manage
    rerender(<ChatComposer {...withTemplates()} />)
    fireEvent.click(button)
    expect(
      screen.queryByRole('button', { name: 'Manage templates…' }),
    ).toBeNull()
  })

  it('lists them after the commands in the / list, never highlighted first', () => {
    render(<ChatComposer {...withTemplates()} />)
    type('/zeb')
    expect(promptTemplates.refresh).toHaveBeenCalled()
    const group = screen.getByRole('group', { name: 'Templates' })
    expect(group).toHaveTextContent('Zebra deploy')
    // No command matches: nothing highlighted, Enter does what it did
    expect(box()).not.toHaveAttribute('aria-activedescendant')
    key('Enter', { ctrlKey: true })
    expect(fills).toEqual([])
    key('Enter')
    expect(fills).toEqual([])
    expect(box()).toHaveValue('/zeb')
    // An arrow goes there; Enter picks it, the draft kept until Insert
    key('ArrowDown')
    expect(box()).toHaveAttribute('aria-activedescendant', options()[0].id)
    key('Enter')
    expect(fills).toEqual([
      {
        paneId: '%3',
        templateId: 't2',
        agent: 'claude',
        at: { start: 0, end: 4, was: '/zeb' },
      },
    ])
    expect(box()).toHaveValue('/zeb')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('a command found is highlighted first; arrows reach a template', () => {
    render(<ChatComposer {...withTemplates()} />)
    promptTemplates.templates = [review, { ...deploy, name: 'compact notes' }]
    type('/comp')
    const all = options()
    expect(all.map((o) => o.textContent?.slice(0, 8))).toEqual([
      '/compact',
      'compact ',
    ])
    expect(box()).toHaveAttribute('aria-activedescendant', all[0].id)
    key('ArrowUp')
    expect(box()).toHaveAttribute('aria-activedescendant', all[1].id)
    key('Tab')
    expect(fills[0]).toMatchObject({ templateId: 't2' })
    // The other way round: ArrowUp from nothing highlighted ends on the last
    // A pick holds the list shut while the draft is a "/" word
    fills = []
    type('')
    promptTemplates.templates = [review, deploy]
    type('/zeb')
    expect(box()).not.toHaveAttribute('aria-activedescendant')
    key('ArrowUp')
    expect(box()).toHaveAttribute('aria-activedescendant', options()[0].id)
    fireEvent.click(options()[0])
    expect(fills[0]).toMatchObject({ templateId: 't2' })
  })

  it('a filled template replaces the /name, or goes where the caret was', () => {
    render(<ChatComposer {...withTemplates()} />)
    type('/de')
    act(() =>
      requestDraftInsert(
        '%3',
        { text: 'ship it', at: { start: 0, end: 3, was: '/de' } },
        'claude',
      ),
    )
    expect(box()).toHaveValue('ship it')
    expect(box()).toHaveFocus()
    expect((box() as HTMLTextAreaElement).selectionStart).toBe(7)
    // The /name changed meanwhile: at the caret instead
    ;(box() as HTMLTextAreaElement).setSelectionRange(4, 4)
    act(() =>
      requestDraftInsert(
        '%3',
        { text: 'X', at: { start: 0, end: 3, was: '/de' } },
        'claude',
      ),
    )
    expect(box()).toHaveValue('shipX it')
    expect(mockSend).not.toHaveBeenCalled()
    // Asked for another agent: dropped
    act(() => requestDraftInsert('%3', { text: 'nope' }, 'codex'))
    expect(box()).toHaveValue('shipX it')
  })

  it('a template for a composer never focused goes at the end of the draft', () => {
    sessionStorage.setItem('termote-chat-draft:%3', 'draft ')
    requestDraftInsert('%3', { text: 'more' }, 'claude')
    render(<ChatComposer {...withTemplates()} />)
    expect(box()).toHaveValue('draft more')
  })
})

describe('ChatComposer while the agent works', () => {
  it('sends to the agent, which queues it, and says so', async () => {
    transcript.status = 'working'
    mockSend.mockResolvedValueOnce({ queued: true })
    render(<ChatComposer {...props()} />)
    type('next step')
    await send()
    expect(mockSend).toHaveBeenCalledWith('%3', 'next step', 'cur1', [], [])
    expect(box()).toHaveValue('')
    expect(screen.getByRole('status')).toHaveTextContent(
      'Queued: Claude Code reads it when it is ready.',
    )
  })

  it('a queued command that opens a screen keeps the Chat view', async () => {
    transcript.status = 'working'
    mockSend.mockResolvedValueOnce({ queued: true })
    render(<ChatComposer {...props()} />)
    type('/model')
    await send()
    expect(mockSend).toHaveBeenCalledWith('%3', '/model', 'cur1', [], [])
    expect(showView).not.toHaveBeenCalled()
  })

  it('a message read right away shows no notice', async () => {
    render(<ChatComposer {...props()} />)
    type('hello')
    await send()
    expect(screen.queryByRole('status')).toBeNull()
  })
})
