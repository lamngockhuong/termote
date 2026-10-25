import { Component, type ReactNode } from 'react'
import { ViewMessage } from './pane-dir-header'
import { Button } from './ui/button'

interface Props {
  children: ReactNode
  // What shows instead of the children once one failed to load or render;
  // retry() tries them again
  fallback: (retry: () => void) => ReactNode
  // Makes the lazy component behind the children import again (lazyRetry)
  onRetry?: () => void
  // Told once per failure, after it was logged
  onError?: () => void
}

interface State {
  failed: boolean
}

// Keeps a lazy chunk that fails to load (offline, a deploy that removed it)
// from unmounting the whole app. The error is logged, never shown.
export class LazyBoundary extends Component<Props, State> {
  state: State = { failed: false }

  static getDerivedStateFromError(): State {
    return { failed: true }
  }

  componentDidCatch(error: unknown) {
    console.error('Could not load a lazy component', error)
    this.props.onError?.()
  }

  // Leaving a failed one (another view) makes the next visit import again
  componentWillUnmount() {
    if (this.state.failed) this.props.onRetry?.()
  }

  retry = () => {
    this.props.onRetry?.()
    this.setState({ failed: false })
  }

  render() {
    return this.state.failed
      ? this.props.fallback(this.retry)
      : this.props.children
  }
}

// What takes the place of a view or preview that could not load: announced,
// with a way to try again. The button goes with the message, so focus moves
// to the container that holds it instead of dropping to the page.
export function LoadFailed({
  message,
  retry,
}: {
  message: string
  retry: () => void
}) {
  return (
    <ViewMessage>
      <span role="alert">{message}</span>
      <Button
        size="sm"
        onClick={(e) => {
          // The message sits in a ViewMessage, inside that container
          const host = (e.currentTarget.parentElement as HTMLElement)
            .parentElement as HTMLElement
          retry()
          if (!host.hasAttribute('tabindex')) host.tabIndex = -1
          host.focus({ preventScroll: true })
        }}
      >
        Try again
      </Button>
    </ViewMessage>
  )
}
