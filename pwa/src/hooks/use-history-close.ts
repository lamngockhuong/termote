import { useCallback, useEffect, useRef } from 'react'

// A full-screen viewer that Back closes: while it is open, the history has
// one entry of its own on top, at the same URL (no hashchange), marked by an
// id in its state. Back (a gesture, a button, Android's) pops it and
// closes the viewer; closing it any other way takes the entry off again.

const KEY = 'termoteViewer'

// A back() of ours not answered by popstate yet
let closing = false
// The id of the entry of the viewer open now, if any
let openId: string | null = null
let nextId = 0
// Past this a popstate that never came no longer keeps viewers from opening
const CLOSING_FOR = 1000

function stateId(): unknown {
  return (window.history.state as Record<string, unknown> | null)?.[KEY]
}

function goBack() {
  closing = true
  const done = () => {
    closing = false
    clearTimeout(timer)
    window.removeEventListener('popstate', done)
  }
  const timer = setTimeout(done, CLOSING_FOR)
  window.addEventListener('popstate', done)
  window.history.back()
}

// For openers: a viewer just closed is still leaving the history; opening
// another now would push its entry before the old one is popped.
export function viewerClosing(): boolean {
  return closing
}

// For the app: the top entry is a viewer's, so the address must not be
// replaced there (Back would then land on another link).
export function viewerOnTop(): boolean {
  return typeof stateId() === 'string'
}

// For the app, at start and on popstate: an entry marked by a viewer that is
// not open (a reload while one was, Forward back onto a closed one's entry)
// loses its mark, so the address follows the screen there again.
export function dropStaleViewerEntry() {
  if (!viewerOnTop() || stateId() === openId) return
  const { [KEY]: _, ...rest } = window.history.state as Record<string, unknown>
  window.history.replaceState(rest, '')
}

// Pushes the viewer's entry on mount; calls onClose when it is popped.
// Returns the function that closes the viewer from inside (its X, Escape,
// Android's cancel): it pops the entry, and onClose follows from popstate.
export function useHistoryClose(onClose: () => void): () => void {
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  // The id while the entry is ours, null once it is gone
  const idRef = useRef<string | null>(null)

  useEffect(() => {
    // Unique within the page; the time tells it from a mark a reload left.
    // Not crypto.randomUUID: over plain HTTP (a LAN address) it is missing.
    const id = `${Date.now()}-${++nextId}`
    idRef.current = id
    openId = id
    window.history.pushState(
      { ...(window.history.state as object | null), [KEY]: id },
      '',
      window.location.href,
    )
    const onPop = () => {
      if (stateId() === id || idRef.current !== id) return
      idRef.current = null
      onCloseRef.current()
    }
    window.addEventListener('popstate', onPop)
    return () => {
      window.removeEventListener('popstate', onPop)
      if (openId === id) openId = null
      // Unmounted while its entry is still on top: take it off
      if (idRef.current === id && stateId() === id) goBack()
      idRef.current = null
    }
  }, [])

  return useCallback(() => {
    const id = idRef.current
    // Gone, or a back() of ours on its way: a second one would leave the page
    if (!id || closing) return
    if (stateId() === id) {
      goBack()
      return
    }
    // The entry is gone already (another navigation): just close
    idRef.current = null
    onCloseRef.current()
  }, [])
}
