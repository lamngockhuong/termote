import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentPrompt } from '../hooks/use-mux-api'
import type { Session, SessionPane } from '../types/session'

const { mockFetchPrompt, mockAnswer } = vi.hoisted(() => ({
  mockFetchPrompt: vi.fn(),
  mockAnswer: vi.fn(),
}))
vi.mock('../hooks/use-mux-api', async (orig) => ({
  ...(await orig<typeof import('../hooks/use-mux-api')>()),
  fetchAgentPrompt: (id: string) => mockFetchPrompt(id),
  answerAgentPrompt: (...a: unknown[]) => mockAnswer(...a),
}))

import { resetAgentPromptStores } from '../hooks/use-agent-prompt'
import { AgentRequestError } from '../hooks/use-mux-api'
import { ANSWER_GRACE } from '../utils/needs-me-queue'
import { NeedsMeQueue, type QueueCard } from './needs-me-queue'

const dialog = (id: string): AgentPrompt => ({
  kind: 'permission',
  promptId: `id-${id}`,
  title: `Run the tests of ${id}?`,
  options: [
    { index: 1, label: 'Yes' },
    { index: 2, label: 'No' },
  ],
})

const card = (
  id: string,
  min: number | undefined,
  status: SessionPane['agentStatus'] = 'blocked',
  agentName = 'claude',
): QueueCard => {
  const session: Session = {
    id: `t-${id}`,
    name: id,
    icon: '',
    description: '',
  }
  return {
    session,
    pane: {
      id,
      label: agentName,
      hasAgent: true,
      agentName,
      agentStatus: status,
      agentSince: min === undefined ? undefined : `2026-10-13T09:0${min}:00Z`,
    },
    where: `w / ${id}`,
  }
}

function setup(
  cards: QueueCard[],
  { readOnly = false, canAnswer = true } = {},
) {
  const onOpen = vi.fn()
  const ui = (c: QueueCard[]) => (
    <NeedsMeQueue
      cards={c}
      readOnly={readOnly}
      canAnswer={() => canAnswer}
      onOpen={onOpen}
    />
  )
  const utils = render(ui(cards))
  return { ...utils, onOpen, update: (c: QueueCard[]) => utils.rerender(ui(c)) }
}

const yes = () => screen.getByRole('button', { name: /1\.\s*Yes$/ })

// Panes whose dialog an answer closed
const closed = new Set<string>()

beforeEach(() => {
  vi.clearAllMocks()
  resetAgentPromptStores()
  closed.clear()
  mockFetchPrompt.mockImplementation(async (id: string) =>
    closed.has(id) ? null : dialog(id),
  )
  mockAnswer.mockImplementation(async (id: string) => {
    closed.add(id)
  })
})

const answered = () => screen.findByText('Answered.')
const next = async (name: string) => {
  const button = screen.getByRole('button', { name })
  expect(button).toBeDisabled()
  await waitFor(() => expect(button).toBeEnabled())
  fireEvent.click(button)
}

describe('NeedsMeQueue', () => {
  it('shows nothing without a blocked agent', () => {
    const { container } = setup([card('a', 1, 'working')])
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the hidden characters of the group and tab names', () => {
    setup([{ ...card('a', 1), where: 'w\u202e / a' }])
    expect(
      screen.getByRole('heading', {
        name: 'Needs you: Claude Code, w⟨U+202E⟩ / a',
      }),
    ).toBeInTheDocument()
  })

  it('shows the one waiting longest, and reads only its dialog', async () => {
    setup([card('new', 5), card('old', 1), card('busy', 2, 'working')])
    expect(
      screen.getByRole('heading', { name: 'Needs you: Claude Code, w / old' }),
    ).toBeInTheDocument()
    expect(screen.getByText('1 more waiting')).toBeInTheDocument()
    expect(await screen.findByText('Run the tests of old?')).toBeInTheDocument()
    expect(mockFetchPrompt.mock.calls.map((c) => c[0])).toEqual(['old'])
  })

  it('an answer never moves on by itself: a second tap answers nothing', async () => {
    setup([card('a', 1), card('b', 2)])
    await screen.findByText('Run the tests of a?')
    await act(async () => fireEvent.click(yes()))
    expect(mockAnswer).toHaveBeenCalledTimes(1)
    expect(mockAnswer).toHaveBeenCalledWith('a', 'id-a', 1)
    await answered()
    // The same spot tapped again: no answer button is there, and Next
    // waits a moment
    expect(screen.queryByRole('button', { name: /1\.\s*Yes$/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Skip' })).toBeNull()
    await next('Next (1 left)')
    const title = screen.getByRole('heading', {
      name: 'Needs you: Claude Code, w / b',
    })
    expect(title).toHaveFocus()
    await screen.findByText('Run the tests of b?')
    expect(mockAnswer).toHaveBeenCalledTimes(1)
  })

  it('the last answer ends with Done', async () => {
    const { container } = setup([card('a', 1)])
    await screen.findByText('Run the tests of a?')
    expect(screen.getByText('last one')).toBeInTheDocument()
    await act(async () => fireEvent.click(yes()))
    await answered()
    await next('Done')
    expect(container).toBeEmptyDOMElement()
  })

  it('a newcomer waiting longer does not go in front of the card on top', async () => {
    const { update } = setup([card('a', 5)])
    await screen.findByText('Run the tests of a?')
    update([card('a', 5), card('older', 1)])
    expect(
      screen.getByRole('heading', { name: 'Needs you: Claude Code, w / a' }),
    ).toBeInTheDocument()
    // The newcomer's tab closed: it leaves the queue, the top stays
    update([card('a', 5)])
    expect(screen.getByText('last one')).toBeInTheDocument()
  })

  it('an answered card stays after its agent left the list', async () => {
    const { update } = setup([card('a', 1)])
    await screen.findByText('Run the tests of a?')
    await act(async () => fireEvent.click(yes()))
    await answered()
    update([])
    expect(screen.getByText('Answered.')).toBeInTheDocument()
  })

  it('skip moves to the next card; skipped ones can be shown again', async () => {
    setup([card('a', 1), card('b', 2)])
    // A queue that appears takes no focus
    expect(
      screen.getByRole('heading', { name: 'Needs you: Claude Code, w / a' }),
    ).not.toHaveFocus()
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }))
    expect(
      screen.getByRole('heading', { name: 'Needs you: Claude Code, w / b' }),
    ).toHaveFocus()
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }))
    expect(
      screen.getByText(/2 skipped dialogs are still waiting/),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Show again' }))
    expect(
      screen.getByRole('heading', { name: 'Needs you: Claude Code, w / a' }),
    ).toHaveFocus()
    cleanup()
    setup([card('c', 1)])
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }))
    expect(
      screen.getByText(/1 skipped dialog is still waiting/),
    ).toBeInTheDocument()
  })

  it('a sent step of a dialog still open is no answer yet', async () => {
    mockAnswer.mockResolvedValue(undefined)
    setup([card('a', 1), card('b', 2)])
    await screen.findByText('Run the tests of a?')
    await act(async () => fireEvent.click(yes()))
    expect(mockAnswer).toHaveBeenCalled()
    // The dialog is still there: no "Answered", the card stays
    await act(async () => {})
    expect(screen.queryByText('Answered.')).toBeNull()
    expect(screen.getByText('Run the tests of a?')).toBeInTheDocument()
  })

  it('view-only: the dialog without buttons, and why', async () => {
    mockFetchPrompt.mockImplementation(async () => ({
      ...dialog('a'),
      promptId: undefined,
    }))
    setup([card('a', 1)], { readOnly: true })
    await screen.findByText('Run the tests of a?')
    expect(screen.queryByRole('button', { name: /Yes/ })).toBeNull()
    expect(
      screen.getByText('View only: answer from a device with full access'),
    ).toBeInTheDocument()
  })

  it('an agent the server cannot answer: only the way to its terminal', () => {
    const { onOpen } = setup([card('a', 1, 'blocked', 'aider')], {
      canAnswer: false,
    })
    fireEvent.click(screen.getByRole('button', { name: 'Open terminal' }))
    expect(onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ id: 't-a' }),
      expect.objectContaining({ id: 'a' }),
      'terminal',
    )
    expect(mockFetchPrompt).not.toHaveBeenCalled()
  })

  it('no dialog read: the terminal is the way; reading meanwhile', async () => {
    let finish = (_p: AgentPrompt | null) => {}
    mockFetchPrompt.mockReturnValue(
      new Promise((ok) => {
        finish = ok
      }),
    )
    setup([card('a', 1)])
    expect(screen.getByRole('status')).toHaveTextContent('Reading the dialog…')
    await act(async () => finish(null))
    expect(
      await screen.findByText(/waiting for you in the terminal/),
    ).toBeInTheDocument()
  })

  it('the card opens its own chat, not the pane on screen', async () => {
    const { onOpen } = setup([card('a', 1)])
    await screen.findByText('Run the tests of a?')
    fireEvent.click(screen.getByRole('button', { name: 'Open terminal' }))
    expect(onOpen).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 't-a' }),
      expect.objectContaining({ id: 'a' }),
      'terminal',
    )
  })

  it('Zellij busy keeps the card to try again', async () => {
    mockAnswer.mockRejectedValueOnce(new AgentRequestError(503, 'busy', 'x'))
    setup([card('a', 1)])
    await screen.findByText('Run the tests of a?')
    await act(async () => fireEvent.click(yes()))
    expect(screen.getByText('Zellij is busy; try again.')).toBeInTheDocument()
    await waitFor(() => expect(yes()).toBeEnabled())
    expect(screen.queryByText('Answered.')).toBeNull()
    mockAnswer.mockImplementation(async (id: string) => {
      closed.add(id)
    })
    await act(async () => fireEvent.click(yes()))
    await answered()
  })

  it('an answered pane still blocked after the grace shows its new dialog', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const { update } = setup([card('a', 1)])
      await screen.findByText('Run the tests of a?')
      await act(async () => fireEvent.click(yes()))
      await answered()
      await next('Done')
      // A second dialog asked within the same snapshot poll
      closed.delete('a')
      update([card('a', 1)])
      expect(screen.queryByRole('heading', { name: /^Needs you/ })).toBeNull()
      await act(async () => {
        vi.advanceTimersByTime(ANSWER_GRACE)
      })
      expect(
        await screen.findByRole('heading', {
          name: /^Needs you: Claude Code, w \/ a/,
        }),
      ).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })
})
