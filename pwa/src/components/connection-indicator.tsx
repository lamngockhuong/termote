import { Wifi, WifiOff } from 'lucide-react'
import { FOCUS_RING } from './ui/button'

export type ConnectionState =
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'error'

interface Props {
  state: ConnectionState
  onRetry?: () => void
}

const STATUS_COLORS: Record<ConnectionState, string> = {
  connecting: 'bg-warning motion-safe:animate-pulse',
  connected: 'bg-success',
  disconnected: 'bg-danger',
  error: 'bg-danger',
}

export const STATUS_TEXT: Record<ConnectionState, string> = {
  connecting: 'Connecting...',
  connected: 'Connected',
  disconnected: 'Disconnected',
  error: 'Connection error',
}

// The coloured dot alone, for places that show the state without the retry
// button (the mobile session chip).
export function ConnectionDot({ state }: { state: ConnectionState }) {
  return (
    <span
      aria-hidden="true"
      data-state={state}
      className={`size-2 shrink-0 rounded-full ${STATUS_COLORS[state]}`}
    />
  )
}

export function ConnectionIndicator({ state, onRetry }: Props) {
  const isClickable = state !== 'connected' && state !== 'connecting'

  return (
    <button
      type="button"
      onClick={isClickable ? onRetry : undefined}
      className={`flex h-8 items-center gap-1.5 px-2 rounded-control text-fg-muted transition-colors duration-(--duration-fast) pointer-coarse:h-touch ${FOCUS_RING} ${
        isClickable ? 'hover:bg-surface hover:text-fg' : 'cursor-default'
      }`}
      title={STATUS_TEXT[state]}
      aria-label={STATUS_TEXT[state]}
      disabled={!isClickable}
    >
      <ConnectionDot state={state} />
      <span className="hidden sm:inline">
        {state === 'connected' ? (
          <Wifi size={14} aria-hidden="true" />
        ) : (
          <WifiOff size={14} aria-hidden="true" />
        )}
      </span>
    </button>
  )
}
