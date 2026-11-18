import { useEffect, useState } from 'react'
import { fetchFileImage, type ImageQuery, RequestError } from './use-mux-api'

// One image read through files/raw: the path and the version asked for
export interface ImageRequest extends ImageQuery {
  path: string
  // The Place the file is under (the Files view only)
  place?: string
}

export type ImageState =
  | { status: 'idle' }
  | { status: 'loading' }
  // stale: an earlier image, shown while the new read runs
  | { status: 'ready'; url: string; size: number; type: string; stale: boolean }
  | { status: 'error'; error: unknown }

const SVG_TYPE = 'image/svg+xml'
// The type of a blob: URL whose bytes are no image this page knows: an
// <img> still draws it, a tab opened on it downloads it
const OPAQUE_TYPE = 'application/octet-stream'

// Leading bytes of the raster types files/raw serves
const RASTER_MAGIC: { type: string; at: number; bytes: number[] }[] = [
  {
    type: 'image/png',
    at: 0,
    bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  },
  { type: 'image/jpeg', at: 0, bytes: [0xff, 0xd8, 0xff] },
  { type: 'image/gif', at: 0, bytes: [0x47, 0x49, 0x46, 0x38] }, // GIF8
  { type: 'image/webp', at: 8, bytes: [0x57, 0x45, 0x42, 0x50] }, // RIFF....WEBP
]
const HEAD_SIZE = 512

// The MIME essence of a Content-Type: lower case, parameters dropped
export function mimeEssence(type: string): string {
  return type.split(';', 1)[0].trim().toLowerCase()
}

async function readHead(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.slice(0, HEAD_SIZE).arrayBuffer())
}

function rasterTypeOf(head: Uint8Array): string | undefined {
  return RASTER_MAGIC.find(({ at, bytes }) =>
    bytes.every((b, i) => head[at + i] === b),
  )?.type
}

// Whether head starts like markup: a BOM and white space, then "<"
function looksLikeMarkup(head: Uint8Array): boolean {
  let i = head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf ? 3 : 0
  while (i < head.length && [0x20, 0x09, 0x0a, 0x0d].includes(head[i])) i++
  return head[i] === 0x3c
}

// How an image read is shown. The response's type is a hint and never
// the type of a blob: URL: a machine in Machines sets it, and a blob: URL
// of a document type (SVG, HTML, XML), opened in a tab of its own, is a
// document of this origin whose scripts run there. An SVG (by its type,
// its name or its bytes) becomes a data: URL; any other image a blob: URL
// of the raster type its bytes show, else of no document type at all.
export async function imageSource(
  blob: Blob,
  path: string,
): Promise<{ url: string; type: string } | { blob: Blob; type: string }> {
  const head = await readHead(blob)
  const raster = rasterTypeOf(head)
  if (
    !raster &&
    (mimeEssence(blob.type) === SVG_TYPE ||
      path.toLowerCase().endsWith('.svg') ||
      looksLikeMarkup(head))
  )
    return {
      url: await readDataUrl(new Blob([blob], { type: SVG_TYPE })),
      type: SVG_TYPE,
    }
  const type = raster ?? OPAQUE_TYPE
  return { blob: new Blob([blob], { type }), type }
}

// A data: URL of blob, for an SVG: opened in a tab of its own, a blob: SVG
// is a document of this origin whose scripts run there (the server's
// sandbox policy does not come with the blob); a data: document has an
// opaque origin.
function readDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

// The image as a blob: URL (the page's CSP allows img-src blob:, and only
// this page can make one of its own), an SVG as a data: URL (img-src
// data:), as imageSource decides. req null reads nothing. The request is
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
  const { root, reveal, side, staged, orig, place } = req ?? {}

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
      { paneId, place },
      path,
      { root, reveal, side, staged, orig },
      ctl.signal,
    )
      .then(async (blob) => ({
        size: blob.size,
        src: await imageSource(blob, path),
      }))
      .then(
        ({ size, src }) => {
          // A blob that arrives after cleanup makes no URL
          if (ctl.signal.aborted) return
          setState({
            status: 'ready',
            url: 'url' in src ? src.url : URL.createObjectURL(src.blob),
            size,
            type: src.type,
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
    place,
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
    if (url?.startsWith('blob:')) return () => URL.revokeObjectURL(url)
  }, [url])

  return state
}

// The server's code of a failed read ('' when none)
export function imageErrorCode(state: ImageState): string {
  return state.status === 'error' && state.error instanceof RequestError
    ? state.error.code
    : ''
}
