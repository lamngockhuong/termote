import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LazyBoundary, LoadFailed } from './lazy-boundary'

let broken = true
function Child() {
  if (broken) throw new Error('chunk gone')
  return <p>loaded</p>
}

const fallback = (retry: () => void) => (
  <button type="button" onClick={retry}>
    Try again
  </button>
)

let error: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  broken = true
  error = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => error.mockRestore())

describe('LazyBoundary', () => {
  it('renders its children while nothing fails', () => {
    broken = false
    render(
      <LazyBoundary fallback={fallback}>
        <Child />
      </LazyBoundary>,
    )
    expect(screen.getByText('loaded')).toBeInTheDocument()
  })

  it('shows the fallback, logs the failure once and reports it', () => {
    const onError = vi.fn()
    render(
      <LazyBoundary fallback={fallback} onError={onError}>
        <Child />
      </LazyBoundary>,
    )
    expect(
      screen.getByRole('button', { name: 'Try again' }),
    ).toBeInTheDocument()
    const ours = error.mock.calls.filter(
      ([m]: unknown[]) => m === 'Could not load a lazy component',
    )
    expect(ours).toHaveLength(1)
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('retries: asks the lazy to import again, then renders the children', () => {
    const onRetry = vi.fn(() => {
      broken = false
    })
    render(
      <LazyBoundary fallback={fallback} onRetry={onRetry}>
        <Child />
      </LazyBoundary>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(screen.getByText('loaded')).toBeInTheDocument()
  })

  it('retries without an onRetry', () => {
    render(
      <LazyBoundary fallback={fallback}>
        <Child />
      </LazyBoundary>,
    )
    broken = false
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(screen.getByText('loaded')).toBeInTheDocument()
  })

  it('asks the lazy to import again when it goes while failed, and only then', () => {
    const onRetry = vi.fn()
    const tree = (
      <LazyBoundary fallback={fallback} onRetry={onRetry}>
        <Child />
      </LazyBoundary>
    )
    broken = false
    render(tree).unmount()
    expect(onRetry).not.toHaveBeenCalled()
    broken = true
    render(tree).unmount()
    expect(onRetry).toHaveBeenCalledTimes(1)
  })
})

describe('LoadFailed', () => {
  it('is announced, and Try again moves focus to the container that held it', () => {
    const retry = vi.fn()
    render(
      <div data-testid="host">
        <LoadFailed message="Could not load this view" retry={retry} />
      </div>,
    )
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Could not load this view',
    )
    const button = screen.getByRole('button', { name: 'Try again' })
    button.focus()
    fireEvent.click(button)
    expect(retry).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(screen.getByTestId('host'))
  })

  it('leaves a container that is already focusable as it is', () => {
    render(
      <div data-testid="host" tabIndex={-1}>
        <LoadFailed message="Could not load this view" retry={() => {}} />
      </div>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(screen.getByTestId('host')).toHaveAttribute('tabindex', '-1')
    expect(document.activeElement).toBe(screen.getByTestId('host'))
  })
})
