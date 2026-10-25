import {
  type ReactNode,
  type RefObject,
  Suspense,
  useCallback,
  useState,
} from 'react'
import { LazyBoundary } from '../components/lazy-boundary'
import { lazyRetry } from '../utils/lazy-retry'
import { viewerClosing } from './use-history-close'

// The viewer's code: loaded the first time an image is opened full screen
const LazyImageViewer = lazyRetry<ViewerProps>(
  () => import('../components/image-viewer'),
  'ImageViewer',
)

type ViewerProps = ViewerImage & {
  stale: boolean
  returnFocus?: RefObject<HTMLElement | null>
  actions?: (say: (message: string) => void) => ReactNode
  onClose: () => void
}

export interface ViewerImage {
  // The URL already on screen: the viewer never reads the image again
  src: string
  alt: string
  width?: number
  height?: number
  isSvg: boolean
}

// An image opened full screen from where it shows. src is the URL shown
// there now: once it changes (a blob: URL revoked for a new read, a diagram
// drawn again) a viewer still on the old one closes. viewer is null, so
// nothing is loaded, until one is opened. returnFocus takes focus on close
// when what opened the viewer is gone. actions: buttons for the viewer's
// bar, given the way to tell the user something there. failed: the viewer's
// code could not be loaded, so it closed; the next open or another src
// clears it.
export function useImageViewer(
  src: string | undefined,
  returnFocus?: RefObject<HTMLElement | null>,
  actions?: (say: (message: string) => void) => ReactNode,
) {
  const [shown, setShown] = useState<ViewerImage | null>(null)
  // The URL on screen when the viewer's code failed to load
  const [failure, setFailure] = useState<{ src: string | undefined } | null>(
    null,
  )
  const open = useCallback((image: ViewerImage) => {
    // The last one is still leaving the history: its back() would pop this
    if (viewerClosing()) return
    setFailure(null)
    setShown(image)
  }, [])
  const onFail = useCallback(() => {
    LazyImageViewer.retry()
    setShown(null)
    setFailure({ src })
  }, [src])
  const onClose = useCallback(() => setShown(null), [])
  const viewer = shown && (
    <LazyBoundary onError={onFail} fallback={() => null}>
      <Suspense fallback={null}>
        <LazyImageViewer
          {...shown}
          stale={shown.src !== src}
          returnFocus={returnFocus}
          actions={actions}
          onClose={onClose}
        />
      </Suspense>
    </LazyBoundary>
  )
  return { open, viewer, failed: !!failure && failure.src === src }
}
