import { useEffect, useState } from 'react'
import { fetchFileImage, type ImageQuery, RequestError } from './use-mux-api'

// One image read through files/raw: the path and the version asked for
export interface ImageRequest extends ImageQuery {
  path: string
}

export type ImageState =
  | { status: 'idle' }
  | { status: 'loading' }
  // stale: an earlier image, shown while the new read runs
  | { status: 'ready'; url: string; size: number; stale: boolean }
  | { status: 'error'; error: unknown }

// The image as a blob: URL (the page's CSP allows img-src blob:, and only
// this page can make one of its own). req null reads nothing. The request is
// compared by value, so a new object with the same fields reads nothing
// again; reloadKey changing does. A read again keeps the earlier image until
// the new one is ready, and every URL made is revoked once replaced or
// unmounted. A 409 goes to onRootChanged (the root prop follows).
export function useImageBlob(
  paneId: string,
  req: ImageRequest | null,
  reloadKey: string,
  onRootChanged?: (root: string) => void,
): ImageState {
  const [state, setState] = useState<ImageState>(
    req ? { status: 'loading' } : { status: 'idle' },
  )
  const active = req !== null
  const path = req?.path ?? ''
  const { root, reveal, side, staged, orig } = req ?? {}

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey reads the image again
  useEffect(() => {
    if (!active) {
      setState({ status: 'idle' })
      return
    }
    const ctl = new AbortController()
    setState((s) =>
      s.status === 'ready' ? { ...s, stale: true } : { status: 'loading' },
    )
    fetchFileImage(
      paneId,
      path,
      { root, reveal, side, staged, orig },
      ctl.signal,
    ).then(
      (blob) => {
        // A blob that arrives after cleanup makes no URL
        if (ctl.signal.aborted) return
        setState({
          status: 'ready',
          url: URL.createObjectURL(blob),
          size: blob.size,
          stale: false,
        })
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
  }, [
    paneId,
    active,
    path,
    root,
    reveal,
    side,
    staged,
    orig,
    reloadKey,
    onRootChanged,
  ])

  // Revoked once the state no longer shows it: after the new image (or the
  // error) is committed, never before, so the image does not break while the
  // next one loads
  const url = state.status === 'ready' ? state.url : undefined
  useEffect(() => {
    if (url) return () => URL.revokeObjectURL(url)
  }, [url])

  return state
}

// The server's code of a failed read ('' when none)
export function imageErrorCode(state: ImageState): string {
  return state.status === 'error' && state.error instanceof RequestError
    ? state.error.code
    : ''
}
