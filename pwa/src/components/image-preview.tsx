import { type ReactNode, useState } from 'react'
import { filesError } from '../hooks/use-files'
import { type ImageState, imageErrorCode } from '../hooks/use-image-blob'
import { useImageViewer } from '../hooks/use-image-viewer'
import { RequestError } from '../hooks/use-mux-api'
import { formatSize } from '../utils/files-format'
import { visibleUnsafe } from '../utils/unsafe-chars'
import { ViewMessage } from './pane-dir-header'
import { Button } from './ui/button'

// Why an image cannot be shown, by the server's code
const CODES: Record<string, string> = {
  too_large: 'Larger than 10 MiB',
  too_many_pixels: 'Too many pixels to show (over 40 megapixels)',
  not_image: 'Not previewable (not a PNG, JPEG, GIF, WebP or SVG image)',
  lfs_pointer: 'Stored in Git LFS: only the pointer is in git',
  busy: 'Busy, try again',
  sensitive: 'This file may contain secrets',
}

const ERRORS = {
  'not-allowed': "This file can't be shown",
  'not-found': 'File not found',
  unsupported: 'Not supported by this backend',
  unavailable: 'Could not load the image',
}

const SVG_TYPE = 'image/svg+xml'

// Transparent parts show over a checkerboard, light or dark theme alike
const CHECKERBOARD = {
  background:
    'repeating-conic-gradient(rgb(128 128 128 / 0.2) 0 25%, transparent 0 50%) 0 0 / 16px 16px',
}

// Why a read failed: the server's code, else the files routes' reasons
export function imageErrorText(error: unknown, missing?: string): string {
  const code = error instanceof RequestError ? error.code : ''
  if (code === 'no_version' && missing) return missing
  return CODES[code] ?? ERRORS[filesError(error)]
}

interface Props {
  state: ImageState
  alt: string
  // Above the image: which version it is (Changes)
  label?: string
  // Shown when nothing is read (idle) or the server answers no_version:
  // the side has no such version (Added, Deleted)
  missing?: string
  // Reads the image again (offered when the server was busy)
  onRetry?: () => void
}

// One image read by useImageBlob: fit to the width over a checkerboard, with
// its pixel size and file size, or why it cannot be shown. Once decoded, a
// click (Enter, Space) opens it full screen.
export function ImagePreview({ state, alt, label, missing, onRetry }: Props) {
  // What the browser made of the current URL
  const [decoded, setDecoded] = useState<{
    url: string
    width?: number
    height?: number
    failed?: boolean
  }>()
  const url = state.status === 'ready' ? state.url : undefined
  const seen = decoded?.url === url ? decoded : undefined
  const { open, viewer } = useImageViewer(url)
  // A path can hold control or bidi characters: shown, never applied
  const title = visibleUnsafe(alt)

  let body: ReactNode
  if (state.status === 'idle') body = <ViewMessage>{missing}</ViewMessage>
  else if (state.status === 'loading')
    body = <ViewMessage>Loading…</ViewMessage>
  else if (state.status === 'error')
    body = (
      <ViewMessage>
        {imageErrorText(state.error, missing)}
        {imageErrorCode(state) === 'busy' && onRetry && (
          <Button size="sm" onClick={onRetry}>
            Retry
          </Button>
        )}
      </ViewMessage>
    )
  else if (seen?.failed)
    body = <ViewMessage>The image could not be decoded</ViewMessage>
  else
    body = (
      // A block, not a shrink-to-fit flex item: an SVG with only a viewBox
      // has no width of its own and would collapse to nothing; here it
      // fills the width, and a small bitmap keeps its own size
      <div className="p-2">
        <button
          type="button"
          // Decoded only: a broken or loading image has nothing to show
          disabled={!seen}
          aria-label={`Open ${title} full screen`}
          className="block w-full cursor-zoom-in text-left disabled:cursor-default"
          onClick={() =>
            open({
              src: state.url,
              alt: title,
              // An SVG with only a viewBox reports none: the viewer measures
              width: seen?.width || undefined,
              height: seen?.height || undefined,
              isSvg: state.type === SVG_TYPE,
            })
          }
        >
          <img
            src={state.url}
            alt={alt}
            decoding="async"
            aria-busy={state.stale}
            style={CHECKERBOARD}
            className={`block h-auto max-w-full ${state.stale ? 'opacity-60' : ''}`}
            onLoad={(e) =>
              setDecoded({
                url: state.url,
                width: e.currentTarget.naturalWidth,
                height: e.currentTarget.naturalHeight,
              })
            }
            onError={() => setDecoded({ url: state.url, failed: true })}
          />
        </button>
        <span className="mt-1 block text-[11px] text-fg-muted">
          {/* An SVG's pixel size is whatever the browser picks for it */}
          {seen?.width !== undefined &&
            state.type !== SVG_TYPE &&
            `${seen.width}×${seen.height} · `}
          {formatSize(state.size)}
        </span>
      </div>
    )

  return (
    <div className="flex min-w-0 flex-col" data-testid="image-preview">
      {label && (
        <div className="border-b border-border px-2 py-1 text-[11px] text-fg-muted">
          {label}
        </div>
      )}
      {body}
      {viewer}
    </div>
  )
}
