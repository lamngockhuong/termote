import { Wifi, WifiOff } from 'lucide-react'
import { useT } from '../i18n/i18n-context'
import type { MessageKey } from '../i18n/messages/en'
import { FOCUS_RING } from './ui/button'

export type ConnectionState =
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'error'
  // Closed for a newer stream (the server holds a few at most): not retried
  // on its own, so two windows never push each other out in turn
  | 'evicted'

// The stream is down and not coming back on its own right now
export const isDown = (state: ConnectionState | undefined) =>
  state === 'disconnected' || state === 'error' || state === 'evicted'

interface Props {
  state: ConnectionState
  onRetry?: () => void
}

const STATUS_COLORS: Record<ConnectionState, string> = {
  connecting: 'bg-warning motion-safe:animate-pulse',
  connected: 'bg-success',
  disconnected: 'bg-danger',
  error: 'bg-danger',
  evicted: 'bg-danger',
}

export const STATUS_TEXT: Record<ConnectionState, MessageKey> = {
  connecting: 'shell.connection.connecting',
  connected: 'shell.connection.connected',
  disconnected: 'shell.connection.disconnected',
  error: 'shell.connection.error',
  evicted: 'shell.connection.evicted',
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
  const { t } = useT()
  const isClickable = state !== 'connected' && state !== 'connecting'

  return (
    <button
      type="button"
      onClick={isClickable ? onRetry : undefined}
      className={`flex h-8 items-center gap-1.5 px-2 rounded-control text-fg-muted transition-colors duration-(--duration-fast) pointer-coarse:h-touch ${FOCUS_RING} ${
        isClickable ? 'hover:bg-surface hover:text-fg' : 'cursor-default'
      }`}
      title={t(STATUS_TEXT[state])}
      aria-label={t(STATUS_TEXT[state])}
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
