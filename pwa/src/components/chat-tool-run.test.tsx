import { fireEvent, render, screen } from '@testing-library/react'
import { useRef, useState } from 'react'
import { describe, expect, it } from 'vitest'
import type { TranscriptEntry, TranscriptPart } from '../hooks/use-mux-api'
import {
  chatItems,
  hasPending,
  type RunMode,
  runSummary,
  stepLine,
  toolRunRows,
} from './chat-tool-run'

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
    expect(runSummary(parts)).toBe(
      '2 commands, 1 edit, 1 read, 2 searches, 1 other step',
    )
  })

  it('says a step by its description, its command or its tool', () => {
    expect(
      stepLine({
        kind: 'tool',
        tool: 'Bash',
        detail: { description: 'Run tests', command: 'x' },
      }),
    ).toBe('Run tests')
    expect(
      stepLine({ kind: 'tool', tool: 'Bash', detail: { command: 'a\nb' } }),
    ).toBe('$ a')
    expect(stepLine({ kind: 'tool', tool: 'Read', input: 'x.ts' })).toBe(
      'Read x.ts',
    )
    expect(stepLine({ kind: 'tool', orphan: true, tool: 'result' })).toBe(
      'Result',
    )
  })

  it('a call without its result is pending', () => {
    expect(hasPending([bash('1', 'a')])).toBe(false)
    expect(hasPending([bash('1', 'a', { result: undefined })])).toBe(true)
  })
})

// The list's part: keeps what the reader chose and the runs seen live
function Run({
  entries,
  live,
  follow = true,
}: {
  entries: TranscriptEntry[]
  live: boolean
  follow?: boolean
}) {
  const [modes, setModes] = useState<Record<string, RunMode>>({})
  const held = useRef(new Set<string>()).current
  const tails = useRef(new Map<string, string>()).current
  return (
    <>
      {toolRunRows(entries, layoutOf(entries.length), live, {
        modes,
        held,
        tails,
        follow,
        setMode: (ids, mode) =>
          setModes((m) => ({
            ...m,
            ...Object.fromEntries(ids.map((id) => [id, mode])),
          })),
      })}
    </>
  )
}

describe('toolRunRows', () => {
  const run = [
    bash('1', 'ls'),
    bash('2', 'false', { isError: true, result: 'no' }),
    tool('3', { tool: 'Read', input: 'x.ts' }),
  ]

  it('folded: says what ran, what failed and the newest step; opens and closes', () => {
    const { container } = render(<Run entries={run} live={false} />)
    expect(screen.getByText('2 commands, 1 read')).toBeInTheDocument()
    expect(screen.getByText('1 failed')).toBeInTheDocument()
    expect(screen.getByText('Read x.ts')).toBeInTheDocument()
    expect(container.querySelector('span.rounded-full')).toHaveClass(
      'bg-danger',
    )
    expect(screen.queryByText('ls')).toBeNull()
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    expect(screen.getByText('ls')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /2 commands/ }))
    expect(screen.queryByText('ls')).toBeNull()
  })

  it('live: open on its newest steps, and stays open once done', () => {
    const long = Array.from({ length: 8 }, (_, i) => bash(`${i}`, `cmd${i}`))
    const { rerender } = render(<Run entries={long} live />)
    expect(screen.queryByText('cmd1')).toBeNull()
    expect(screen.getByText('cmd2')).toBeInTheDocument()
    expect(screen.getByText('2 earlier steps · 8 commands')).toBeInTheDocument()
    rerender(<Run entries={long} live={false} />)
    expect(screen.getByText('cmd7')).toBeInTheDocument()
    fireEvent.click(screen.getByText('2 earlier steps · 8 commands'))
    expect(screen.getByText('cmd0')).toBeInTheDocument()
    // Closed by the reader, it stays folded
    fireEvent.click(screen.getByRole('button', { name: '8 commands' }))
    expect(screen.queryByText('cmd7')).toBeNull()
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
    expect(screen.getByText('cmd2')).toBeInTheDocument()
    rerender(<Run entries={steps(10)} live follow={false} />)
    // The lines being read stay; the new steps come in below them
    expect(screen.getByText('cmd2')).toBeInTheDocument()
    expect(screen.getByText('cmd9')).toBeInTheDocument()
    expect(
      screen.getByText('2 earlier steps · 10 commands'),
    ).toBeInTheDocument()
    // Back at the bottom, it follows the newest again
    rerender(<Run entries={steps(10)} live />)
    expect(screen.queryByText('cmd3')).toBeNull()
  })

  it('cut down to thinking only, the entries show as they are', () => {
    const think: TranscriptEntry = {
      id: 'th',
      role: 'assistant',
      parts: [{ kind: 'thinking', text: 'hm' }],
    }
    render(<Run entries={[think]} live={false} />)
    expect(screen.getByText('Thinking')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { expanded: false, name: /commands/ }),
    ).toBeNull()
  })

  it('a live run short enough shows all of it and can be folded', () => {
    render(<Run entries={run} live />)
    expect(screen.getByText('ls')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '2 commands, 1 read' }))
    expect(screen.queryByText('ls')).toBeNull()
  })
})
