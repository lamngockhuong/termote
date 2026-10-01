import { act, fireEvent, render, screen, within } from '@testing-library/react'
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

describe('PromptCard with several questions', () => {
  const tab: AgentPrompt = {
    promptId: 'id2',
    kind: 'select',
    title: 'Which drink do you prefer?',
    options: [
      { index: 1, label: 'Tea' },
      { index: 2, label: 'Coffee' },
      { index: 4, label: 'Chat about this' },
    ],
    steps: [
      { label: 'Size', answered: true },
      { label: 'Drink', current: true },
      { label: 'Submit' },
    ],
  }

  it('shows the tabs as steps, the open one current', () => {
    renderCard(tab)
    const steps = screen.getByRole('list', { name: 'Questions' })
    const items = Array.from(steps.querySelectorAll('li'))
    expect(items.map((li) => li.textContent)).toEqual([
      '✓Size (answered)',
      'Drink',
      'Submit',
    ])
    expect(items[1]).toHaveAttribute('aria-current', 'step')
    expect(items[0]).not.toHaveAttribute('aria-current')
  })

  it('answers the open tab with its digit, Chat about this included', async () => {
    renderCard(tab)
    await click(/4\.\s*Chat about this/)
    expect(mockAnswer).toHaveBeenCalledWith('%3', 'id2', 4)
    expect(onAnswered).toHaveBeenCalled()
  })

  it('another step is a button that opens that tab; the open one is not', async () => {
    renderCard(tab)
    const steps = screen.getByRole('list', { name: 'Questions' })
    expect(within(steps).queryByRole('button', { name: 'Drink' })).toBeNull()
    await act(async () => {
      fireEvent.click(
        within(steps).getByRole('button', { name: /Size \(answered\)/ }),
      )
    })
    expect(mockAnswer).toHaveBeenCalledWith('%3', 'id2', { step: 0 })
    await act(async () => {
      fireEvent.click(within(steps).getByRole('button', { name: 'Submit' }))
    })
    expect(mockAnswer).toHaveBeenLastCalledWith('%3', 'id2', { step: 2 })
  })

  it('steps are not buttons without an answerable card', () => {
    renderCard(tab, true)
    expect(
      within(screen.getByRole('list', { name: 'Questions' })).queryAllByRole(
        'button',
      ),
    ).toHaveLength(0)
  })

  it('a multiSelect tab toggles options and moves on with Next', async () => {
    renderCard({
      promptId: 'id3',
      kind: 'multiselect',
      title: 'Which extras would you like?',
      options: [
        { index: 1, label: 'Sugar' },
        { index: 2, label: 'Milk', checked: true },
        { index: 4, label: 'Chat about this' },
      ],
      steps: [{ label: 'Extras', current: true }, { label: 'Submit' }],
    })
    expect(screen.getByRole('button', { name: /1\.\s*Sugar/ })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
    expect(screen.getByRole('button', { name: /2\.\s*Milk/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    // Chat about this is not an option to tick
    expect(
      screen.getByRole('button', { name: /4\.\s*Chat about this/ }),
    ).not.toHaveAttribute('aria-pressed')
    await click(/1\.\s*Sugar/)
    expect(mockAnswer).toHaveBeenCalledWith('%3', 'id3', 1)
    await click('Next')
    expect(mockAnswer).toHaveBeenLastCalledWith('%3', 'id3', 'next')
  })

  it('a toggle keeps the focus once sent', async () => {
    renderCard({
      promptId: 'id3',
      kind: 'multiselect',
      title: 'Which extras would you like?',
      options: [
        { index: 1, label: 'Sugar' },
        { index: 2, label: 'Milk' },
      ],
      steps: [{ label: 'Extras', current: true }, { label: 'Submit' }],
    })
    const sugar = screen.getByRole('button', { name: /1\.\s*Sugar/ })
    sugar.focus()
    await click(/1\.\s*Sugar/)
    expect(sugar).toHaveFocus()
  })

  it('a tab that did not open says so and shows the dialog on screen', async () => {
    const now = { ...tab, promptId: 'id9' }
    mockAnswer.mockRejectedValueOnce(
      new AgentRequestError(502, 'step_not_confirmed', 'x', undefined, now),
    )
    renderCard(tab)
    await act(async () => {
      fireEvent.click(
        within(screen.getByRole('list', { name: 'Questions' })).getByRole(
          'button',
          { name: 'Submit' },
        ),
      )
    })
    expect(
      screen.getByText('That tab did not open; check the dialog.'),
    ).toBeInTheDocument()
    expect(onChanged).toHaveBeenCalledWith(now)
    // No dialog left on screen clears the card
    mockAnswer.mockRejectedValueOnce(
      new AgentRequestError(502, 'step_not_confirmed', 'x'),
    )
    await act(async () => {
      fireEvent.click(
        within(screen.getByRole('list', { name: 'Questions' })).getByRole(
          'button',
          { name: 'Submit' },
        ),
      )
    })
    expect(onChanged).toHaveBeenLastCalledWith(null)
  })

  it('a single-choice tab has no Next and no pressed state', () => {
    renderCard(tab)
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull()
    expect(
      screen.getByRole('button', { name: /1\.\s*Tea/ }),
    ).not.toHaveAttribute('aria-pressed')
  })

  it('a single question has no steps', () => {
    renderCard(permission)
    expect(screen.queryByRole('list', { name: 'Questions' })).toBeNull()
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
