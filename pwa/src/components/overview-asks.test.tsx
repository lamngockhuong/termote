import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reloadJobs, resetJobs, useJobs } from '../hooks/use-jobs'
import { type Ask, RequestError } from '../hooks/use-mux-api'
import { OverviewAsks } from './overview-asks'

const api = vi.hoisted(() => ({
  fetchAsks: vi.fn(),
  answerAsk: vi.fn(),
}))
vi.mock('../hooks/use-mux-api', async (orig) => ({
  ...(await orig<typeof import('../hooks/use-mux-api')>()),
  fetchJobs: async () => ({
    jobs: [],
    readOnly: false,
    serverNow: '',
    canGrant: true,
    ciAvailable: false,
  }),
  fetchAsks: () => api.fetchAsks(),
  answerAsk: (id: string, a: unknown) => api.answerAsk(id, a),
}))
vi.mock('../hooks/use-agent-overview', () => ({
  followOverview: () => () => {},
}))

const NOW = Date.parse('2026-11-24T10:00:00Z')

const ask = (id: string, over: Partial<Ask> = {}): Ask => ({
  id,
  state: 'open',
  text: `question ${id}`,
  choices: ['Yes', 'No'],
  createdBy: 'pane',
  agent: { key: 'k', paneId: '%1', kind: 'claude', ref: 'web:claude' },
  created: '2026-11-24T09:55:00Z',
  updated: `${id}-1`,
  live: { status: 'running', paneId: '%1', ref: 'web:claude' },
  ...over,
})

function Harness({
  readOnly = false,
  onOpenJob,
}: {
  readOnly?: boolean
  onOpenJob?: (id: string) => void
}) {
  const s = useJobs()
  return (
    <OverviewAsks
      asks={s.asks}
      readOnly={readOnly || s.asksReadOnly}
      now={NOW}
      onOpenJob={onOpenJob}
      openableJobs={new Set(['j1'])}
    />
  )
}

async function show(
  asks: Ask[],
  opts: { readOnly?: boolean; listReadOnly?: boolean } = {},
  onOpenJob?: (id: string) => void,
) {
  api.fetchAsks.mockResolvedValue({
    asks,
    readOnly: opts.listReadOnly ?? false,
  })
  const view = render(
    <Harness readOnly={opts.readOnly} onOpenJob={onOpenJob} />,
  )
  await act(() => reloadJobs())
  return view
}

const region = () => screen.getByRole('region', { name: 'Waiting on you' })
const card = (id: string) => screen.getByRole('article', { name: id })
const refusal = (code: string) => new RequestError(409, code, code)

describe('OverviewAsks', () => {
  beforeEach(() => {
    resetJobs()
    for (const fn of Object.values(api)) fn.mockReset()
  })
  afterEach(() => resetJobs())

  it('shows the open asks only, with their id, pane, age and job', async () => {
    const onOpenJob = vi.fn()
    await show(
      [
        ask('Q1', { job: 'j1', jobTitle: 'Fix login' }),
        ask('Q2', { state: 'answered' }),
        ask('Q3', { job: 'j9', jobTitle: 'Gone job' }),
      ],
      {},
      onOpenJob,
    )
    expect(
      within(region())
        .getAllByRole('article')
        .map((a) => a.getAttribute('aria-label')),
    ).toEqual(['Q1', 'Q3'])
    const q1 = card('Q1')
    expect(within(q1).getByText('Asked from web:claude')).toBeVisible()
    expect(within(q1).getByText('5 min ago')).toBeVisible()
    fireEvent.click(within(q1).getByRole('button', { name: 'Fix login' }))
    expect(onOpenJob).toHaveBeenCalledWith('j1')
    // A job this plan does not hold is named, not offered
    expect(
      within(card('Q3')).queryByRole('button', { name: 'Gone job' }),
    ).toBeNull()
    expect(within(card('Q3')).getByText('Gone job')).toBeVisible()
  })

  it('shows what the agent wrote as plain text, its unsafe characters marked', async () => {
    const { container } = await show([
      ask('Q1', {
        text: 'Pick <img src=x onerror=alert(1)> or ‮this\nsecond line https://example.com',
        choices: ['<b>bold</b>', 'a‮b'],
      }),
    ])
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('b')).toBeNull()
    expect(container.querySelector('a')).toBeNull()
    const text = within(card('Q1')).getByText(/Pick/)
    expect(text.textContent).toBe(
      'Pick <img src=x onerror=alert(1)> or ⟨U+202E⟩this\nsecond line https://example.com',
    )
    expect(text).toHaveClass('whitespace-pre-wrap', 'break-words')
    expect(text.textContent).not.toContain('‮')
    expect(
      within(card('Q1')).getByRole('button', { name: '<b>bold</b>' }),
    ).toBeVisible()
    expect(
      within(card('Q1')).getByRole('button', { name: 'a⟨U+202E⟩b' }),
    ).toBeVisible()
  })

  it('answers with a choice, the ask leaving once sent', async () => {
    await show([ask('Q1'), ask('Q2')])
    api.answerAsk.mockResolvedValue({
      ask: ask('Q1', { state: 'answered', choice: 2 }),
      queued: false,
      recorded: true,
    })
    await act(async () => {
      fireEvent.click(within(card('Q1')).getByRole('button', { name: 'No' }))
    })
    expect(api.answerAsk).toHaveBeenCalledWith('Q1', {
      choice: 2,
      updated: 'Q1-1',
    })
    expect(screen.queryByRole('article', { name: 'Q1' })).toBeNull()
    expect(card('Q2')).toBeVisible()
    expect(within(region()).getByRole('status')).toHaveTextContent('Sent')
  })

  it('answers with text, telling a queued answer, and locks the ask meanwhile', async () => {
    await show([ask('Q1')])
    let done = (_v: unknown) => {}
    api.answerAsk.mockReturnValue(new Promise((ok) => (done = ok)))
    const box = within(card('Q1')).getByRole('textbox', {
      name: 'Your answer to Q1',
    })
    const send = within(card('Q1')).getByRole('button', {
      name: 'Send the answer to Q1',
    })
    expect(send).toBeDisabled()
    fireEvent.change(box, { target: { value: 'use the\nsecond way' } })
    fireEvent.click(send)
    expect(api.answerAsk).toHaveBeenCalledWith('Q1', {
      text: 'use the\nsecond way',
      updated: 'Q1-1',
    })
    // Sending: every control of the ask is locked
    for (const b of within(card('Q1')).getAllByRole('button'))
      expect(b).toBeDisabled()
    expect(box).toBeDisabled()
    await act(async () => {
      done({
        ask: ask('Q1', { state: 'answered' }),
        queued: true,
        recorded: true,
      })
    })
    expect(screen.queryByRole('article')).toBeNull()
    // The note stays, though no ask is left
    expect(within(region()).getByRole('status')).toHaveTextContent(
      'Sent; the orchestrator reads it when it is ready',
    )
  })

  it('tells a refusal under the ask, which stays', async () => {
    await show([ask('Q1')])
    api.answerAsk.mockRejectedValue(refusal('input_has_draft'))
    await act(async () => {
      fireEvent.click(within(card('Q1')).getByRole('button', { name: 'Yes' }))
    })
    expect(within(card('Q1')).getByRole('alert')).toHaveTextContent(
      "The terminal's input box already holds text; send or clear it there",
    )
    expect(
      within(card('Q1')).getByRole('button', { name: 'Yes' }),
    ).toBeEnabled()
    // Not a refusal: a sentence of its own
    api.answerAsk.mockRejectedValue(new Error('offline'))
    await act(async () => {
      fireEvent.click(within(card('Q1')).getByRole('button', { name: 'Yes' }))
    })
    expect(within(card('Q1')).getByRole('alert')).toHaveTextContent(
      'Could not send the answer',
    )
  })

  it('reads the asks again after one was answered elsewhere', async () => {
    await show([ask('Q1')])
    api.fetchAsks.mockResolvedValue({
      asks: [ask('Q1', { state: 'answered', answeredBy: 'agent' })],
      readOnly: false,
    })
    api.answerAsk.mockRejectedValue(refusal('ask_closed'))
    await act(async () => {
      fireEvent.click(within(card('Q1')).getByRole('button', { name: 'Yes' }))
    })
    expect(api.fetchAsks).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('region', { name: 'Waiting on you' })).toBeNull()
  })

  it('offers no answer when the orchestrator that asked is gone', async () => {
    await show([ask('Q1', { live: { status: 'gone' } })])
    expect(within(card('Q1')).queryByRole('button')).toBeNull()
    expect(within(card('Q1')).queryByRole('textbox')).toBeNull()
    expect(
      within(card('Q1')).getByText(
        'The orchestrator that asked is no longer running; answer it in its terminal',
      ),
    ).toBeVisible()
  })

  it('tells a view-only device only how many wait, and their ids', async () => {
    await show(
      [
        { id: 'Q1', state: 'open', created: '2026-11-24T09:55:00Z' },
        { id: 'Q4', state: 'open', created: '2026-11-24T09:56:00Z', job: 'j1' },
      ],
      { listReadOnly: true },
    )
    expect(
      within(region()).getByText(
        '2 questions wait on a device with full access',
      ),
    ).toBeVisible()
    expect(
      within(region())
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['Q1', 'Q4'])
    expect(within(region()).queryByRole('button')).toBeNull()
    expect(within(region()).queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('article')).toBeNull()
  })

  it('shows no content on a view-only device, whatever the list holds', async () => {
    await show([ask('Q1')], { readOnly: true })
    expect(
      within(region()).getByText(
        '1 question waits on a device with full access',
      ),
    ).toBeVisible()
    expect(screen.queryByText('question Q1')).toBeNull()
    expect(within(region()).queryByRole('button')).toBeNull()
  })

  it('shows nothing on a server without asks (404), nor with none open', async () => {
    api.fetchAsks.mockRejectedValue(new RequestError(404, '', 'not found'))
    render(<Harness />)
    await act(() => reloadJobs())
    expect(screen.queryByRole('region')).toBeNull()

    resetJobs()
    await show([ask('Q1', { state: 'answered' })])
    expect(screen.queryByRole('region', { name: 'Waiting on you' })).toBeNull()
  })
})
