import {
  ChevronsLeftRight,
  ChevronsRightLeft,
  Eye,
  FoldVertical,
  Maximize2,
  UnfoldVertical,
  X,
} from 'lucide-react'
import {
  type ComponentProps,
  createContext,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { useDialogModal } from '../hooks/use-dialog-modal'
import { useExitTransition } from '../hooks/use-exit-transition'
import { useHistoryClose } from '../hooks/use-history-close'
import { useRestoreFocus } from '../hooks/use-restore-focus'
import { useT } from '../i18n/i18n-context'
import { type HastNode, type LinkPath, textOf } from '../utils/markdown-links'
import { PROSE } from '../utils/prose'
import {
  headerNodes,
  headerTexts,
  readTablePrefs,
  type TableMode,
  type TablePrefs,
  tableKey,
  writeTablePrefs,
} from '../utils/table-prefs'
import { PreviewContext } from './markdown-preview-context'
import { FOCUS_RING, IconButton } from './ui/button'

// A table of a Markdown preview, with tools to read a wide or long one:
// Expand (no wrapping to the preview's width), Full screen, columns resized
// by dragging the edge of a header and hidden from it, and tall cells cut
// to a few lines until their row is clicked open or the table shows every
// cell in full. What the reader sets is kept per table (utils/table-prefs).
// The sizes and hidden columns are written on the cells themselves: the
// cells are react-markdown's, so they are not this component's to render.

// The narrowest a column is dragged to, and a hidden column with no width
// of its own once the widths are fixed
const MIN_COL = 50
const DEFAULT_COL = 150
// One press of an arrow key on a column's edge
const KEY_STEP = 16
// Cells are measured again this long after the last change of width
const DETECT_DELAY = 100
// A click on these inside a cell does not open its row
const INTERACTIVE = 'a, button, img, input, select, textarea, summary'

type Update = (change: (prefs: TablePrefs) => TablePrefs) => void

// What a header cell of a table does with its column
interface TableView {
  // A header cell's column (-1: not one of this table's)
  columnOf: (node: unknown) => number
  // Its width as set, when it has one
  widthOf: (col: number) => number | undefined
  startResize: (e: PointerEvent<HTMLElement>, col: number) => void
  resizeBy: (col: number, delta: number) => void
  hide: (col: number) => void
  canHide: boolean
}

const TableViewContext = createContext<TableView | null>(null)

function headerCells(table: HTMLTableElement): HTMLTableCellElement[] {
  return [...(table.tHead?.rows[0]?.cells ?? [])]
}

// The hidden columns, unless they would leave none
function hiddenSet(prefs: TablePrefs, columns: number): Set<number> {
  const hidden = new Set((prefs.hidden ?? []).filter((i) => i < columns))
  return hidden.size < columns ? hidden : new Set()
}

function setWidths(
  table: HTMLTableElement,
  ths: HTMLTableCellElement[],
  widths: number[],
  hidden: Set<number>,
) {
  table.style.tableLayout = 'fixed'
  // Wider than the preview is fine: the box around it scrolls
  table.style.maxWidth = 'none'
  table.style.width = `${widths.reduce((sum, w, i) => (hidden.has(i) ? sum : sum + w), 0)}px`
  ths.forEach((th, i) => {
    th.style.width = `${widths[i]}px`
  })
}

function clearWidths(table: HTMLTableElement, ths: HTMLTableCellElement[]) {
  table.style.tableLayout = ''
  table.style.maxWidth = ''
  table.style.width = ''
  for (const th of ths) th.style.width = ''
}

// The rows opened, closed; returned so they can be opened again
function closeRows(table: HTMLTableElement): Element[] {
  const rows = [...table.querySelectorAll('tr[data-open]')]
  for (const row of rows) row.removeAttribute('data-open')
  return rows
}

// The columns' widths and hidden cells of the table in ref, from prefs,
// written after every render (a draft being edited renders new rows), and
// what its header cells do
function useTableView(
  ref: RefObject<HTMLTableElement | null>,
  mode: TableMode,
  prefs: TablePrefs,
  update: Update,
  heads: HastNode[],
): TableView {
  const columns = heads.length
  const hidden = hiddenSet(prefs, columns)

  useLayoutEffect(() => {
    const table = ref.current as HTMLTableElement
    for (const row of table.rows) {
      for (const cell of row.cells) {
        cell.style.display = hidden.has(cell.cellIndex) ? 'none' : ''
      }
    }
    const ths = headerCells(table)
    const widths = prefs.widths?.[mode]
    if (widths?.length === ths.length) setWidths(table, ths, widths, hidden)
    else clearWidths(table, ths)
  })

  // The widths as they are now, fixed: from here on the columns keep them
  const freeze = (): number[] => {
    const table = ref.current as HTMLTableElement
    const ths = headerCells(table)
    const stored = prefs.widths?.[mode]
    // Set already, and laid out with them
    if (stored?.length === ths.length) return [...stored]
    const widths = ths.map((th, i) =>
      hidden.has(i)
        ? (stored?.[i] ?? DEFAULT_COL)
        : Math.max(MIN_COL, th.getBoundingClientRect().width),
    )
    setWidths(table, ths, widths, hidden)
    return widths
  }
  const save = (widths: number[]) =>
    update((p) => ({
      ...p,
      widths: { ...p.widths, [mode]: widths.map(Math.round) },
    }))

  return {
    columnOf: (node) => heads.indexOf(node as HastNode),
    widthOf: (col) => prefs.widths?.[mode]?.[col],
    canHide: columns - hidden.size > 1,
    hide: (col) =>
      update((p) => ({ ...p, hidden: [...(p.hidden ?? []), col] })),
    resizeBy: (col, delta) => {
      const widths = freeze()
      widths[col] = Math.max(MIN_COL, widths[col] + delta)
      save(widths)
    },
    startResize: (e, col) => {
      if (e.button !== 0) return
      e.preventDefault()
      e.stopPropagation()
      const handle = e.currentTarget
      const table = ref.current as HTMLTableElement
      const ths = headerCells(table)
      const widths = freeze()
      const startX = e.clientX
      const start = widths[col]
      handle.setPointerCapture?.(e.pointerId)
      const move = (m: globalThis.PointerEvent) => {
        widths[col] = Math.max(MIN_COL, start + m.clientX - startX)
        setWidths(table, ths, widths, hidden)
      }
      const end = () => {
        handle.removeEventListener('pointermove', move)
        handle.removeEventListener('pointerup', end)
        handle.removeEventListener('pointercancel', end)
        save(widths)
      }
      handle.addEventListener('pointermove', move)
      handle.addEventListener('pointerup', end)
      handle.addEventListener('pointercancel', end)
    },
  }
}

// Marks the cells of the table in ref cut short (data-clamped) while tall
// cells are clamped: measured again once its width changes (a column
// resized or hidden, the window), something in a cell loads or opens, or
// it renders again
function useCellClamp(
  ref: RefObject<HTMLTableElement | null>,
  clamping: boolean,
) {
  const schedule = useRef<() => void>(undefined)
  useEffect(() => {
    if (!clamping) return
    const table = ref.current as HTMLTableElement
    const detect = () => {
      // An open row's cells are not cut: measured closed, then opened again
      const open = closeRows(table)
      // Every height read before any is written: one layout, not one a cell
      const cells = [...table.querySelectorAll<HTMLElement>('[data-cell]')]
      const over = cells.map((c) => c.scrollHeight > c.clientHeight + 1)
      cells.forEach((c, i) => {
        c.toggleAttribute('data-clamped', over[i])
      })
      for (const row of open) row.setAttribute('data-open', '')
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const later = () => {
      clearTimeout(timer)
      timer = setTimeout(detect, DETECT_DELAY)
    }
    schedule.current = later
    detect()
    let width = table.clientWidth
    const ro =
      typeof ResizeObserver === 'undefined'
        ? undefined
        : new ResizeObserver(() => {
            // A row opening changes the height only
            if (Math.abs(table.clientWidth - width) < 1) return
            width = table.clientWidth
            later()
          })
    ro?.observe(table)
    // They do not bubble, but are seen on the way down
    const events = ['load', 'error', 'toggle']
    for (const type of events) table.addEventListener(type, later, true)
    return () => {
      // Every row is open while every cell shows: none stays open after
      closeRows(table)
      schedule.current = undefined
      clearTimeout(timer)
      ro?.disconnect()
      for (const type of events) table.removeEventListener(type, later, true)
    }
  }, [clamping, ref])
  useEffect(() => schedule.current?.())
}

// A click on a cut cell opens every cell of its row, so a record reads
// side by side; a click on a cell of an open row closes it
function toggleRow(e: MouseEvent<HTMLTableElement>, clamping: boolean) {
  if (!clamping) return
  const target = e.target as Element
  if (target.closest(INTERACTIVE)) return
  const cell = target.closest('[data-cell]')
  const row = cell?.closest('tr')
  if (!cell || !row) return
  const open = row.hasAttribute('data-open')
  if (!open && !cell.hasAttribute('data-clamped')) return
  // A click that ends selecting text in the cell leaves it as it is
  const selection = window.getSelection()
  if (
    selection &&
    !selection.isCollapsed &&
    cell.contains(selection.anchorNode)
  )
    return
  row.toggleAttribute('data-open')
}

function tableClass(expanded: boolean, unclamped: boolean) {
  return `md-table ${expanded ? 'md-expanded' : ''} ${unclamped ? 'md-unclamped' : ''}`
}

function ToolButton({
  label,
  pressed,
  onClick,
  children,
}: {
  label: string
  pressed?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      onClick={onClick}
      className={`inline-flex h-7 min-w-7 items-center justify-center gap-1 rounded-control border border-border bg-surface px-1.5 text-[12px] text-fg-muted transition-colors hover:bg-surface-raised hover:text-fg aria-pressed:text-accent pointer-coarse:h-9 pointer-coarse:min-w-9 ${FOCUS_RING}`}
    >
      {children}
    </button>
  )
}

// The tools both the table and its full screen show: hidden columns back,
// and every cell in full or cut
function SharedTools({
  hidden,
  unclamped,
  showColumns,
  toggleClamp,
}: {
  hidden: number
  unclamped: boolean
  showColumns: () => void
  toggleClamp: () => void
}) {
  const { t } = useT()
  return (
    <>
      {hidden > 0 && (
        <ToolButton
          label={t('files.markdown.table.showColumns', { count: hidden })}
          onClick={showColumns}
        >
          <Eye size={14} aria-hidden="true" />
          {hidden}
        </ToolButton>
      )}
      <ToolButton
        label={t('files.markdown.table.fullCells')}
        pressed={unclamped}
        onClick={toggleClamp}
      >
        {unclamped ? (
          <FoldVertical size={14} aria-hidden="true" />
        ) : (
          <UnfoldVertical size={14} aria-hidden="true" />
        )}
      </ToolButton>
    </>
  )
}

// The table in react-markdown's place: its tools above it, the box that
// scrolls it (where the line it starts on goes), and its full screen
export function MdTable({
  node,
  'data-line': dataLine,
  children,
  className: _,
  ...props
}: ComponentProps<'table'> & { node?: unknown; 'data-line'?: number }) {
  const { t } = useT()
  const { path } = useContext(PreviewContext)
  const heads = headerNodes(node as HastNode | undefined)
  const key = tableKey(path, headerTexts(node as HastNode | undefined))
  const [prefs, setPrefs] = useState(() => readTablePrefs(key))
  // Another file, or its header edited: that table's set-up
  const [shownKey, setShownKey] = useState(key)
  if (key !== shownKey) {
    setShownKey(key)
    setPrefs(readTablePrefs(key))
  }
  const prefsRef = useRef(prefs)
  prefsRef.current = prefs
  const update: Update = (change) => {
    const next = change(prefsRef.current)
    prefsRef.current = next
    setPrefs(next)
    writeTablePrefs(key, next)
  }
  const [full, setFull] = useState(false)

  const ref = useRef<HTMLTableElement>(null)
  const expanded = !!prefs.expanded
  const unclamped = !!prefs.unclamped
  const view = useTableView(
    ref,
    expanded ? 'expanded' : 'collapsed',
    prefs,
    update,
    heads,
  )
  useCellClamp(ref, !unclamped)
  const hidden = hiddenSet(prefs, heads.length).size

  const shared = (
    <SharedTools
      hidden={hidden}
      unclamped={unclamped}
      showColumns={() => update((p) => ({ ...p, hidden: undefined }))}
      toggleClamp={() => update((p) => ({ ...p, unclamped: !p.unclamped }))}
    />
  )

  return (
    <div className="group/table my-3" data-line={dataLine}>
      <div
        role="toolbar"
        aria-label={t('files.markdown.table.tools')}
        className={`mb-1 flex justify-end gap-1 transition-opacity group-hover/table:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100 ${expanded || unclamped || hidden ? 'opacity-100' : 'opacity-0'}`}
      >
        <ToolButton
          label={t('files.markdown.table.expand')}
          pressed={expanded}
          onClick={() => update((p) => ({ ...p, expanded: !p.expanded }))}
        >
          {expanded ? (
            <ChevronsRightLeft size={14} aria-hidden="true" />
          ) : (
            <ChevronsLeftRight size={14} aria-hidden="true" />
          )}
        </ToolButton>
        {shared}
        <ToolButton
          label={t('files.markdown.table.fullScreen')}
          onClick={() => setFull(true)}
        >
          <Maximize2 size={14} aria-hidden="true" />
        </ToolButton>
      </div>
      <div className="overflow-x-auto">
        <TableViewContext.Provider value={view}>
          <table
            {...props}
            ref={ref}
            className={tableClass(expanded, unclamped)}
            onClick={(e) => toggleRow(e, !unclamped)}
          >
            {children}
          </table>
        </TableViewContext.Provider>
      </div>
      <TableFullScreen
        isOpen={full}
        onClose={() => setFull(false)}
        title={t('files.markdown.table.title', {
          name: path.slice(path.lastIndexOf('/') + 1),
        })}
        prefs={prefs}
        update={update}
        heads={heads}
        tools={shared}
      >
        {children}
      </TableFullScreen>
    </div>
  )
}

interface FullScreenProps {
  isOpen: boolean
  onClose: () => void
  title: string
  prefs: TablePrefs
  update: Update
  heads: HastNode[]
  // The tools shared with the table in the preview
  tools: ReactNode
  // The table's rows
  children: ReactNode
}

// The table over the whole app, as wide as its cells: Back, X and Escape
// close it (its own history entry, as the image viewer's), and a link
// followed from it is followed once it has closed
function TableFullScreen({ isOpen, ...rest }: FullScreenProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const { mounted, closing } = useExitTransition(isOpen, dialogRef)
  if (!mounted) return null
  return <OpenFullScreen dialogRef={dialogRef} closing={closing} {...rest} />
}

function OpenFullScreen({
  dialogRef,
  closing,
  onClose,
  title,
  prefs,
  update,
  heads,
  tools,
  children,
}: Omit<FullScreenProps, 'isOpen'> & {
  dialogRef: RefObject<HTMLDialogElement | null>
  closing: boolean
}) {
  const { t } = useT()
  const preview = useContext(PreviewContext)
  const restoreFocus = useRestoreFocus()
  // A link clicked here, followed once the history entry is gone
  const pending = useRef<(() => void) | null>(null)
  const close = useHistoryClose(() => {
    onClose()
    const follow = pending.current
    pending.current = null
    follow?.()
  })
  useDialogModal(dialogRef, !closing, close)
  useEffect(() => {
    if (closing) restoreFocus()
  }, [closing, restoreFocus])

  const ref = useRef<HTMLTableElement>(null)
  const unclamped = !!prefs.unclamped
  const view = useTableView(ref, 'expanded', prefs, update, heads)
  useCellClamp(ref, !unclamped)
  const ctx = {
    ...preview,
    go: (target: LinkPath, newTab?: boolean) => {
      pending.current = () => preview.go(target, newTab)
      close()
    },
  }

  return (
    <dialog
      ref={dialogRef}
      aria-label={title}
      inert={closing}
      aria-hidden={closing || undefined}
      data-closing={closing || undefined}
      className={`fixed inset-0 z-50 m-0 h-(--app-height) max-h-none w-screen max-w-none flex-col overflow-hidden bg-bg p-0 text-fg outline-none open:flex backdrop:bg-overlay exit-discrete ease-standard starting:opacity-0 backdrop:exit-discrete backdrop:ease-standard backdrop:starting:opacity-0 ${closing ? 'pointer-events-none opacity-0 duration-(--duration-fast) backdrop:opacity-0 backdrop:duration-(--duration-fast)' : 'duration-(--duration-base) backdrop:duration-(--duration-base)'}`}
    >
      <div className="flex shrink-0 items-center gap-1 border-b border-border bg-surface pt-[env(safe-area-inset-top)] pl-3">
        <span className="min-w-0 flex-1 truncate text-[13px]">{title}</span>
        {tools}
        <IconButton
          onClick={close}
          aria-label={t('common.close')}
          title={t('common.close')}
        >
          <X size={18} aria-hidden="true" />
        </IconButton>
      </div>
      <div
        className="min-h-0 flex-1 overflow-auto pb-safe"
        data-testid="table-full-screen"
        data-native-menu
      >
        <div className={PROSE}>
          <PreviewContext.Provider value={ctx}>
            <TableViewContext.Provider value={view}>
              <table
                ref={ref}
                className={tableClass(true, unclamped)}
                onClick={(e) => toggleRow(e, !unclamped)}
              >
                {children}
              </table>
            </TableViewContext.Provider>
          </PreviewContext.Provider>
        </div>
      </div>
    </dialog>
  )
}

// A header cell: a button that hides its column, and its right edge to drag
// (or move with the arrow keys) for its width
export function MdTh({
  node,
  children,
  ...props
}: ComponentProps<'th'> & { node?: unknown }) {
  const { t } = useT()
  const view = useContext(TableViewContext)
  const col = view?.columnOf(node) ?? -1
  if (!view || col < 0) return <th {...props}>{children}</th>
  const name = textOf(node as HastNode).trim()
  return (
    <th {...props} className="group/th relative">
      {children}
      {view.canHide && (
        <button
          type="button"
          aria-label={t('files.markdown.table.hideColumn', { name })}
          title={t('files.markdown.table.hideColumn', { name })}
          onClick={() => view.hide(col)}
          className={`ml-1 inline-flex size-4 items-center justify-center rounded align-middle text-fg-muted opacity-0 group-hover/th:opacity-60 hover:bg-danger/10 hover:text-danger hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-60 ${FOCUS_RING}`}
        >
          <X size={12} aria-hidden="true" />
        </button>
      )}
      {/* biome-ignore lint/a11y/useSemanticElements: a focusable separator is the ARIA pattern for a resize handle, <hr> cannot take focus */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t('files.markdown.table.resizeColumn', { name })}
        aria-valuemin={MIN_COL}
        aria-valuenow={view.widthOf(col)}
        tabIndex={0}
        onPointerDown={(e) => view.startResize(e, col)}
        onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
          const step = { ArrowLeft: -KEY_STEP, ArrowRight: KEY_STEP }[e.key]
          if (!step) return
          e.preventDefault()
          view.resizeBy(col, step)
        }}
        className={`absolute inset-y-0 -right-0.5 z-1 w-1.5 cursor-col-resize touch-none select-none hover:bg-accent focus-visible:bg-accent pointer-coarse:-right-1.5 pointer-coarse:w-3 ${FOCUS_RING}`}
      />
    </th>
  )
}

// A body cell: its content in a box cut to a few lines while tall cells
// are clamped (index.css, .md-cell)
export function MdTd({
  node: _,
  children,
  ...props
}: ComponentProps<'td'> & { node?: unknown }) {
  const view = useContext(TableViewContext)
  if (!view) return <td {...props}>{children}</td>
  return (
    <td {...props}>
      <div className="md-cell" data-cell>
        {children}
      </div>
    </td>
  )
}
