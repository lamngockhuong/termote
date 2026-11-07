import { useEffect, useRef, useState } from 'react'
import { type FileBlame, fetchFileBlame, RequestError } from './use-mux-api'

// The file the blame is asked for: hash is the sha256 of the bytes shown
// (FileContent.hash), so the lines blamed are the lines on the screen
export interface BlameRequest {
  path: string
  hash: string
  root?: string
  reveal?: boolean
  // The Place the file is under
  place?: string
}

// Why there is no blame to show
export type BlameError =
  | 'not-repo'
  | 'not-tracked'
  | 'too-large'
  | 'timeout'
  | 'busy'
  // The file changed again right after it was read again
  | 'changing'
  | 'failed'

export type BlameState =
  | { status: 'off' }
  | { status: 'loading' }
  | { status: 'ready'; blame: FileBlame }
  | { status: 'error'; error: BlameError }

const CODES: Record<string, BlameError> = {
  not_repo: 'not-repo',
  not_tracked: 'not-tracked',
  too_large: 'too-large',
  busy: 'busy',
}

// A file_changed this soon after the last reads the file again no more: a
// file rewritten all the time (a log) would reload the view over and over
export const CHANGED_AGAIN_MS = 5000

function blameError(e: unknown): BlameError {
  if (!(e instanceof RequestError)) return 'failed'
  return CODES[e.code] ?? (e.status === 503 ? 'timeout' : 'failed')
}

// The blame of req, read again each time one of its fields changes (a new
// hash: the file was read again); req null reads nothing ('off'). A 409
// file_changed (the file is other bytes than those shown) goes to onChanged,
// which reads the file again; a 409 naming another root to onRootChanged.
// A read still running when req changes or the view unmounts is aborted.
export function useFileBlame(
  paneId: string,
  req: BlameRequest | null,
  onChanged: () => void,
  onRootChanged?: (root: string) => void,
): BlameState {
  const [state, setState] = useState<BlameState>(
    req ? { status: 'loading' } : { status: 'off' },
  )
  const active = req !== null
  const { path, hash, root, reveal, place } = req ?? {}
  // When file_changed last read the file again
  const changedAt = useRef(0)

  // biome-ignore lint/correctness/useExhaustiveDependencies: the callbacks are read when an answer comes, not a reason to read again
  useEffect(() => {
    if (!active) {
      setState({ status: 'off' })
      return
    }
    const ctl = new AbortController()
    setState({ status: 'loading' })
    fetchFileBlame(
      { paneId, place },
      path as string,
      { hash: hash as string, root, reveal },
      ctl.signal,
    ).then(
      (res) => {
        if (ctl.signal.aborted) return
        // A sensitive file not shown has no blame either
        setState(
          'sensitive' in res
            ? { status: 'off' }
            : { status: 'ready', blame: res },
        )
      },
      (e) => {
        // Includes the AbortError of the cleanup
        if (ctl.signal.aborted) return
        if (e instanceof RequestError && e.status === 409) {
          if (e.code === 'file_changed') {
            const now = Date.now()
            if (now - changedAt.current >= CHANGED_AGAIN_MS) {
              changedAt.current = now
              onChanged()
              return
            }
            setState({ status: 'error', error: 'changing' })
            return
          }
          if (e.root && onRootChanged) {
            onRootChanged(e.root)
            return
          }
        }
        setState({ status: 'error', error: blameError(e) })
      },
    )
    return () => ctl.abort()
  }, [paneId, place, active, path, hash, root, reveal])

  return state
}
