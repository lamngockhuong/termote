import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useState } from 'react'
import type { CsvTable } from '../utils/csv-parse'
import { cellText, shownAt } from './table-grid'
import { FOCUS_RING, IconButton } from './ui/button'

interface Props {
  text: string
  table: CsvTable
  rows: Int32Array
  names: string[]
  onOpen: (row: number, col: number) => void
}

// One record at a time, as "column: value" with values wrapped: a table on
// a phone, where a row is wider than the screen.
export function TableRecords({ text, table, rows, names, onOpen }: Props) {
  const [index, setIndex] = useState(0)
  if (!rows.length) {
    return (
      <p className="p-4 text-center text-sm text-fg-muted">No matching rows</p>
    )
  }
  const i = Math.min(index, rows.length - 1)
  const r = rows[i]
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1">
        <IconButton
          size="sm"
          aria-label="Previous record"
          disabled={i === 0}
          onClick={() => setIndex(i - 1)}
        >
          <ChevronLeft size={16} aria-hidden="true" />
        </IconButton>
        <span
          className="flex-1 text-center text-[13px] tabular-nums"
          aria-live="polite"
        >
          Record {i + 1} / {rows.length} · row {r + 1}
        </span>
        <IconButton
          size="sm"
          aria-label="Next record"
          disabled={i === rows.length - 1}
          onClick={() => setIndex(i + 1)}
        >
          <ChevronRight size={16} aria-hidden="true" />
        </IconButton>
      </div>
      <dl
        aria-label={`Row ${r + 1}`}
        className="min-h-0 flex-1 overflow-y-auto px-3 py-2 font-term text-[12px]"
      >
        {names.map((name, c) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a field is its column
          <div key={c} className="border-b border-border/50 py-1.5">
            <dt className="text-fg-muted">
              <bdi>{cellText(name)}</bdi>
            </dt>
            <dd className="m-0">
              <button
                type="button"
                onClick={() => onOpen(r, c)}
                className={`w-full whitespace-pre-wrap break-all rounded-control text-left text-fg ${FOCUS_RING}`}
              >
                <bdi>{shownAt(text, table, r, c, true) || ' '}</bdi>
              </button>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  )
}
