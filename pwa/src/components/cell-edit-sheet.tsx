import { Copy } from 'lucide-react'
import { useState } from 'react'
import { visibleUnsafe } from '../utils/unsafe-chars'
import { cellText } from './table-grid'
import { Button, FOCUS_RING, IconButton } from './ui/button'
import { Sheet } from './ui/sheet'

interface Props {
  // The cell being edited, or none
  cell?: { row: number; name: string; value: string }
  // Sets the cell to value, the same one included (nothing to change)
  onApply: (value: string) => void
  onInsertBelow: () => void
  onDelete: () => void
  onClose: () => void
  notify: (message: string) => void
}

// One cell of a table being edited: its whole value in a textarea (a value
// may hold line breaks), and the row's own actions.
export function CellEditSheet({ cell, onClose, ...rest }: Props) {
  return (
    <Sheet
      isOpen={!!cell}
      onClose={onClose}
      title={
        cell && (
          <>
            Row {cell.row + 1} · <bdi>{cellText(cell.name)}</bdi>
          </>
        )
      }
    >
      {cell && (
        <CellForm
          // A new cell starts from its own value
          key={`${cell.row}\u0000${cell.name}\u0000${cell.value}`}
          value={cell.value}
          onClose={onClose}
          {...rest}
        />
      )}
    </Sheet>
  )
}

function CellForm({
  value: initial,
  onApply,
  onInsertBelow,
  onDelete,
  onClose,
  notify,
}: Omit<Props, 'cell'> & { value: string }) {
  const [input, setInput] = useState(initial)
  // A value can hold characters that make it read as something else: they
  // are shown, since the textarea draws them as nothing (or reorders text)
  const shown = visibleUnsafe(input, true)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(input)
      notify('Value copied')
    } catch {
      notify('Could not copy the value')
    }
  }
  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-start gap-1">
        <textarea
          aria-label="Value"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          rows={4}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          className={`min-h-24 w-full flex-1 resize-y rounded-control border border-border bg-bg p-2 font-term text-[13px] text-fg pointer-coarse:text-[16px] ${FOCUS_RING}`}
        />
        <IconButton aria-label="Copy value" onClick={copy}>
          <Copy size={16} aria-hidden="true" />
        </IconButton>
      </div>
      {shown !== input.replace(/\r\n/g, '\n') && (
        <p className="m-0 text-[12px] text-fg-muted">
          Hidden characters:{' '}
          <bdi className="whitespace-pre-wrap break-all font-term">{shown}</bdi>
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="danger" onClick={onDelete} className="mr-auto">
          Delete row
        </Button>
        <Button onClick={onInsertBelow}>Add row below</Button>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={() => onApply(input)}>
          Apply
        </Button>
      </div>
    </div>
  )
}
