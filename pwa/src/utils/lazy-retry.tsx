import { type ComponentType, lazy } from 'react'

export type Retryable<P> = ComponentType<P> & { retry: () => void }

// A lazy component whose failed import can be tried again: React.lazy keeps a
// rejection forever, so retry() swaps in a fresh lazy() of the same import.
// Only a rejected import is swapped: after a render error in a loaded chunk
// the same component stays, so the other mounted ones keep their state.
export function lazyRetry<P extends object>(
  load: () => Promise<{ default: ComponentType<P> }>,
  name = 'LazyRetry',
): Retryable<P> {
  let rejected = false
  const tracked = () =>
    load().catch((error: unknown) => {
      rejected = true
      throw error
    })
  let current = lazy(tracked)
  function Component(props: P) {
    const Current = current as ComponentType<P>
    return <Current {...props} />
  }
  Component.displayName = name
  return Object.assign(Component, {
    retry: () => {
      if (!rejected) return
      rejected = false
      current = lazy(tracked)
    },
  })
}
