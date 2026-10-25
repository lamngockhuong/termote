import { fireEvent, render, screen } from '@testing-library/react'
import type { ComponentType } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LazyMarkdownPreview, LazyTablePreview } from './file-viewer'

const h = vi.hoisted(() => ({ broken: false, retried: vi.fn() }))

// The real lazyRetry, told when its retry() is called
vi.mock('../utils/lazy-retry', async (orig) => {
  const real = await orig<typeof import('../utils/lazy-retry')>()
  return {
    lazyRetry: (...a: Parameters<typeof real.lazyRetry>) => {
      const lazy = real.lazyRetry(...a)
      const retry = lazy.retry
      lazy.retry = () => {
        h.retried(a[1])
        retry()
      }
      return lazy
    },
  }
})

// A preview whose code failed: a render that throws is what a rejected
// import looks like to the boundary around it
vi.mock('./markdown-preview', () => ({
  default: () => {
    if (h.broken) throw new Error('chunk gone')
    return <div data-testid="markdown-preview" />
  },
}))
vi.mock('./table-preview', () => ({
  default: () => {
    if (h.broken) throw new Error('chunk gone')
    return <div data-testid="table-preview" />
  },
}))

let error: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  h.broken = true
  h.retried.mockClear()
  error = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => error.mockRestore())

describe.each([
  ['MarkdownPreview', LazyMarkdownPreview, 'markdown-preview'],
  ['TablePreview', LazyTablePreview, 'table-preview'],
] as const)('lazy %s', (name, Preview, testId) => {
  it('says it could not load, and loads on Try again', async () => {
    // The mocks read no props
    const Bare = Preview as ComponentType
    render(<Bare />)
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not load the preview',
    )
    h.broken = false
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    // Its own retry, not the other preview's
    expect(h.retried).toHaveBeenCalledWith(name)
    expect(await screen.findByTestId(testId)).toBeInTheDocument()
    expect(screen.queryByText(/Could not load the preview/)).toBeNull()
  })
})
