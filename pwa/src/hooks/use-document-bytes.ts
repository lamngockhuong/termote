import { useEffect, useState } from 'react'
import {
  type DocumentQuery,
  fetchFileDocument,
  RequestError,
} from './use-mux-api'

// One document read through files/document
export interface DocumentRequest extends DocumentQuery {
  path: string
  // The Place the file is under
  place?: string
}

export type DocumentBytes =
  | { status: 'idle' }
  | { status: 'loading' }
  // A Blob never changes: each read of its bytes (blob.arrayBuffer()) is a
  // new buffer a worker may take, so nothing transferred is ever kept here
  | { status: 'ready'; blob: Blob; size: number }
  | { status: 'error'; error: unknown }

// The bytes of the document req names. req null reads nothing. The request
// is compared by value, so a new object with the same fields reads nothing
// again; reloadKey changing does (Retry). A 409 goes to onRootChanged (the
// root prop follows).
export function useDocumentBytes(
  paneId: string,
  req: DocumentRequest | null,
  reloadKey: string,
  onRootChanged?: (root: string) => void,
): DocumentBytes {
  const [state, setState] = useState<DocumentBytes>(
    req ? { status: 'loading' } : { status: 'idle' },
  )
  const active = req !== null
  const path = req?.path ?? ''
  const { root, reveal, place } = req ?? {}

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey reads the file again
  useEffect(() => {
    if (!active) {
      setState({ status: 'idle' })
      return
    }
    const ctl = new AbortController()
    setState({ status: 'loading' })
    fetchFileDocument(
      { paneId, place },
      path,
      { root, reveal },
      ctl.signal,
    ).then(
      (blob) => {
        if (ctl.signal.aborted) return
        setState({ status: 'ready', blob, size: blob.size })
      },
      (error) => {
        // Includes the AbortError of the cleanup
        if (ctl.signal.aborted) return
        if (
          error instanceof RequestError &&
          error.status === 409 &&
          error.root &&
          onRootChanged
        ) {
          onRootChanged(error.root)
          return
        }
        setState({ status: 'error', error })
      },
    )
    return () => ctl.abort()
  }, [paneId, place, active, path, root, reveal, reloadKey, onRootChanged])

  return state
}

// The server's code of a failed read ('' when none)
export function documentErrorCode(state: DocumentBytes): string {
  return state.status === 'error' && state.error instanceof RequestError
    ? state.error.code
    : ''
}
