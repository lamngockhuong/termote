import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RequestError } from '../hooks/use-mux-api'
import type { Session } from '../types/session'
import {
  addReviewComment,
  loadReview,
  type ReviewComment,
  resetReviewDrafts,
} from '../utils/review-draft'
import { CHAT_VIEW_ID } from '../view-ids'
import { rememberAgent } from './agent-pane-picker'
import { ReviewControl } from './review-panel'

const mockSend = vi.fn()
vi.mock('../utils/send-to-agent', () => ({
  sendToAgent: (...a: unknown[]) => mockSend(...a),
}))

const session = (over: Partial<Session>): Session => ({
  id: 's',
  name: 'Tab',
  icon: '',
  description: '',
  groupId: 'g',
  ...over,
})

// The pane reviewed (%1, a shell) and an agent pane in another tab
const HERE = session({ id: 'here', paneId: '%1', name: 'Shell' })
const AGENT = session({
  id: 'ag',
  name: 'Agent',
  paneId: '%9',
  hasAgent: true,
  agentName: 'claude',
})

const comment = (over: Partial<ReviewComment> = {}): ReviewComment => ({
  id: 'c1',
  root: '/r',
  path: 'src/a.ts',
  source: 'unstaged',
  start: 12,
  end: 18,
  quote: '+x',
  text: 'Why?',
  at: 1,
  ...over,
})

type Props = Parameters<typeof ReviewControl>[0]
function show(over: Partial<Props> = {}) {
  const props: Props = {
    paneId: '%1',
    session: HERE,
    sessions: [HERE, AGENT],
    canSend: true,
    notify: vi.fn(),
    openTab: vi.fn(),
    onOpenComment: vi.fn(),
    ...over,
  }
  return { ...props, ...render(<ReviewControl {...props} />) }
}

const openReview = () =>
  fireEvent.click(screen.getByRole('button', { name: /^Review, / }))
const sendButton = () => screen.getByRole('button', { name: /^Send to/ })

beforeEach(() => {
  mockSend.mockReset()
  localStorage.clear()
  HTMLDialogElement.prototype.showModal = vi.fn(function (
    this: HTMLDialogElement,
  ) {
    this.setAttribute('open', '')
  })
  HTMLDialogElement.prototype.close = vi.fn()
})
afterEach(() => {
  sessionStorage.clear()
  resetReviewDrafts()
})

describe('ReviewControl', () => {
  it('shows nothing while the review is empty', () => {
    show()
    expect(screen.queryByRole('button', { name: /^Review/ })).toBeNull()
  })

  it('lists the comments by file, opens, edits and deletes one', () => {
    addReviewComment('%1', comment())
    addReviewComment('%1', comment({ id: 'c2', path: 'b.md', text: 'two' }))
    addReviewComment(
      '%1',
      comment({ id: 'c3', start: 1, end: 1, text: 'three\nlines' }),
    )
    const p = show()
    expect(
      screen.getByRole('button', { name: 'Review, 3 comments' }),
    ).toHaveTextContent('3')
    openReview()
    const dialog = screen.getByRole('dialog')
    const files = within(dialog).getAllByRole('region')
    expect(files.map((f) => f.getAttribute('aria-label'))).toEqual([
      'src/a.ts',
      'b.md',
    ])
    expect(within(files[0]).getAllByRole('listitem')).toHaveLength(2)
    fireEvent.click(
      within(files[0]).getByRole('button', {
        name: 'lines 12-18 · unstaged diff',
      }),
    )
    expect(p.onOpenComment).toHaveBeenCalledWith(loadReview('%1')[0])
    expect(screen.queryByRole('dialog')).toBeNull()

    openReview()
    fireEvent.click(
      within(screen.getAllByRole('region')[1]).getByRole('button', {
        name: 'Edit comment',
      }),
    )
    const box = screen.getByRole('textbox', { name: 'Comment' })
    expect(box).toHaveValue('two')
    fireEvent.change(box, { target: { value: 'edited' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(loadReview('%1')[1].text).toBe('edited')

    fireEvent.click(
      within(screen.getAllByRole('region')[1]).getByRole('button', {
        name: 'Delete comment',
      }),
    )
    expect(loadReview('%1').map((c) => c.id)).toEqual(['c1', 'c3'])
  })

  it('closes the editor without a change', () => {
    addReviewComment('%1', comment())
    show()
    openReview()
    fireEvent.click(screen.getByRole('button', { name: 'Edit comment' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('textbox', { name: 'Comment' })).toBeNull()
    expect(loadReview('%1')[0].text).toBe('Why?')
  })

  it('clears the whole review once asked, and stays open empty', () => {
    addReviewComment('%1', comment())
    show()
    openReview()
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(screen.getByText('1 comment will be deleted.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(loadReview('%1')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    const confirm = screen.getAllByRole('button', { name: 'Clear' }).at(-1)
    fireEvent.click(confirm as HTMLElement)
    expect(loadReview('%1')).toEqual([])
    expect(screen.getByText('No comments')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Clear' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('button', { name: /^Review/ })).toBeNull()
  })

  it("sends to the pane's own agent, removing only what was sent", async () => {
    const own = session({
      id: 'here',
      paneId: '%1',
      hasAgent: true,
      agentName: 'claude',
    })
    addReviewComment('%1', comment())
    let done!: (v: { queued: boolean }) => void
    mockSend.mockReturnValue(new Promise((r) => (done = r)))
    const p = show({ session: own, sessions: [own, AGENT] })
    openReview()
    expect(screen.queryByRole('button', { name: 'Change' })).toBeNull()
    fireEvent.click(sendButton())
    expect(mockSend).toHaveBeenCalledWith(
      '%1',
      expect.stringContaining('1. `src/a.ts` lines 12-18 (unstaged diff)'),
    )
    expect(screen.getByRole('button', { name: /Sending/ })).toBeDisabled()
    // Nothing being sent changes meanwhile
    expect(screen.getByRole('button', { name: 'Edit comment' })).toBeDisabled()
    expect(
      screen.getByRole('button', { name: 'Delete comment' }),
    ).toBeDisabled()
    // Added while the send is on its way: kept
    act(() => {
      addReviewComment('%1', comment({ id: 'late' }))
    })
    await act(async () => done({ queued: false }))
    expect(loadReview('%1').map((c) => c.id)).toEqual(['late'])
    expect(p.notify).toHaveBeenCalledWith('Sent to Claude Code', {
      variant: 'success',
      action: expect.objectContaining({ label: 'Open chat' }),
    })
    const { action } = vi.mocked(p.notify).mock.calls[0][1] as {
      action: { onClick: () => void }
    }
    action.onClick()
    expect(p.openTab).toHaveBeenCalledWith('here', '%1', CHAT_VIEW_ID)
    // The own pane is never remembered for the group
    expect(localStorage.getItem('termote-task-agent:g')).toBeNull()
  })

  it('asks which agent first, then remembers it for the group', async () => {
    addReviewComment('%1', comment())
    mockSend.mockResolvedValue({ queued: true })
    const p = show({ session: session({ ...HERE, groupId: undefined }) })
    openReview()
    expect(sendButton()).toHaveTextContent('Send to…')
    fireEvent.click(sendButton())
    fireEvent.click(screen.getByRole('button', { name: /Agent/ }))
    await waitFor(() =>
      expect(p.notify).toHaveBeenCalledWith('Queued for Claude Code', {
        variant: 'success',
        action: expect.anything(),
      }),
    )
    expect(mockSend).toHaveBeenCalledWith('%9', expect.any(String))
    expect(localStorage.getItem('termote-task-agent:')).toBe('%9')
    expect(loadReview('%1')).toEqual([])
  })

  it('sends to the agent remembered, which can be changed', async () => {
    rememberAgent('g', '%9')
    addReviewComment('%1', comment())
    mockSend.mockResolvedValue({ queued: false })
    show({ openTab: undefined })
    openReview()
    expect(sendButton()).toHaveTextContent('Send to Claude Code')
    expect(screen.getByText('Agent')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Change' }))
    expect(screen.getByText('Send to which agent?')).toBeInTheDocument()
    fireEvent.click(
      screen.getAllByRole('button', { name: 'Close' }).at(-1) as HTMLElement,
    )
    expect(screen.queryByText('Send to which agent?')).toBeNull()
    fireEvent.click(sendButton())
    await waitFor(() => expect(loadReview('%1')).toEqual([]))
    expect(mockSend).toHaveBeenCalledWith('%9', expect.any(String))
  })

  it('keeps the review when the send is refused or fails', async () => {
    rememberAgent('g', '%9')
    addReviewComment('%1', comment())
    mockSend.mockRejectedValueOnce(
      new RequestError(409, 'not_idle', 'The agent is busy'),
    )
    const p = show()
    openReview()
    fireEvent.click(sendButton())
    await waitFor(() =>
      expect(p.notify).toHaveBeenCalledWith(
        'Not sent: The server could not finish this. Try again',
        {
          variant: 'danger',
        },
      ),
    )
    expect(loadReview('%1')).toHaveLength(1)
    mockSend.mockRejectedValueOnce(new Error('offline'))
    fireEvent.click(sendButton())
    await waitFor(() =>
      expect(p.notify).toHaveBeenCalledWith('Could not send the review', {
        variant: 'danger',
      }),
    )
    expect(loadReview('%1')).toHaveLength(1)
  })

  it.each([
    [
      'no pane runs an agent',
      { sessions: [HERE] },
      'No pane runs Claude Code or Codex',
    ],
    [
      'the server takes no message',
      { canSend: false },
      'This server cannot send a message to an agent',
    ],
  ])('cannot send when %s', (_, over, why) => {
    addReviewComment('%1', comment())
    show(over)
    openReview()
    expect(sendButton()).toBeDisabled()
    expect(screen.getByText(why)).toBeInTheDocument()
  })

  it('cannot send a review too long for one message', () => {
    for (let i = 0; i < 5; i++)
      addReviewComment('%1', comment({ id: `${i}`, text: 'x'.repeat(4000) }))
    show()
    openReview()
    expect(sendButton()).toBeDisabled()
    expect(
      screen.getByText(/^Too long for one message: \d+\.\d of 16\.0 KiB$/),
    ).toBeInTheDocument()
  })
})
