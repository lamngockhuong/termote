// Classes the sidebar's rows share: its tabs, the compact layout's
// workspaces and its agents.

// The row on screen: a soft accent fill, or an accent edge in the terminal style.
export const ACTIVE_ROW_CLASSES =
  'bg-accent-soft text-fg font-medium ui-terminal:bg-surface-raised ui-terminal:shadow-[inset_2px_0_0_var(--color-accent)]'
export const ROW_CLASSES = 'text-fg-muted hover:bg-surface-raised hover:text-fg'
// A press shrinks a row a little (less than a button: a row is wide)
export const ROW_PRESS =
  'transition-[color,background-color,scale] duration-(--duration-fast) ease-standard motion-safe:active:scale-[0.98]'
