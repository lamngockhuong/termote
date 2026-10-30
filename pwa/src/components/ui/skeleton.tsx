import { useEffect, useState } from 'react'

// Below this a load is quick enough to show nothing: a LAN answer would
// otherwise flash grey blocks
export const SKELETON_DELAY_MS = 150

// The widths the lines take in turn, so they read as text, not a grid
const WIDTHS = ['w-3/4', 'w-1/2', 'w-5/6', 'w-2/3', 'w-2/5']

// A grey block where content is still on its way; className sizes it
export function Skeleton({ className = '' }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`block rounded-control bg-surface-raised motion-safe:animate-pulse ${className}`}
    />
  )
}

interface LinesProps {
  // Read out at once (role="status"), and found by text: the message the
  // loading text was
  label: string
  lines?: number
  // A small square before each line: a row with an icon (a file)
  icon?: boolean
  // A wider first line: a title over the rows (a commit)
  heading?: boolean
  // Thin lines close together: code
  code?: boolean
  className?: string
}

// The shape of a list or text still loading, in place of a "Loading" line.
// The label is there from the start; the blocks only after
// SKELETON_DELAY_MS.
export function SkeletonLines({
  label,
  lines = 6,
  icon = false,
  heading = false,
  code = false,
  className = '',
}: LinesProps) {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setShown(true), SKELETON_DELAY_MS)
    return () => clearTimeout(timer)
  }, [])
  return (
    <div
      role="status"
      className={`flex flex-col ${code ? 'gap-2 p-4' : 'gap-3 p-3'} ${className}`}
    >
      <span className="sr-only">{label}</span>
      {shown && heading && <Skeleton className="mb-1 h-5 w-1/3" />}
      {shown &&
        Array.from({ length: lines }, (_, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed placeholder lines
            key={i}
            aria-hidden="true"
            className="flex items-center gap-2"
          >
            {icon && <Skeleton className="size-4 shrink-0" />}
            <Skeleton
              className={`${code ? 'h-3' : 'h-3.5'} ${WIDTHS[i % WIDTHS.length]}`}
            />
          </div>
        ))}
    </div>
  )
}
