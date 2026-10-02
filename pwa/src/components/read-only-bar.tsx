import { Eye } from 'lucide-react'
import type { ReactNode } from 'react'

// The bottom bar of a view that takes no input: the whole app in view-only,
// or a chat whose agent cannot be written to yet.
export function ReadOnlyBar({
  label,
  action,
}: {
  label: string
  // Shown at the end of the bar (a way to the terminal)
  action?: ReactNode
}) {
  return (
    <div
      // pb-safe counts in the height: a bar with a touch-size button grows by
      // the inset so the button stays inside it
      className={`flex ${action ? 'min-h-[calc(3rem+env(safe-area-inset-bottom))]' : 'h-12'} shrink-0 items-center gap-2 border-t border-border bg-surface px-3 pb-safe ui-terminal:bg-bg`}
    >
      <Eye size={16} aria-hidden="true" className="text-fg-muted" />
      <span className="text-[13px] text-fg-muted ui-terminal:font-label">
        {label}
      </span>
      {action && <div className="ml-auto">{action}</div>}
    </div>
  )
}
