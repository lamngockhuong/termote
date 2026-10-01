import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { type AgentPrompt, AgentRequestError } from '../hooks/use-mux-api'
import { PromptCard, WaitingCard } from './prompt-card'

const mockAnswer = vi.fn()
vi.mock('../hooks/use-mux-api', async (orig) => ({
  ...(await orig<typeof import('../hooks/use-mux-api')>()),
  answerAgentPrompt: (...a: unknown[]) => mockAnswer(...a),
}))
const mockHaptic = vi.fn()
vi.mock('../hooks/use-haptic', () => ({
  useHaptic: () => ({ trigger: mockHaptic, isSupported: true }),
}))

const permission: AgentPrompt = {
  promptId: 'id1',
  kind: 'permission',
  title: 'Bash command',
  body: 'touch a.txt\nDo you want to proceed?',
  options: [
    { index: 1, label: 'Yes' },
    {
      index: 2,
      label: 'Yes, and always allow',
      detail: 'access to /tmp from this project',
    },
    { index: 3, label: 'No' },
  ],
}

const showView = vi.fn()
const onAnswered = vi.fn()
const onChanged = vi.fn()

function renderCard(prompt: AgentPrompt, readOnly = false) {
  return render(
    <PromptCard
      paneId="%3"
      prompt={prompt}
      readOnly={readOnly}
      showView={showView}
      onAnswered={onAnswered}
      onChanged={onChanged}
    />,
  )
}

const click = async (name: string | RegExp) => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }))
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockAnswer.mockResolvedValue(undefined)
})

describe('PromptCard', () => {
  it('shows the dialog with a button per option, labelled for screen readers', () => {
    renderCard(permission)
    const card = screen.getByRole('alertdialog', { name: 'Bash command' })
    expect(card).toHaveAccessibleDescription(
      /touch a\.txt\s+Do you want to proceed\?/,
    )
    expect(
      screen.getByRole('button', { name: /1\.\s*Yes$/ }),
    ).toBeInTheDocument()
    expect(
      screen.getByText('access to /tmp from this project'),
    ).toBeInTheDocument()
    // A refusing option is marked as such
    expect(screen.getByRole('button', { name: /3\.\s*No/ })).toHaveClass(
      'text-danger',
    )
    expect(screen.getByRole('button', { name: /1\.\s*Yes$/ })).not.toHaveClass(
      'text-danger',
    )
  })

  it('answers an option, then asks for a fresh poll with a light buzz', async () => {
    renderCard(permission)
    await click(/2\.\s*Yes, and always/)
    expect(mockAnswer).toHaveBeenCalledWith('%3', 'id1', 2)
    expect(mockHaptic).toHaveBeenCalledWith('light')
    expect(onAnswered).toHaveBeenCalled()
  })

  it('Cancel sends Esc', async () => {
    renderCard(permission)
    await click('Cancel (Esc)')
    expect(mockAnswer).toHaveBeenCalledWith('%3', 'id1', 'cancel')
  })

  it('locks the buttons while answering', async () => {
    let resolve!: () => void
    mockAnswer.mockImplementation(
      () =>
        new Promise<void>((r) => {
          resolve = r
        }),
    )
    renderCard(permission)
    await click(/1\.\s*Yes$/)
    expect(screen.getByRole('button', { name: /3\.\s*No/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel (Esc)' })).toBeDisabled()
    await act(async () => resolve())
    expect(screen.getByRole('button', { name: /3\.\s*No/ })).not.toBeDisabled()
  })

  it('a changed screen replaces the card and says why', async () => {
    const next = { ...permission, promptId: 'id2', body: 'rm -rf build' }
    mockAnswer.mockRejectedValue(
      new AgentRequestError(409, 'prompt_changed', 'x', undefined, next),
    )
    renderCard(permission)
    await click(/1\.\s*Yes$/)
    expect(onChanged).toHaveBeenCalledWith(next)
    expect(
      screen.getByText('The screen changed; check the dialog again.'),
    ).toBeInTheDocument()
    expect(onAnswered).not.toHaveBeenCalled()
  })

  it('a changed screen with no dialog left clears the card', async () => {
    mockAnswer.mockRejectedValue(
      new AgentRequestError(409, 'prompt_changed', 'x'),
    )
    renderCard(permission)
    await click(/1\.\s*Yes$/)
    expect(onChanged).toHaveBeenCalledWith(null)
  })

  it('an id already used (another device answered) polls again', async () => {
    mockAnswer.mockRejectedValue(
      new AgentRequestError(409, 'prompt_expired', 'x'),
    )
    renderCard(permission)
    await click(/1\.\s*Yes$/)
    expect(
      screen.getByText('This dialog was already answered.'),
    ).toBeInTheDocument()
    expect(onAnswered).toHaveBeenCalled()
  })

  it.each([
    [
      new AgentRequestError(
        502,
        'answer_not_confirmed',
        'the key was sent but the dialog is still open',
      ),
      'The answer was sent but the dialog is still open; check it in the terminal.',
    ],
    [
      new TypeError('Failed to fetch'),
      'Could not confirm the answer; check the dialog.',
    ],
  ])('other failures say so (%s)', async (err, shown) => {
    mockAnswer.mockRejectedValue(err)
    renderCard(permission)
    await click(/1\.\s*Yes$/)
    expect(screen.getByText(shown)).toBeInTheDocument()
  })

  it('every card has the way to the terminal', () => {
    renderCard(permission)
    fireEvent.click(screen.getByRole('button', { name: 'Open terminal' }))
    expect(showView).toHaveBeenCalledWith('terminal')
  })

  it('an unsupported dialog shows its content and only the terminal', () => {
    renderCard({
      kind: 'unsupported',
      title: '←  ☐ Size  ☐ Drink  ✔ Submit  →',
      body: 'What size?',
    })
    expect(screen.getByText('What size?')).toBeInTheDocument()
    expect(
      screen.getByText('Answer this dialog in the terminal.'),
    ).toBeInTheDocument()
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Open terminal',
    ])
  })

  it('after its own answer, the same dialog without an id says the answer was sent', async () => {
    const { rerender } = renderCard(permission)
    await click(/1\.\s*Yes$/)
    rerender(
      <PromptCard
        paneId="%3"
        prompt={{ ...permission, promptId: undefined }}
        showView={showView}
        onAnswered={onAnswered}
        onChanged={onChanged}
      />,
    )
    expect(screen.getByText('Answer sent…')).toBeInTheDocument()
  })

  it('failures read the dialog again', async () => {
    mockAnswer.mockRejectedValue(new TypeError('Failed to fetch'))
    renderCard(permission)
    await click(/1\.\s*Yes$/)
    expect(onAnswered).toHaveBeenCalled()
  })

  it('option buttons grow with their content (no fixed 44px height)', () => {
    renderCard(permission)
    const b = screen.getByRole('button', { name: /2\.\s*Yes, and always/ })
    expect(b).toHaveClass('pointer-coarse:min-h-touch')
    expect(b.className).not.toMatch(/(^|\s)(pointer-coarse:)?h-(9|touch)(\s|$)/)
  })

  it('a dialog whose id was just used waits without buttons', () => {
    renderCard({ ...permission, promptId: undefined })
    // Not this card's answer: just waiting
    expect(screen.getByText('Waiting for Claude Code…')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Yes/ })).toBeNull()
  })

  it('view-only shows the dialog, with no button at all', () => {
    renderCard(permission, true)
    expect(
      screen.getByRole('region', { name: 'Bash command' }),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByText('Answer sent…')).toBeNull()
  })

  it('a dialog without a title or body still reads', () => {
    renderCard({ kind: 'unsupported', title: '' }, true)
    expect(
      screen.getByRole('region', { name: 'Claude Code is asking' }),
    ).not.toHaveAttribute('aria-describedby')
  })
})

describe('WaitingCard', () => {
  it('points to the terminal', () => {
    render(<WaitingCard showView={showView} />)
    expect(
      screen.getByText('Claude Code is waiting for you in the terminal.'),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open terminal' }))
    expect(showView).toHaveBeenCalledWith('terminal')
  })
})
