import { useCallback, useEffect, useRef, useState } from 'react'
import {
  fetchPaneText,
  PANE_TEXT_LINES,
  PANE_TEXT_MAX_LINES,
} from './use-mux-api'

export interface PaneTextState {
  text: string
  // server: the pane's history from the backend; buffer: what this page's
  // terminal holds (the screen only on Herdr)
  source: 'server' | 'buffer'
  loading: boolean
  // The server cut the oldest lines at its size limit
  truncated: boolean
  // More history can be asked for (up to PANE_TEXT_MAX_LINES)
  canLoadMore: boolean
  loadMore: () => void
}

// The text the Select text sheet shows (mounted only while open, one per
// pane): the pane's history when the server reads it (useServer), else, or
// when that read fails, the terminal's buffer. Unmounting aborts a read
// still running.
export function usePaneText({
  paneId,
  useServer,
  readBuffer,
}: {
  paneId: string | undefined
  useServer: boolean
  readBuffer: () => string
}): PaneTextState {
  const [state, setState] = useState<Omit<PaneTextState, 'loadMore'>>({
    text: '',
    source: 'buffer',
    loading: useServer && !!paneId,
    truncated: false,
    canLoadMore: false,
  })
  const [lines, setLines] = useState(PANE_TEXT_LINES)
  const readBufferRef = useRef(readBuffer)
  readBufferRef.current = readBuffer

  useEffect(() => {
    const fromBuffer = () =>
      setState({
        text: readBufferRef.current(),
        source: 'buffer',
        loading: false,
        truncated: false,
        canLoadMore: false,
      })
    if (!useServer || !paneId) {
      fromBuffer()
      return
    }
    const ctrl = new AbortController()
    setState((s) => ({ ...s, loading: true }))
    fetchPaneText(paneId, lines, ctrl.signal).then(
      (r) =>
        setState({
          text: r.text,
          source: 'server',
          loading: false,
          truncated: r.truncated,
          canLoadMore: !!r.more && lines < PANE_TEXT_MAX_LINES,
        }),
      () => {
        if (!ctrl.signal.aborted) fromBuffer()
      },
    )
    return () => ctrl.abort()
  }, [paneId, useServer, lines])

  const loadMore = useCallback(() => setLines(PANE_TEXT_MAX_LINES), [])
  return { ...state, loadMore }
}
