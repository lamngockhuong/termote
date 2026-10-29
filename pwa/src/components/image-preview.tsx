import { type ReactNode, useCallback, useRef, useState } from 'react'
import { filesError } from '../hooks/use-files'
import { type ImageState, imageErrorCode } from '../hooks/use-image-blob'
import { useImageViewer } from '../hooks/use-image-viewer'
import { RequestError } from '../hooks/use-mux-api'
import { useT } from '../i18n/i18n-context'
import type { MessageKey } from '../i18n/messages/en'
import type { Translate } from '../i18n/translate'
import { formatSize } from '../utils/files-format'
import { visibleUnsafe } from '../utils/unsafe-chars'
import { ViewMessage } from './pane-dir-header'
import { Button } from './ui/button'

// Why an image cannot be shown, by the server's code
const CODES: Record<string, MessageKey> = {
  too_large: 'files.imagePreview.tooLarge',
  too_many_pixels: 'files.imagePreview.tooManyPixels',
  not_image: 'files.imagePreview.notImage',
  lfs_pointer: 'files.document.lfsPointer',
  busy: 'files.document.busy',
  sensitive: 'files.viewer.sensitive',
}

const ERRORS = {
  'not-allowed': 'files.viewer.notAllowed',
  'view-only': 'files.find.viewOnly',
  'not-found': 'files.delete.fileNotFound',
  unsupported: 'files.find.unsupported',
  unavailable: 'files.imagePreview.failed',
} as const satisfies Record<string, MessageKey>

const SVG_TYPE = 'image/svg+xml'

// Transparent parts show over a checkerboard, light or dark theme alike
const CHECKERBOARD = {
  background:
    'repeating-conic-gradient(rgb(128 128 128 / 0.2) 0 25%, transparent 0 50%) 0 0 / 16px 16px',
}

// Why a read failed: the server's code, else the files routes' reasons
export function imageErrorText(
  error: unknown,
  t: Translate<MessageKey>,
  missing?: string,
): string {
  const code = error instanceof RequestError ? error.code : ''
  if (code === 'no_version' && missing) return missing
  return t(CODES[code] ?? ERRORS[filesError(error)])
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
  const { t, locale } = useT()
  // What the browser made of the current URL
  const [decoded, setDecoded] = useState<{
    url: string
    width?: number
    height?: number
    failed?: boolean
  }>()
  const url = state.status === 'ready' ? state.url : undefined
  const seen = decoded?.url === url ? decoded : undefined
  // Takes focus when the image button goes (the new image could not be
  // decoded), whether it had focus then or the viewer it opened returns
  // focus later
  const rootRef = useRef<HTMLDivElement>(null)
  const { open, viewer, failed } = useImageViewer(url, rootRef)
  const keepFocus = useCallback(
    (el: HTMLButtonElement | null) => () => {
      if (document.activeElement === el) rootRef.current?.focus()
    },
    [],
  )
  // A path can hold control or bidi characters: shown, never applied
  const title = visibleUnsafe(alt)

  let body: ReactNode
  if (state.status === 'idle') body = <ViewMessage>{missing}</ViewMessage>
  else if (state.status === 'loading')
    body = <ViewMessage>{t('files.loading')}</ViewMessage>
  else if (state.status === 'error')
    body = (
      <ViewMessage>
        {imageErrorText(state.error, t, missing)}
        {imageErrorCode(state) === 'busy' && onRetry && (
          <Button size="sm" onClick={onRetry}>
            {t('files.search.retry')}
          </Button>
        )}
      </ViewMessage>
    )
  else if (seen?.failed)
    body = <ViewMessage>{t('files.imagePreview.undecodable')}</ViewMessage>
  else
    body = (
      // A block, not a shrink-to-fit flex item: an SVG with only a viewBox
      // has no width of its own and would collapse to nothing; here it
      // fills the width, and a small bitmap keeps its own size
      <div className="p-2">
        <button
          ref={keepFocus}
          type="button"
          // Decoded only: a broken or loading image has nothing to show. Not
          // disabled, which takes no focus: a viewer that closes because a
          // new image replaced this one returns focus here before it decodes
          aria-disabled={seen ? undefined : true}
          aria-label={t('files.imagePreview.open', { name: title })}
          className="block w-full cursor-zoom-in text-left aria-disabled:cursor-default"
          onClick={() =>
            seen &&
            open({
              src: state.url,
              alt: title,
              // An SVG with only a viewBox reports none: the viewer measures
              width: seen.width || undefined,
              height: seen.height || undefined,
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
          {formatSize(state.size, locale)}
        </span>
      </div>
    )

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      className="flex min-w-0 flex-col outline-none"
      data-testid="image-preview"
    >
      {label && (
        <div className="border-b border-border px-2 py-1 text-[11px] text-fg-muted">
          {label}
        </div>
      )}
      {body}
      {failed && (
        <p role="status" className="m-0 px-2 pb-2 text-[11px] text-fg-muted">
          {t('files.imagePreview.openFailed')}
        </p>
      )}
      {viewer}
    </div>
  )
}
