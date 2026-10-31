import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SKELETON_DELAY_MS, Skeleton, SkeletonLines } from './skeleton'

describe('Skeleton', () => {
  it('is a hidden pulsing block sized by its classes', () => {
    const { container } = render(<Skeleton className="h-4 w-10" />)
    const block = container.firstElementChild!
    expect(block).toHaveAttribute('aria-hidden', 'true')
    expect(block).toHaveClass('motion-safe:animate-pulse', 'h-4', 'w-10')
  })
})

describe('SkeletonLines', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const blocks = () => document.querySelectorAll('[aria-hidden="true"]')

  it('says it is loading at once, and draws its lines only after a moment', () => {
    render(<SkeletonLines label="Loading…" lines={3} />)
    expect(screen.getByRole('status')).toHaveTextContent('Loading…')
    expect(screen.getByText('Loading…')).toHaveClass('sr-only')
    expect(blocks()).toHaveLength(0)
    act(() => {
      vi.advanceTimersByTime(SKELETON_DELAY_MS - 1)
    })
    expect(blocks()).toHaveLength(0)
    act(() => {
      vi.advanceTimersByTime(1)
    })
    // One row each, holding its line
    expect(
      screen.getByRole('status').querySelectorAll(':scope > div'),
    ).toHaveLength(3)
  })

  it('puts an icon before each line, and a title over them, when asked', () => {
    render(<SkeletonLines label="Loading…" lines={2} icon heading />)
    act(() => {
      vi.advanceTimersByTime(SKELETON_DELAY_MS)
    })
    const status = screen.getByRole('status')
    expect(status.querySelectorAll('.size-4')).toHaveLength(2)
    expect(status.querySelector('.h-5')).toBeInTheDocument()
  })

  it('draws code as thin lines close together, six by default', () => {
    render(<SkeletonLines label="Loading…" code className="flex-1" />)
    act(() => {
      vi.advanceTimersByTime(SKELETON_DELAY_MS)
    })
    const status = screen.getByRole('status')
    expect(status).toHaveClass('gap-2', 'flex-1')
    expect(status.querySelectorAll('.h-3')).toHaveLength(6)
    expect(status.querySelector('.size-4')).toBeNull()
  })

  it('leaves no timer behind once gone', () => {
    const { unmount } = render(<SkeletonLines label="Loading…" />)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
