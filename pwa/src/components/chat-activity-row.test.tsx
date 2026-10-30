import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWithLocale } from '../i18n/test-utils'
import {
  ChatActivityRow,
  ChatBackgroundRow,
  formatElapsed,
} from './chat-activity-row'

// The visible line, without the text read out to a screen reader
const line = () =>
  screen.getByRole('status').nextElementSibling?.textContent ?? ''

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('formatElapsed', () => {
  it('writes the time as the terminal does', () => {
    expect(formatElapsed(0)).toBe('0s')
    expect(formatElapsed(59)).toBe('59s')
    expect(formatElapsed(74)).toBe('1m 14s')
    expect(formatElapsed(3723)).toBe('1h 2m')
  })
})

describe('ChatActivityRow', () => {
  it('shows the word, the phase in the reader language, time and tokens', () => {
    renderWithLocale(
      <ChatActivityRow
        agent="Claude Code"
        activity={{
          label: 'Incubating',
          elapsed: 5,
          phase: 'thinking',
          detail: 'still thinking',
          tokens: '1.2k',
        }}
      />,
      'vi',
    )
    expect(line()).toBe('Incubating… · Đang suy nghĩ · 5s · ↓ 1.2k token')
    expect(screen.getByRole('status')).toHaveTextContent(
      'Incubating… Đang suy nghĩ',
    )
  })

  it('runs the time on between two reads and takes each new count', () => {
    const { rerender } = render(
      <ChatActivityRow
        agent="Codex"
        activity={{ label: 'Working', elapsed: 8 }}
      />,
    )
    expect(line()).toBe('Working… · 8s')
    act(() => vi.advanceTimersByTime(3000))
    expect(line()).toBe('Working… · 11s')
    rerender(
      <ChatActivityRow
        agent="Codex"
        activity={{ label: 'Working', elapsed: 2 }}
      />,
    )
    expect(line()).toBe('Working… · 2s')
    // A line without a count keeps the time running from the last one
    rerender(<ChatActivityRow agent="Codex" activity={{ label: 'Working' }} />)
    act(() => vi.advanceTimersByTime(1000))
    expect(line()).toBe('Working… · 3s')
  })

  it('without a line read, says the agent works and counts from now', () => {
    render(<ChatActivityRow agent="Claude Code" activity={null} />)
    expect(line()).toBe('Claude Code is working… · 0s')
    act(() => vi.advanceTimersByTime(2000))
    expect(line()).toBe('Claude Code is working… · 2s')
  })

  it('shows unsafe characters of the line visibly', () => {
    render(
      <ChatActivityRow
        agent="Claude Code"
        activity={{ label: 'Wor‮king', detail: 'a​b' }}
      />,
    )
    expect(line()).not.toContain('‮')
    expect(line()).not.toContain('​')
  })

  it('keeps the text read out inside the row', () => {
    render(<ChatActivityRow agent="Claude Code" activity={null} />)
    // The absolute sr-only box would otherwise belong to the view outside
    // the scrolling list (iOS Safari grew the page below the row)
    expect(screen.getByRole('status').parentElement).toHaveClass('relative')
  })

  it('pulses only when motion is allowed', () => {
    const { container } = render(
      <ChatActivityRow agent="Claude Code" activity={null} />,
    )
    expect(container.querySelector('svg')).toHaveClass(
      'motion-safe:animate-pulse',
    )
  })
})

describe('ChatBackgroundRow', () => {
  it('says what the turn left running, in the reader language', () => {
    renderWithLocale(<ChatBackgroundRow what="1 shell, 1 monitor" />, 'vi')
    expect(screen.getByRole('status')).toHaveTextContent(
      'Đã xong lượt · 1 shell, 1 monitor vẫn đang chạy',
    )
  })
})
