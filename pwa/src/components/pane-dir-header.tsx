import { GitBranch, RefreshCw } from 'lucide-react'
import type { ReactNode } from 'react'
import { keepOrder, shortRoot, TRUNCATE_START } from '../utils/files-format'
import { IconButton } from './ui/button'

interface Props {
  root?: string
  branch?: string
  onRefresh: () => void
  refreshing?: boolean
  children?: ReactNode
}

// The top line of Files and Changes: the pane's root (the git toplevel of its
// directory, else the directory), the branch, and a refresh button.
export function PaneDirHeader({
  root,
  branch,
  onRefresh,
  refreshing,
  children,
}: Props) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
      <div className="flex min-w-0 flex-1 flex-col">
        <span
          className={`${TRUNCATE_START} font-term text-[12px] text-fg`}
          title={root}
          data-testid="pane-root"
        >
          {root ? keepOrder(shortRoot(root)) : '…'}
        </span>
        {branch && (
          <span className="flex items-center gap-1 text-[11px] text-fg-muted">
            <GitBranch size={11} aria-hidden="true" />
            <span className="truncate">{branch}</span>
          </span>
        )}
      </div>
      {children}
      <IconButton
        size="sm"
        variant="ghost"
        onClick={onRefresh}
        aria-label="Refresh"
        title="Refresh"
      >
        <RefreshCw
          size={15}
          aria-hidden="true"
          className={
            refreshing ? 'animate-spin motion-reduce:animate-none' : ''
          }
        />
      </IconButton>
    </div>
  )
}

// A message in place of a list or a file
export function ViewMessage({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-sm text-fg-muted">
      {children}
    </div>
  )
}
