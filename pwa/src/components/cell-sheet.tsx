import { Copy } from 'lucide-react'
import { useT } from '../i18n/i18n-context'
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
  const { t } = useT()
  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      notify(t('files.cell.copied'))
    } catch {
      notify(t('files.cell.copyFailed'))
    }
  }
  return (
    <Sheet
      isOpen={!!cell}
      onClose={onClose}
      title={
        cell && (
          <>
            {t('files.grid.rowN', { row: cell.row + 1 })} ·{' '}
            <bdi>{cellText(cell.name)}</bdi>
          </>
        )
      }
      actions={
        cell && (
          <IconButton
            aria-label={t('files.skipped.copyValue')}
            onClick={() => copy(cell.value)}
          >
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
