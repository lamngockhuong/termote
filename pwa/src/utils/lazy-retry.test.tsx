import { fireEvent, render, screen } from '@testing-library/react'
import { Component, type ReactNode, Suspense, useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { lazyRetry } from './lazy-retry'

// Keeps the failed render from reaching the test runner
class Catch extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    return this.state.failed ? 'failed' : this.props.children
  }
}

function Hello({ name }: { name: string }) {
  return <p>Hello {name}</p>
}

function Counter() {
  const [n, setN] = useState(0)
  return (
    <button type="button" onClick={() => setN(n + 1)}>
      count {n}
    </button>
  )
}

describe('lazyRetry', () => {
  it('renders the loaded component with its props', async () => {
    const Lazy = lazyRetry(() => Promise.resolve({ default: Hello }))
    render(
      <Suspense fallback={null}>
        <Lazy name="Ada" />
      </Suspense>,
    )
    expect(await screen.findByText('Hello Ada')).toBeInTheDocument()
  })

  it('imports again after retry(), where React.lazy would keep the failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error('chunk gone'))
      .mockResolvedValue({ default: Hello })
    const Lazy = lazyRetry<{ name: string }>(load)
    const tree = () => (
      <Catch>
        <Suspense fallback={null}>
          <Lazy name="Ada" />
        </Suspense>
      </Catch>
    )
    const view = render(tree())
    expect(await screen.findByText('failed')).toBeInTheDocument()
    expect(load).toHaveBeenCalledTimes(1)
    Lazy.retry()
    view.unmount()
    render(tree())
    expect(await screen.findByText('Hello Ada')).toBeInTheDocument()
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('keeps mounted instances on retry() after a render error in the loaded chunk', async () => {
    const load = vi.fn().mockResolvedValue({ default: Counter })
    const Lazy = lazyRetry<object>(load)
    const tree = (
      <Suspense fallback={null}>
        <Lazy />
        <Lazy />
      </Suspense>
    )
    const view = render(tree)
    const [first] = await screen.findAllByRole('button', { name: 'count 0' })
    fireEvent.click(first)
    Lazy.retry()
    // A fresh lazy() would remount both and lose the count
    view.rerender(tree)
    expect(screen.getByRole('button', { name: 'count 1' })).toBeInTheDocument()
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('names the component for the dev tools', () => {
    expect(
      lazyRetry(() => Promise.resolve({ default: Hello })).displayName,
    ).toBe('LazyRetry')
    expect(
      lazyRetry(() => Promise.resolve({ default: Hello }), 'ChatView')
        .displayName,
    ).toBe('ChatView')
  })
})
