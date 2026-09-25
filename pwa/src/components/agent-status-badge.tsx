import { CircleAlert, CircleCheck, CircleDot, LoaderCircle } from 'lucide-react'
import type { AgentStatus } from '../types/session'

// Each status has its own icon as well as colour, so it reads without colour.
const STATUS_STYLE: Record<
  AgentStatus,
  { Icon: typeof CircleDot; className: string; label: string }
> = {
  blocked: {
    Icon: CircleAlert,
    className: 'text-red-500 dark:text-red-400',
    label: 'Agent blocked',
  },
  working: {
    Icon: LoaderCircle,
    className: 'text-amber-500 dark:text-amber-400 motion-safe:animate-spin',
    label: 'Agent working',
  },
  done: {
    Icon: CircleCheck,
    className: 'text-green-600 dark:text-green-400',
    label: 'Agent done',
  },
  idle: {
    Icon: CircleDot,
    className: 'text-zinc-400 dark:text-zinc-500',
    label: 'Agent idle',
  },
}

interface Props {
  status?: AgentStatus
  size?: number
}

export function AgentStatusBadge({ status, size = 14 }: Props) {
  if (!status) return null
  const { Icon, className, label } = STATUS_STYLE[status]
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-status={status}
      className="shrink-0 inline-flex items-center"
    >
      <Icon size={size} className={className} aria-hidden="true" />
    </span>
  )
}
