import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BlameCommit, FileBlame } from '../hooks/use-mux-api'
import {
  BlameCell,
  BlamePopover,
  blameAge,
  blameWidth,
  initials,
  lineOwners,
} from './blame-gutter'

const mockCopy = vi.fn()
vi.mock('../utils/copy-text', () => ({
  copyText: (...a: unknown[]) => mockCopy(...a),
}))

const commit: BlameCommit = {
  author: 'Alice Liddell',
  time: 1_700_000_000,
  summary: 'fix: the parser',
}
const HASH = 'a'.repeat(40)

afterEach(() => {
  mockCopy.mockReset()
  vi.restoreAllMocks()
})

describe('lineOwners', () => {
  it('gives each line its commit, an empty owner when not committed', () => {
    const blame: FileBlame = {
      root: '/r',
      path: 'a',
      lines: 5,
      commits: {},
      ranges: [
        { start: 1, count: 2, commit: 'x' },
        { start: 4, count: 1, commit: 'y' },
      ],
      uncommitted: [{ start: 3, count: 1 }],
    }
    expect(lineOwners(blame)).toEqual(['x', 'x', '', 'y', ''])
  })
})

describe('blameAge', () => {
  const now = 1_700_000_000_000
  const at = (s: number) => blameAge(now / 1000 - s, 'en', now)
  it('names the largest whole unit, up to years', () => {
    expect(at(3 * 365 * 86_400)).toBe('3y ago')
    expect(at(2 * 30 * 86_400)).toBe('2mo ago')
    expect(at(14 * 86_400)).toBe('2w ago')
    expect(at(86_400)).toBe('yesterday')
    expect(at(3 * 3_600)).toBe('3h ago')
    expect(at(5 * 60)).toBe('5m ago')
    expect(at(10)).toBe('this minute')
    // A clock behind the commit's
    expect(at(-2 * 86_400)).toBe('in 2d')
  })
})

describe('initials', () => {
  it('takes the first letters of the first and last words', () => {
    expect(initials('alice liddell')).toBe('AL')
    expect(initials('  Bob  ')).toBe('B')
    expect(initials('Ana María de Souza')).toBe('AS')
    expect(initials('')).toBe('?')
    expect(initials('😀 x')).toBe('😀X')
  })
})

describe('blameWidth', () => {
  it('is narrower on a phone', () => {
    expect(blameWidth(true)).toBe('5.5rem')
    expect(blameWidth(false)).toBe('11.5rem')
  })
})

describe('BlameCell', () => {
  const cell = (p: Partial<Parameters<typeof BlameCell>[0]> = {}) => {
    const onOpen = vi.fn()
    const view = render(
      <BlameCell
        owner={HASH}
        first
        line={1}
        commit={commit}
        compact={false}
        onOpen={onOpen}
        {...p}
      />,
    )
    return { onOpen, ...view }
  }

  it('names the author and the age on the first line of a run, and opens the details', () => {
    const { onOpen } = cell({ line: 4 })
    const button = screen.getByRole('button', {
      name: /^Alice Liddell, .* ago: line 4$/,
    })
    expect(button).toHaveTextContent('Alice Liddell')
    expect(button).toHaveAttribute('data-blame-commit', HASH)
    // A rule above every run but the first line's
    expect(button.className).toContain('border-t')
    expect(button.style.width).toBe('11.5rem')
    fireEvent.click(button)
    expect(onOpen).toHaveBeenCalledWith(HASH, button)
  })

  it('shows initials on a phone, no rule on line 1', () => {
    cell({ compact: true })
    const button = screen.getByRole('button')
    expect(button).toHaveTextContent(/^AL/)
    expect(button.className).not.toContain('border-t')
  })

  it('is blank below the first line of a run', () => {
    const { container } = cell({ first: false })
    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true')
    expect(container).toHaveTextContent('')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('says a line is not committed, without details to open', () => {
    cell({ owner: '', commit: undefined })
    expect(screen.getByText('Not committed')).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
  })
})

describe('BlamePopover', () => {
  const open = (summary = commit.summary) => {
    const anchor = document.createElement('button')
    document.body.append(anchor)
    const notify = vi.fn()
    const onClose = vi.fn()
    const view = render(
      <BlamePopover
        hash={HASH}
        commit={{ ...commit, summary }}
        anchor={anchor}
        notify={notify}
        onClose={onClose}
      />,
    )
    return { anchor, notify, onClose, ...view }
  }

  it("shows the commit's summary, author, date and short hash, focused", () => {
    open()
    const box = screen.getByRole('dialog', { name: 'Commit details' })
    expect(box).toHaveTextContent('fix: the parser')
    expect(box).toHaveTextContent('Alice Liddell')
    expect(box).toHaveTextContent('2023')
    expect(box).toHaveTextContent('aaaaaaa')
    expect(box).not.toHaveTextContent(HASH)
    expect(box).toHaveFocus()
    expect(box).not.toHaveAttribute('popover')
  })

  it('says when the commit has no message', () => {
    open('')
    expect(screen.getByText('(no message)')).toBeInTheDocument()
  })

  it('copies the full hash and says so', async () => {
    mockCopy.mockResolvedValueOnce('ok').mockResolvedValueOnce('failed')
    const { notify } = open()
    fireEvent.click(screen.getByRole('button', { name: 'Copy hash' }))
    await waitFor(() => expect(notify).toHaveBeenCalledWith('Hash copied'))
    expect(mockCopy).toHaveBeenCalledWith(HASH)
    fireEvent.click(screen.getByRole('button', { name: 'Copy hash' }))
    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith('Could not copy the hash'),
    )
  })

  it('closes on Escape, giving focus back to the cell', () => {
    const { anchor, onClose } = open()
    const box = screen.getByRole('dialog')
    fireEvent.keyDown(box, { key: 'a' })
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(box, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(anchor).toHaveFocus()
  })

  it('closes on a press outside it and its cell, or a scroll outside it', () => {
    const { anchor, onClose } = open()
    const box = screen.getByRole('dialog')
    fireEvent.pointerDown(box)
    fireEvent.pointerDown(anchor)
    fireEvent.scroll(box)
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.pointerDown(document.body)
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.scroll(document)
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('goes in the top layer where the browser has one', () => {
    const show = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'showPopover', {
      configurable: true,
      value: show,
    })
    try {
      open()
      expect(screen.getByTestId('blame-popover')).toHaveAttribute(
        'popover',
        'manual',
      )
      expect(show).toHaveBeenCalledTimes(1)
    } finally {
      delete (HTMLElement.prototype as Partial<HTMLElement>).showPopover
    }
  })

  it('is capped in height when the screen is short', () => {
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(40)
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(200)
    open()
    expect(screen.getByRole('dialog').style.maxHeight).not.toBe('')
  })
})
