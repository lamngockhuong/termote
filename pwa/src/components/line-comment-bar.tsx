import { MessageSquarePlus, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button, IconButton } from './ui/button'

// Under a diff or a file whose lines are picked: which, and Comment
export function LineCommentBar({
  label,
  onComment,
  onClear,
}: {
  label: string
  onComment: () => void
  onClear: () => void
}) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-t border-border bg-surface px-3 py-1 text-[12px]">
      <span className="min-w-0 flex-1 truncate text-fg-muted">{label}</span>
      <Button size="sm" variant="primary" onClick={onComment}>
        <MessageSquarePlus size={14} aria-hidden="true" />
        Comment
      </Button>
      <IconButton size="sm" onClick={onClear} aria-label="Clear the lines">
        <X size={15} aria-hidden="true" />
      </IconButton>
    </div>
  )
}

// A line's numbers as a button that picks it (Shift: up to it), marked
// when a comment is on the line. Kept at the left edge like the numbers;
// out of the tab order, the editor being the keyboard's way.
export function LineGutterButton({
  line,
  removed = false,
  commented,
  onPress,
  children,
}: {
  line: number
  // A deleted line of a diff: line is its old number
  removed?: boolean
  commented: boolean
  onPress: (shift: boolean) => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-label={`${removed ? 'Removed line' : 'Line'} ${line}`}
      data-commented={commented || undefined}
      title={commented ? 'Has a comment' : undefined}
      onClick={(e) => onPress(e.shiftKey)}
      // Not the double click that keeps a Changes tab open
      onDoubleClick={(e) => e.stopPropagation()}
      className={`sticky left-0 z-[1] flex shrink-0 cursor-pointer select-none border-l-2 bg-inherit hover:text-fg ${commented ? 'border-accent' : 'border-transparent'}`}
    >
      {children}
    </button>
  )
}
