import { CircleAlert, CircleCheck, CircleDot, LoaderCircle } from 'lucide-react'
import { useT } from '../i18n/i18n-context'
import type { MessageKey } from '../i18n/messages/en'
import type { AgentStatus } from '../types/session'

// Each status has its own icon as well as colour, so it reads without colour.
const STATUS_STYLE: Record<
  AgentStatus,
  { Icon: typeof CircleDot; className: string; label: MessageKey }
> = {
  blocked: {
    Icon: CircleAlert,
    className: 'text-danger',
    label: 'shell.agent.blocked',
  },
  working: {
    Icon: LoaderCircle,
    className: 'text-warning motion-safe:animate-spin',
    label: 'shell.agent.working',
  },
  done: {
    Icon: CircleCheck,
    className: 'text-success',
    label: 'shell.agent.done',
  },
  idle: {
    Icon: CircleDot,
    className: 'text-fg-subtle',
    label: 'shell.agent.idle',
  },
}

interface Props {
  status?: AgentStatus
  size?: number
}

export function AgentStatusBadge({ status, size = 14 }: Props) {
  const { t } = useT()
  if (!status) return null
  const { Icon, className } = STATUS_STYLE[status]
  const label = t(STATUS_STYLE[status].label)
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
