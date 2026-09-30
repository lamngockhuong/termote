import { CircleAlert, Info, TriangleAlert } from 'lucide-react'
import type { ReactNode } from 'react'

export type BannerVariant = 'info' | 'warning' | 'danger'

const VARIANTS: Record<BannerVariant, { box: string; icon: string }> = {
  info: { box: 'bg-info/12', icon: 'text-info' },
  warning: { box: 'bg-warning/12', icon: 'text-warning' },
  danger: { box: 'bg-danger/12', icon: 'text-danger' },
}

const ICONS = { info: Info, warning: TriangleAlert, danger: CircleAlert }

interface Props {
  variant?: BannerVariant
  children: ReactNode
  // Optional control at the end of the line (Retry, Update...)
  action?: ReactNode
}

// A one-line notice under the top bar: view-only mode, lost connection,
// an update. Screen readers announce a role="status" region reliably only when
// its content changes after it is in the page, so a caller that must be heard
// keeps the Banner mounted and changes its children, rather than mounting it
// together with the message.
export function Banner({ variant = 'info', children, action }: Props) {
  const { box, icon } = VARIANTS[variant]
  const Icon = ICONS[variant]
  return (
    <div
      role="status"
      data-variant={variant}
      className={`flex shrink-0 items-center gap-2 px-3 py-2 text-[13px] text-fg ${box}`}
    >
      <Icon size={15} aria-hidden="true" className={`shrink-0 ${icon}`} />
      <span className="min-w-0 flex-1">{children}</span>
      {action}
    </div>
  )
}
