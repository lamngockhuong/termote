import { MoveHorizontal, Search, ZoomIn, ZoomOut } from 'lucide-react'
import { useT } from '../i18n/i18n-context'
import { IconButton } from './ui/button'

interface Props {
  // The page most in view, and how many there are
  page: number
  pages: number
  // The zoom, as a percentage
  scale: number
  onZoomIn: () => void
  onZoomOut: () => void
  onFitWidth: () => void
  findOpen: boolean
  onFind: () => void
}

// Above a PDF: where it is, its zoom, and find. Buttons only (no pinch):
// the same on a phone, each large enough to tap.
export function PdfToolbar({
  page,
  pages,
  scale,
  onZoomIn,
  onZoomOut,
  onFitWidth,
  findOpen,
  onFind,
}: Props) {
  const { t } = useT()
  return (
    <div
      role="toolbar"
      // i18n-ignore: the format's name
      aria-label="PDF"
      className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1 text-[13px] text-fg-muted"
    >
      <span className="tabular-nums" aria-live="polite">
        {t('files.pdf.page', { page, pages })}
      </span>
      <span className="flex-1" />
      <IconButton
        size="sm"
        aria-label={t('files.zoom.out')}
        title={t('files.zoom.out')}
        onClick={onZoomOut}
      >
        <ZoomOut size={15} aria-hidden="true" />
      </IconButton>
      <span className="min-w-11 text-center tabular-nums">{scale}%</span>
      <IconButton
        size="sm"
        aria-label={t('files.zoom.in')}
        title={t('files.zoom.in')}
        onClick={onZoomIn}
      >
        <ZoomIn size={15} aria-hidden="true" />
      </IconButton>
      <IconButton
        size="sm"
        aria-label={t('files.pdf.fitWidth')}
        title={t('files.pdf.fitWidth')}
        onClick={onFitWidth}
      >
        <MoveHorizontal size={15} aria-hidden="true" />
      </IconButton>
      <IconButton
        size="sm"
        aria-label={t('files.pdf.findShort')}
        title={t('files.pdf.find')}
        aria-pressed={findOpen}
        className={findOpen ? 'text-accent' : ''}
        onClick={onFind}
      >
        <Search size={15} aria-hidden="true" />
      </IconButton>
    </div>
  )
}
