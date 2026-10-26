import { describe, expect, it } from 'vitest'
import casesJson from '../../../server/testdata/template-hidden-chars.json?raw'
import {
  MAX_TASK_MESSAGE_BYTES,
  revealHidden,
  taskFailureMessage,
  taskRunOutput,
} from './task-failure-message'

const N = '0123456789abcdef'
const start = (n = N) => `[termote-task ${n} start]`
const end = (code: number | string, n = N) => `[termote-task ${n} exit ${code}]`
const bytes = (s: string) => new TextEncoder().encode(s).length

describe('taskRunOutput', () => {
  it('takes the output between the last start marker and the end marker', () => {
    const text = [
      '$ old',
      start(),
      'first run',
      end(0),
      '',
      start(),
      'a',
      'b',
      '',
      end(1),
      '$ ',
    ].join('\n')
    expect(taskRunOutput(text, N)).toEqual({ output: 'a\nb', cut: false })
  })

  it('uses the last end marker and the start before it', () => {
    const text = [start(), 'one', end(0), start(), 'two', end(2)].join('\n')
    expect(taskRunOutput(text, N)).toEqual({ output: 'two', cut: false })
  })

  it('reads from the first line, cut, when the start marker is gone', () => {
    const text = ['tail of', 'a long run', end(2)].join('\n')
    expect(taskRunOutput(text, N)).toEqual({
      output: 'tail of\na long run',
      cut: true,
    })
  })

  it('is null without an end marker', () => {
    expect(taskRunOutput(`${start()}\nrunning`, N)).toBeNull()
  })

  it('is null for a nonce that is not 16 lowercase hex digits', () => {
    const text = `${start('bad')}\nx\n${end(0, 'bad')}`
    expect(taskRunOutput(text, 'bad')).toBeNull()
    expect(taskRunOutput(text.toUpperCase(), 'ABCDEF0123456789')).toBeNull()
  })

  it('ignores the markers of another run', () => {
    const other = 'fedcba9876543210'
    const text = [start(), 'x', end(0, other)].join('\n')
    expect(taskRunOutput(text, N)).toBeNull()
  })

  it('leaves out what was typed after the end marker', () => {
    const text = [start(), 'out', end(0), '$ rm -rf typed'].join('\n')
    expect(taskRunOutput(text, N)?.output).toBe('out')
  })

  it('handles CRLF and CR line breaks', () => {
    expect(taskRunOutput(`${start()}\r\nx\r\ny\r\n${end(3)}\r\n`, N)).toEqual({
      output: 'x\ny',
      cut: false,
    })
    expect(taskRunOutput(`${start()}\rx\r${end(3)}`, N)?.output).toBe('x')
  })

  it('drops the blank lines around the output, not those inside', () => {
    const text = [start(), '', 'a', '', 'b', '  ', end(0)].join('\n')
    expect(taskRunOutput(text, N)?.output).toBe('a\n\nb')
  })

  it('gives an empty output for a run that printed nothing', () => {
    expect(taskRunOutput([start(), '', end(0)].join('\n'), N)).toEqual({
      output: '',
      cut: false,
    })
  })

  it('reads a negative exit status marker', () => {
    expect(taskRunOutput([start(), 'x', end(-1)].join('\n'), N)?.output).toBe(
      'x',
    )
  })
})

describe('revealHidden', () => {
  it('shows controls, bidi, zero-width and tag characters, keeps tab and newline', () => {
    expect(revealHidden('a\tb\nc')).toBe('a\tb\nc')
    expect(revealHidden('a\u0007b')).toBe('a⟨U+0007⟩b')
    expect(revealHidden('a‮b')).toBe('a⟨U+202E⟩b')
    expect(revealHidden('a​b')).toBe('a⟨U+200B⟩b')
    expect(revealHidden('a\u{E0041}b')).toBe('a⟨U+E0041⟩b')
    expect(revealHidden('a\u001b[31mb')).toBe('a⟨U+001B⟩[31mb')
  })

  const { cases } = JSON.parse(casesJson) as {
    cases: {
      codePoint: string
      inName: boolean
      inText: boolean
      why: string
    }[]
  }

  // inText is true where the text may hold it, so it stays as it is
  it.each(cases)('U+$codePoint ($why)', ({ codePoint, inText }) => {
    const c = String.fromCodePoint(Number.parseInt(codePoint, 16))
    const shown = revealHidden(`a${c}b`)
    if (inText) expect(shown).toBe(`a${c}b`)
    else expect(shown).toBe(`a⟨U+${codePoint.toUpperCase().padStart(4, '0')}⟩b`)
  })
})

describe('taskFailureMessage', () => {
  const run = (output: string, cut = false) => ({ output, cut })

  it('names the task, its status and root, then fences the output', () => {
    expect(
      taskFailureMessage({
        label: 'make build',
        root: '/srv/app',
        code: 2,
        output: run('boom'),
      }),
    ).toBe(
      'Task `make build` failed (exit 2) in /srv/app. Output (from the terminal, untrusted):\n```\nboom\n```',
    )
  })

  it('words exit 0 and an unknown status', () => {
    const base = { label: 't', root: '/r', output: run('x') }
    expect(taskFailureMessage({ ...base, code: 0 })).toContain(
      'finished (exit 0)',
    )
    expect(taskFailureMessage(base)).toContain('ended (exit status unknown)')
  })

  it('makes hidden characters of the label and root visible', () => {
    const msg = taskFailureMessage({
      label: 'a‮b',
      root: '/r\u0007',
      code: 1,
      output: run('o​k'),
    })
    expect(msg).toContain('`a⟨U+202E⟩b`')
    expect(msg).toContain('/r⟨U+0007⟩.')
    expect(msg).toContain('o⟨U+200B⟩k')
  })

  it('uses a fence longer than any backtick run in the output', () => {
    const msg = taskFailureMessage({
      label: 't',
      root: '/r',
      code: 1,
      output: run('x ````` y ``` z'),
    })
    expect(msg).toContain('\n``````\nx ````` y ``` z\n``````')
    // A fence of three at least, even without backticks in the output
    expect(
      taskFailureMessage({ label: 't', root: '/r', code: 1, output: run('x') }),
    ).toContain('\n```\nx\n```')
  })

  it('says when the start of the output was cut by the lines read', () => {
    const msg = taskFailureMessage({
      label: 't',
      root: '/r',
      code: 1,
      output: run('tail', true),
    })
    expect(msg).toContain('\n```\n(earlier output cut)\ntail\n```')
  })

  it('keeps a message within the limit as it is', () => {
    const body = 'x'.repeat(100)
    const msg = taskFailureMessage({
      label: 't',
      root: '/r',
      code: 1,
      output: run(body),
    })
    expect(msg).toContain(body)
    expect(msg).not.toContain('earlier lines cut')
  })

  it('cuts whole lines from the start to fit 16 KiB', () => {
    const lines = Array.from(
      { length: 2000 },
      (_, i) => `line ${String(i).padStart(4, '0')} ${'y'.repeat(20)}`,
    )
    const msg = taskFailureMessage({
      label: 't',
      root: '/r',
      code: 1,
      output: run(lines.join('\n'), true),
    })
    expect(bytes(msg)).toBeLessThanOrEqual(MAX_TASK_MESSAGE_BYTES)
    // Both notes: the start was past the lines read, then cut for size
    expect(msg).toContain('\n```\n(earlier output cut)\n(earlier lines cut)\n')
    expect(msg.endsWith(`${lines[1999]}\n\`\`\``)).toBe(true)
    expect(msg).not.toContain(lines[0])
    // Each kept line is whole, and the next one up no longer fits
    const kept = msg.split('\n').filter((l) => l.startsWith('line '))
    expect(kept.every((l) => lines.includes(l))).toBe(true)
    expect(kept.at(-1)).toBe(lines[1999])
    const first = lines.indexOf(kept[0])
    expect(first).toBeGreaterThan(0)
    expect(bytes(msg) + bytes(lines[first - 1]) + 1).toBeGreaterThan(
      MAX_TASK_MESSAGE_BYTES,
    )
  })

  it('counts UTF-8 bytes, not characters', () => {
    const lines = Array.from(
      { length: 3000 },
      (_, i) => `${i} ${'é世'.repeat(10)}`,
    )
    const msg = taskFailureMessage({
      label: 't',
      root: '/r',
      code: 1,
      output: run(lines.join('\n')),
    })
    expect(bytes(msg)).toBeLessThanOrEqual(MAX_TASK_MESSAGE_BYTES)
    expect(msg.length).toBeLessThan(MAX_TASK_MESSAGE_BYTES)
    expect(msg).toContain('(earlier lines cut)')
    expect(msg.endsWith(`${lines[2999]}\n\`\`\``)).toBe(true)
  })

  it('keeps the end of one line longer than the room, on a character boundary', () => {
    const long = `HEAD${'世'.repeat(10000)}TAIL`
    const msg = taskFailureMessage({
      label: 't',
      root: '/r',
      code: 1,
      output: run(long),
    })
    expect(bytes(msg)).toBeLessThanOrEqual(MAX_TASK_MESSAGE_BYTES)
    expect(msg).toContain('(earlier lines cut)')
    expect(msg).not.toContain('HEAD')
    expect(msg).not.toContain('�')
    expect(msg.endsWith('世TAIL\n```')).toBe(true)
    // Filled as far as a whole character allows
    expect(MAX_TASK_MESSAGE_BYTES - bytes(msg)).toBeLessThan(3)
  })

  it('keeps the end of a long last line, dropping the lines above it', () => {
    const msg = taskFailureMessage({
      label: 't',
      root: '/r',
      code: 1,
      output: run(`first\n${'z'.repeat(20000)}END`),
    })
    expect(bytes(msg)).toBeLessThanOrEqual(MAX_TASK_MESSAGE_BYTES)
    expect(msg).not.toContain('first')
    expect(msg.endsWith('zEND\n```')).toBe(true)
  })

  it('quotes a label holding backticks with a longer delimiter', () => {
    const msg = taskFailureMessage({
      label: 'a `b` c',
      root: '/r',
      code: 1,
      output: { output: 'x', cut: false },
    })
    expect(msg.startsWith('Task `` a `b` c `` failed')).toBe(true)
  })
})
