import { Maximize2 } from 'lucide-react'
import {
  type FocusEvent,
  type KeyboardEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { WRAP_LINE_HEIGHT, WRAP_PAD_Y } from '../utils/table-columns'
import { FOCUS_RING } from './ui/button'

// Tallest the field grows to as it fits its value: 20 lines, as a wrapped
// cell's (leading-4, py-1.5); past it, it scrolls
const MAX_HEIGHT = 20 * WRAP_LINE_HEIGHT + 2 * WRAP_PAD_Y

// Where Tab takes the editing after a value is set
export type CellMove = 'next' | 'prev'

interface Props {
  // The cell's whole value (short, with no character it would hide)
  value: string
  // Names the field: its column and row
  label: string
  // Sets the cell to value, the same one included (nothing to change),
  // then moves on with Tab; save: Ctrl+S, the file is saved after it
  onCommit: (value: string, move?: CellMove, save?: boolean) => void
  onCancel: () => void
  // The value typed so far, to go on with in the cell sheet
  onExpand: (value: string) => void
}

// A cell of the table edited where it is (a fine pointer): Enter sets it,
// Shift+Enter or Alt+Enter breaks the line, Escape drops what was typed,
// Tab sets it and goes to the next cell. Leaving it any other way sets it,
// scrolled away (unmounted) included, as a spreadsheet does. It lies over
// the cell and the rows below, as tall as its value (MAX_HEIGHT at most),
// and never narrower than the cell: its parent is the cell, positioned (a
// group named edit, data-last in the last column, where it grows leftward
// so as not to widen the table).
export function InlineCellEditor({
  value,
  label,
  onCommit,
  onCancel,
  onExpand,
}: Props) {
  const [input, setInput] = useState(value)
  const box = useRef<HTMLTextAreaElement>(null)
  // Ended: set, dropped or taken to the sheet, never twice
  const done = useRef(false)
  // What unmounting sets: the last value typed, with the last onCommit
  const last = useRef({ input, onCommit })
  last.current = { input, onCommit }

  // Fits the field to the value typed: back to its least height, then as
  // tall as its lines (the cell's height at least, from min-h-full). On
  // the last rows the field reaches past the table: shrunk for a moment, it
  // would pull the grid's scroll up, so that scroll is put back.
  // biome-ignore lint/correctness/useExhaustiveDependencies: input changes the lines
  useLayoutEffect(() => {
    const field = box.current as HTMLTextAreaElement
    const grid = field.closest<HTMLElement>('[role="grid"]')
    const top = grid?.scrollTop ?? 0
    field.style.height = 'auto'
    field.style.height = `${Math.min(field.scrollHeight, MAX_HEIGHT)}px`
    if (grid) grid.scrollTop = top
  }, [input])

  useEffect(() => {
    box.current?.select()
    return () => {
      if (done.current) return
      done.current = true
      last.current.onCommit(last.current.input)
    }
  }, [])

  // keyed: ended by a key, the focus goes back to the grid around (and
  // from there to the cell); ended by leaving, it stays where it went
  const end = (then: () => void, keyed = false) => {
    if (done.current) return
    done.current = true
    if (keyed) box.current?.closest<HTMLElement>('[role="grid"]')?.focus()
    then()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // A key that ends a word being composed (IME) is the composer's
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
      e.preventDefault()
      end(() => onCommit(input), true)
    } else if (e.key === 'Escape') {
      // Not a maximized panel's Escape (side-panel.tsx)
      e.preventDefault()
      end(onCancel, true)
    } else if (e.key === 'Tab') {
      e.preventDefault()
      end(() => onCommit(input, e.shiftKey ? 'prev' : 'next'), true)
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault()
      end(() => onCommit(input, undefined, true), true)
    }
  }

  const onBlur = (e: FocusEvent<HTMLTextAreaElement>) => {
    // The window lost the focus (another app): the field keeps it
    if (document.activeElement === e.currentTarget) return
    end(() => onCommit(input))
  }

  return (
    <div className="absolute left-0 top-0 flex group-data-[last]/edit:left-auto group-data-[last]/edit:right-0 min-h-full w-full min-w-48 flex-col shadow-lg">
      <textarea
        ref={box}
        rows={1}
        aria-label={label}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
        autoFocus
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        className="block min-h-0 w-full grow resize-none border-0 bg-surface py-1.5 pl-2 pr-7 font-term text-[12px] leading-4 text-fg outline-2 outline-accent -outline-offset-2"
      />
      <button
        type="button"
        aria-label="Open in sheet"
        title="Open in sheet"
        // Tab is the field's: it sets the value and goes to the next cell
        tabIndex={-1}
        // The field keeps the focus: no blur sets the value first
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => end(() => onExpand(input))}
        className={`absolute right-0.5 top-0.5 flex h-6 w-6 items-center justify-center rounded-control text-fg-muted hover:bg-surface-raised hover:text-fg ${FOCUS_RING}`}
      >
        <Maximize2 size={12} aria-hidden="true" />
      </button>
    </div>
  )
}
