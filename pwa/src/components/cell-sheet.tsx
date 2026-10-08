import { Copy } from 'lucide-react'
import { visibleUnsafe } from '../utils/unsafe-chars'
import { cellText } from './table-grid'
import { IconButton } from './ui/button'
import { Sheet } from './ui/sheet'

interface Props {
  // The cell shown, or none
  cell?: { row: number; name: string; value: string }
  onClose: () => void
  notify: (message: string) => void
}

// The whole value of one cell, wrapped, with unsafe characters made visible;
// Copy takes the value as it is in the file.
export function CellSheet({ cell, onClose, notify }: Props) {
  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      notify('Value copied')
    } catch {
      notify('Could not copy the value')
    }
  }
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
      actions={
        cell && (
          <IconButton aria-label="Copy value" onClick={() => copy(cell.value)}>
            <Copy size={16} aria-hidden="true" />
          </IconButton>
        )
      }
    >
      <pre className="m-0 whitespace-pre-wrap break-all p-4 font-term text-[12px]">
        <bdi>{cell && visibleUnsafe(cell.value, true)}</bdi>
      </pre>
    </Sheet>
  )
}
