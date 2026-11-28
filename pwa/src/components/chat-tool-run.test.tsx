import { act, fireEvent, render, screen } from '@testing-library/react'
import { useRef, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TranscriptEntry, TranscriptPart } from '../hooks/use-mux-api'
import { tFor } from '../i18n/i18n-context'
import { stepLine } from './chat-tool-card'
import {
  chatItems,
  hasPending,
  keepRun,
  keepRunAt,
  type RunAt,
  type RunMode,
  type RunState,
  runSeconds,
  runSummary,
  toolRunRows,
} from './chat-tool-run'

const en = tFor('en')

const tool = (id: string, part: Partial<TranscriptPart>): TranscriptEntry => ({
  id,
  role: 'assistant',
  parts: [{ kind: 'tool', toolId: id, result: 'ok', ...part }],
})
const bash = (id: string, command: string, more?: Partial<TranscriptPart>) =>
  tool(id, { tool: 'Bash', detail: { command }, ...more })
const text = (id: string, t: string): TranscriptEntry => ({
  id,
  role: 'assistant',
  parts: [{ kind: 'text', text: t }],
})
const user = (id: string): TranscriptEntry => ({
  id,
  role: 'user',
  parts: [{ kind: 'text', text: 'hi' }],
})
const layoutOf = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    showTime: false,
    joinsNext: i < n - 1,
  }))

describe('chatItems', () => {
  it('folds three steps or more in a row; fewer stay single', () => {
    const entries = [
      user('u'),
      bash('1', 'a'),
      bash('2', 'b'),
      text('t', 'so'),
      bash('3', 'c'),
      { ...bash('4', 'd'), parts: [{ kind: 'thinking', text: 'hm' }] },
      tool('5', { tool: 'Read', input: 'x.ts' }),
      text('end', 'done'),
    ] as TranscriptEntry[]
    expect(chatItems(entries)).toEqual([
      { kind: 'entry', index: 0 },
      { kind: 'entry', index: 1 },
      { kind: 'entry', index: 2 },
      { kind: 'entry', index: 3 },
      { kind: 'run', start: 4, end: 7 },
      { kind: 'entry', index: 7 },
    ])
  })

  it('never folds thinking alone, nor an entry with text in it', () => {
    const think = (id: string): TranscriptEntry => ({
      id,
      role: 'assistant',
      parts: [{ kind: 'thinking', text: 'hm' }],
    })
    expect(chatItems([think('a'), think('b'), think('c')])).toHaveLength(3)
    const mixed: TranscriptEntry = {
      id: 'm',
      role: 'assistant',
      parts: [
        { kind: 'text', text: 'x' },
        { kind: 'tool', tool: 'Bash' },
        { kind: 'tool', tool: 'Bash' },
      ],
    }
    expect(chatItems([mixed])).toEqual([{ kind: 'entry', index: 0 }])
  })

  it('a run of many steps in one entry folds, at the end of the list too', () => {
    const many: TranscriptEntry = {
      id: 'm',
      role: 'assistant',
      parts: [
        { kind: 'tool', tool: 'Bash' },
        { kind: 'tool', tool: 'Grep' },
        { kind: 'tool', tool: 'Edit' },
      ],
    }
    expect(chatItems([many])).toEqual([{ kind: 'run', start: 0, end: 1 }])
  })
})

describe('runSummary and stepLine', () => {
  it('counts each kind of step', () => {
    const parts: TranscriptPart[] = [
      { kind: 'tool', tool: 'Bash' },
      { kind: 'tool', tool: 'Bash' },
      { kind: 'tool', tool: 'Edit' },
      { kind: 'tool', tool: 'Read' },
      { kind: 'tool', tool: 'Grep' },
      { kind: 'tool', tool: 'WebFetch' },
      { kind: 'tool', tool: 'TodoWrite' },
    ]
    expect(runSummary(parts, en)).toBe(
      '2 commands, 1 edit, 1 read, 2 searches, 1 other step',
    )
  })

  it('a call with no tool name counts as another step', () => {
    expect(runSummary([{ kind: 'tool' }], en)).toBe('1 other step')
  })

  it('says a step by its description, its command or its tool', () => {
    expect(
      stepLine(
        {
          kind: 'tool',
          tool: 'Bash',
          detail: { description: 'Run tests', command: 'x' },
        },
        en,
      ),
    ).toBe('Run tests')
    expect(
      stepLine({ kind: 'tool', tool: 'Bash', detail: { command: 'a\nb' } }, en),
    ).toBe('Ran a')
    expect(stepLine({ kind: 'tool', tool: 'Read', input: 'x.ts' }, en)).toBe(
      'Read x.ts',
    )
    expect(stepLine({ kind: 'tool', orphan: true, tool: 'result' }, en)).toBe(
      'Result',
    )
  })

  it('times a run from its first entry to the one after it', () => {
    expect(runSeconds('2026-01-01T00:00:00Z', '2026-01-01T00:01:14.4Z')).toBe(
      74,
    )
    expect(runSeconds(undefined, '2026-01-01T00:00:00Z')).toBeUndefined()
    expect(runSeconds('2026-01-01T00:00:00Z', undefined)).toBeUndefined()
    expect(runSeconds('nope', '2026-01-01T00:00:00Z')).toBeUndefined()
    expect(
      runSeconds('2026-01-01T00:00:10Z', '2026-01-01T00:00:00Z'),
    ).toBeUndefined()
  })

  it("keeps a run once, never over the reader's choice", () => {
    const none = {}
    expect(keepRun(none, 'a')).toEqual({ a: 'kept' })
    const chosen: Record<string, RunMode> = { a: 'closed' }
    expect(keepRun(chosen, 'a')).toBe(chosen)
  })

  it('a call without its result is pending', () => {
    expect(hasPending([bash('1', 'a')])).toBe(false)
    expect(hasPending([bash('1', 'a', { result: undefined })])).toBe(true)
  })
})

// The list's part: keeps what the reader chose and the runs seen live, and
// keeps a run pressed inside open, as the Chat view does
function Run({
  entries,
  live,
  follow = true,
  at,
  clockOffset,
}: {
  entries: TranscriptEntry[]
  live: boolean
  follow?: boolean
  at?: RunAt
  clockOffset?: number
}) {
  const [modes, setModes] = useState<Record<string, RunMode>>({})
  const held = useRef(new Set<string>()).current
  const tails = useRef(new Map<string, string>()).current
  const runs: RunState = {
    modes,
    held,
    tails,
    follow,
    clockOffset,
    setMode: (ids, mode) =>
      setModes((m) => ({
        ...m,
        ...Object.fromEntries(ids.map((id) => [id, mode])),
      })),
    keep: (id) => setModes((m) => keepRun(m, id)),
  }
  return (
    <div
      data-testid="list"
      onFocusCapture={(e) => keepRunAt(e, runs)}
      onClickCapture={(e) => keepRunAt(e, runs)}
    >
      {toolRunRows(entries, layoutOf(entries.length), live, runs, en, {
        settled: true,
        ...at,
      })}
    </div>
  )
}

const header = () =>
  screen.getByRole('button', { name: /^(Working|Worked|Needs you)/ })

describe('toolRunRows', () => {
  afterEach(() => vi.useRealTimers())

  const run = [
    bash('1', 'ls'),
    bash('2', 'false', { isError: true, result: 'no' }),
    tool('3', { tool: 'Read', input: 'x.ts' }),
  ]

  it('folded: says what ran and what failed; opens on a line per step', () => {
    const { container } = render(<Run entries={run} live={false} />)
    expect(header()).toHaveAccessibleName(
      'Worked · 2 commands, 1 read · 1 failed',
    )
    expect(header()).toHaveAttribute('aria-expanded', 'false')
    // The count of failures is never cut with the summary
    expect(screen.getByText('· 1 failed')).toHaveClass(
      'shrink-0',
      'text-danger',
    )
    expect(screen.getByText('· 2 commands, 1 read')).toHaveClass('truncate')
    expect(container.querySelector('span.rounded-full')).toHaveClass(
      'bg-danger',
    )
    expect(screen.queryByText('Ran ls')).toBeNull()
    fireEvent.click(header())
    expect(header()).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Ran ls')).toBeInTheDocument()
    expect(screen.getByText('Read x.ts')).toBeInTheDocument()
    // A failed step says so after its line
    const failedRow = screen.getByRole('button', { name: 'Ran false failed' })
    expect(failedRow.lastChild).toHaveClass('shrink-0', 'text-danger')
    // A line opens the step's card and closes it again
    expect(screen.queryByText('ls')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Ran ls' }))
    expect(screen.getByText('ls')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Ran ls' }))
    expect(screen.queryByText('ls')).toBeNull()
    fireEvent.click(header())
    expect(screen.queryByText('Ran ls')).toBeNull()
  })

  it('open, one place on the timeline: its lines flush, with no dot of their own', () => {
    const think: TranscriptEntry = {
      id: 'th',
      role: 'assistant',
      parts: [{ kind: 'thinking', text: 'mulling it over' }],
    }
    const { container } = render(<Run entries={[think, ...run]} live={false} />)
    fireEvent.click(header())
    // The header's dot only, centred on its 28px line
    const dots = container.querySelectorAll('span.rounded-full')
    expect(dots).toHaveLength(1)
    expect(dots[0]).toHaveClass('top-[10.5px]')
    expect(container.querySelector('[data-run]')).toHaveClass('mb-0')
    const lines = [...container.querySelectorAll('[data-run-entry]')]
    expect(lines.map((l) => l.classList.contains('mb-0'))).toEqual([
      true,
      true,
      true,
      false,
    ])
    expect(lines[0]).not.toHaveClass('gap-3')
    expect(screen.getByRole('button', { name: 'Ran ls' })).toHaveClass('h-7')
    // Thinking is a line too, its text under it
    const thinking = screen.getByRole('button', { name: 'Thinking' })
    expect(thinking).toHaveClass('h-7')
    expect(screen.queryByText('mulling it over')).toBeNull()
    fireEvent.click(thinking)
    expect(screen.getByText('mulling it over')).toBeInTheDocument()
    fireEvent.click(thinking)
    expect(screen.queryByText('mulling it over')).toBeNull()
    // Folded, its header keeps its margin to what follows
    fireEvent.click(header())
    expect(container.querySelector('[data-run]')).not.toHaveClass('mb-0')
  })

  it('done, it says how long it worked', () => {
    render(
      <Run
        entries={run}
        live={false}
        at={{ start: '2026-01-01T00:00:00Z', end: '2026-01-01T00:01:14Z' }}
      />,
    )
    expect(header()).toHaveAccessibleName(
      'Worked for 1m 14s · 2 commands, 1 read · 1 failed',
    )
  })

  it('the time comes from the first entry when the list gives none', () => {
    const timed = run.map((e, i) => ({
      ...e,
      ts: `2026-01-01T00:00:0${i}Z`,
    }))
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:15Z'))
    render(<Run entries={timed} live />)
    expect(header()).toHaveAccessibleName(
      'Working… · 15s · 2 commands, 1 read · 1 failed',
    )
  })

  it('live: says it works, counting the seconds on the server clock', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:10Z'))
    render(
      <Run
        entries={run}
        live
        clockOffset={5000}
        at={{ start: '2026-01-01T00:00:00Z', settled: false }}
      />,
    )
    expect(header()).toHaveAccessibleName(
      'Working… · 15s · 2 commands, 1 read · 1 failed',
    )
    expect(screen.getByText('· 15s')).toHaveClass('shrink-0')
    act(() => vi.advanceTimersByTime(2000))
    expect(header()).toHaveAccessibleName(
      'Working… · 17s · 2 commands, 1 read · 1 failed',
    )
  })

  it('waiting on the reader: says it needs them, the time stopped', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:10Z'))
    const at = { start: '2026-01-01T00:00:00Z', settled: false }
    const { rerender } = render(
      <Run entries={run} live at={{ ...at, waiting: true }} />,
    )
    expect(header()).toHaveAccessibleName(
      'Needs you · 2 commands, 1 read · 1 failed',
    )
    expect(screen.queryByText(/· \d+s/)).toBeNull()
    act(() => vi.advanceTimersByTime(3000))
    expect(header()).toHaveAccessibleName(
      'Needs you · 2 commands, 1 read · 1 failed',
    )
    // Answered, it works again, counting from the run's start
    rerender(<Run entries={run} live at={at} />)
    expect(header()).toHaveAccessibleName(
      'Working… · 13s · 2 commands, 1 read · 1 failed',
    )
  })

  it('a run no longer live never says it needs the reader', () => {
    render(<Run entries={run} live={false} at={{ waiting: true }} />)
    expect(header()).toHaveAccessibleName(
      'Worked · 2 commands, 1 read · 1 failed',
    )
  })

  it('live without a time: says it works, no count', () => {
    render(<Run entries={run} live />)
    expect(header()).toHaveAccessibleName(
      'Working… · 2 commands, 1 read · 1 failed',
    )
  })

  it('live: open on its newest steps, folded once done at the bottom', () => {
    const long = Array.from({ length: 8 }, (_, i) => bash(`${i}`, `cmd${i}`))
    const { rerender } = render(<Run entries={long} live />)
    expect(screen.queryByText('Ran cmd1')).toBeNull()
    expect(screen.getByText('Ran cmd2')).toBeInTheDocument()
    expect(header()).toHaveAccessibleName(
      'Working… · 2 earlier steps · 8 commands',
    )
    rerender(<Run entries={long} live={false} />)
    expect(screen.queryByText('Ran cmd7')).toBeNull()
    expect(header()).toHaveAccessibleName('Worked · 8 commands')
    // Folded, it stays so when the reader scrolls up
    rerender(<Run entries={long} live={false} follow={false} />)
    expect(screen.queryByText('Ran cmd7')).toBeNull()
  })

  it('done while read above: open until the reader is back at the bottom', () => {
    const { rerender } = render(<Run entries={run} live />)
    expect(screen.getByText('Ran ls')).toBeInTheDocument()
    rerender(<Run entries={run} live={false} follow={false} />)
    expect(screen.getByText('Ran ls')).toBeInTheDocument()
    rerender(<Run entries={run} live={false} follow />)
    expect(screen.queryByText('Ran ls')).toBeNull()
  })

  it('a run behind the newest waits until the agent says the turn is done', () => {
    const { rerender } = render(<Run entries={run} live />)
    rerender(<Run entries={run} live={false} at={{ settled: false }} />)
    expect(screen.getByText('Ran ls')).toBeInTheDocument()
    rerender(<Run entries={run} live={false} at={{ settled: true }} />)
    expect(screen.queryByText('Ran ls')).toBeNull()
  })

  it('folded, the part of a run the window cut stays folded once shown', () => {
    const { rerender } = render(<Run entries={run.slice(1)} live />)
    // The run's first entry was held when shown before
    rerender(<Run entries={run} live />)
    rerender(
      <Run
        entries={run.slice(1)}
        live={false}
        at={{ key: '1', ids: ['1', '2', '3'] }}
      />,
    )
    expect(screen.queryByText('Ran false')).toBeNull()
    rerender(<Run entries={run} live={false} follow={false} />)
    expect(screen.queryByText('Ran ls')).toBeNull()
  })

  it('a run clicked or focused inside stays open once done', () => {
    const { rerender, unmount } = render(<Run entries={run} live />)
    fireEvent.click(screen.getByText('Ran ls'))
    rerender(<Run entries={run} live={false} />)
    expect(screen.getByText('Ran ls')).toBeInTheDocument()
    // The header's own toggle still folds it
    fireEvent.click(header())
    expect(screen.queryByText('Ran ls')).toBeNull()
    unmount()

    const second = render(<Run entries={run} live />)
    fireEvent.focus(screen.getByRole('button', { name: 'Ran ls' }))
    second.rerender(<Run entries={run} live={false} />)
    expect(screen.getByText('Ran ls')).toBeInTheDocument()
  })

  it('a finger scrolling, or a press on the header or outside a run, keeps nothing', () => {
    const { rerender } = render(<Run entries={run} live />)
    // A scroll by touch starts with a pointer down, and no click follows
    fireEvent.pointerDown(screen.getByText('Ran ls'))
    fireEvent.pointerCancel(screen.getByText('Ran ls'))
    fireEvent.pointerDown(header())
    fireEvent.click(screen.getByTestId('list'))
    rerender(<Run entries={run} live={false} />)
    expect(screen.queryByText('Ran ls')).toBeNull()
  })

  it('a press inside a run opened by the reader changes nothing', () => {
    render(<Run entries={run} live={false} />)
    fireEvent.click(header())
    fireEvent.click(screen.getByText('Ran ls'))
    expect(screen.getByText('Ran ls')).toBeInTheDocument()
  })

  it('the dot is hollow while a call waits, green once all are done', () => {
    const { container, rerender } = render(
      <Run
        entries={[
          bash('1', 'a'),
          bash('2', 'b'),
          bash('3', 'c', { result: undefined }),
        ]}
        live={false}
      />,
    )
    expect(container.querySelector('span.rounded-full')).toHaveClass(
      'bg-transparent',
    )
    rerender(
      <Run
        entries={[bash('1', 'a'), bash('2', 'b'), bash('3', 'c')]}
        live={false}
      />,
    )
    expect(container.querySelector('span.rounded-full')).toHaveClass(
      'bg-success',
    )
  })

  it('read above the bottom, a live tail stays where it was', () => {
    const steps = (n: number) =>
      Array.from({ length: n }, (_, i) => bash(`${i}`, `cmd${i}`))
    const { rerender } = render(<Run entries={steps(8)} live />)
    expect(screen.getByText('Ran cmd2')).toBeInTheDocument()
    rerender(<Run entries={steps(10)} live follow={false} />)
    // The lines being read stay; the new steps come in below them
    expect(screen.getByText('Ran cmd2')).toBeInTheDocument()
    expect(screen.getByText('Ran cmd9')).toBeInTheDocument()
    expect(
      screen.getByText('· 2 earlier steps · 10 commands'),
    ).toBeInTheDocument()
    // Back at the bottom, it follows the newest again
    rerender(<Run entries={steps(10)} live />)
    expect(screen.queryByText('Ran cmd3')).toBeNull()
  })

  it('a tail opens whole on a tap, then folds on the next', () => {
    const long = Array.from({ length: 8 }, (_, i) => bash(`${i}`, `cmd${i}`))
    render(<Run entries={long} live />)
    expect(header()).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(header())
    expect(screen.getByText('Ran cmd0')).toBeInTheDocument()
    expect(header()).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(header())
    expect(screen.queryByText('Ran cmd7')).toBeNull()
  })

  it('cut down to thinking only, the entries show as they are', () => {
    const think: TranscriptEntry = {
      id: 'th',
      role: 'assistant',
      parts: [{ kind: 'thinking', text: 'hm' }],
    }
    render(<Run entries={[think]} live={false} />)
    expect(screen.getByText('Thinking')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /commands/ })).toBeNull()
  })

  it('the tail names one earlier step, or earlier thinking without a count', () => {
    const think = (id: string): TranscriptEntry => ({
      id,
      role: 'assistant',
      parts: [{ kind: 'thinking', text: 'hm' }],
    })
    const seven = Array.from({ length: 7 }, (_, i) => bash(`${i}`, `cmd${i}`))
    const { unmount } = render(<Run entries={seven} live />)
    expect(
      screen.getByText('· 1 earlier step · 7 commands'),
    ).toBeInTheDocument()
    unmount()
    const six = Array.from({ length: 6 }, (_, i) => bash(`${i}`, `cmd${i}`))
    render(<Run entries={[think('t'), ...six]} live />)
    expect(screen.getByText('· Earlier steps · 6 commands')).toBeInTheDocument()
  })

  it('a step said by its description is in prose, a command in mono', () => {
    const steps = [
      bash('1', 'a'),
      bash('2', 'b'),
      bash('3', 'c', { detail: { command: 'c', description: 'Check it' } }),
    ]
    render(<Run entries={steps} live={false} />)
    fireEvent.click(header())
    expect(screen.getByText('Check it')).not.toHaveClass('font-mono')
    expect(screen.getByText('Ran a')).toHaveClass('font-mono')
  })

  it('a live run short enough shows all of it and can be folded', () => {
    render(<Run entries={run} live />)
    expect(screen.getByText('Ran ls')).toBeInTheDocument()
    fireEvent.click(header())
    expect(screen.queryByText('Ran ls')).toBeNull()
  })
})
