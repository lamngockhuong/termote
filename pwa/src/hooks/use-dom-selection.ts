import { type RefObject, useEffect, useRef } from 'react'
import { recordSelection } from '../utils/pane-selection'

// Keeps text the user selects inside ref (a file shown read-only, the Chat
// transcript) as paneId's selection, for a prompt template's {{selection}}.
// The code editor reports its own (onSelectText): its DOM holds only the
// lines on screen. Off (paneId undefined) for a sensitive file shown.
// onSelect is told of each such selection too (the Chat's Quote button);
// the latest one given is called.
export function useDomSelection(
  ref: RefObject<HTMLElement | null>,
  paneId: string | undefined,
  source: string,
  onSelect?: (range: Range) => void,
) {
  const latest = useRef({ paneId, source, onSelect })
  latest.current = { paneId, source, onSelect }
  useEffect(() => {
    const onChange = () => {
      const { paneId, source, onSelect } = latest.current
      const sel = document.getSelection()
      const el = ref.current
      if (!paneId || !el || !sel || sel.isCollapsed || !sel.anchorNode) return
      // Both ends inside: a drag out of it would take other text too
      if (!el.contains(sel.anchorNode) || !el.contains(sel.focusNode)) return
      const anchor =
        sel.anchorNode instanceof Element
          ? sel.anchorNode
          : sel.anchorNode.parentElement
      if (anchor?.closest('.cm-editor')) return
      recordSelection(paneId, sel.toString(), source)
      onSelect?.(sel.getRangeAt(0))
    }
    document.addEventListener('selectionchange', onChange)
    return () => document.removeEventListener('selectionchange', onChange)
  }, [ref])
}
