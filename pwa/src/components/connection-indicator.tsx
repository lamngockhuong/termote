import { Wifi, WifiOff } from 'lucide-react'

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
  connecting: 'bg-yellow-500',
  connected: 'bg-green-500',
  disconnected: 'bg-red-500',
  error: 'bg-red-500',
}

const STATUS_TEXT: Record<ConnectionState, string> = {
  connecting: 'Connecting...',
  connected: 'Connected',
  disconnected: 'Disconnected',
  error: 'Connection error',
}

export function ConnectionIndicator({ state, onRetry }: Props) {
  const isClickable = state !== 'connected' && state !== 'connecting'

  return (
    <button
      onClick={isClickable ? onRetry : undefined}
      className={`flex items-center gap-1.5 px-2 py-1 rounded-lg transition-colors ${
        isClickable
          ? 'hover:bg-zinc-200/50 dark:hover:bg-zinc-700/50 cursor-pointer'
          : 'cursor-default'
      }`}
      title={STATUS_TEXT[state]}
      aria-label={STATUS_TEXT[state]}
      disabled={!isClickable}
    >
      <span
        className={`w-2 h-2 rounded-full ${STATUS_COLORS[state]} ${
          state === 'connecting' ? 'animate-pulse' : ''
        }`}
      />
      <span className="text-zinc-500 dark:text-zinc-400 hidden sm:inline">
        {state === 'connected' ? <Wifi size={14} /> : <WifiOff size={14} />}
      </span>
    </button>
  )
}
