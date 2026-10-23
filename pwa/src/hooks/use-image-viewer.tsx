import {
  lazy,
  type ReactNode,
  type RefObject,
  Suspense,
  useCallback,
  useState,
} from 'react'
import { viewerClosing } from './use-history-close'

// The viewer's code: loaded the first time an image is opened full screen
const LazyImageViewer = lazy(() => import('../components/image-viewer'))

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
// bar, given the way to tell the user something there.
export function useImageViewer(
  src: string | undefined,
  returnFocus?: RefObject<HTMLElement | null>,
  actions?: (say: (message: string) => void) => ReactNode,
) {
  const [shown, setShown] = useState<ViewerImage | null>(null)
  const open = useCallback((image: ViewerImage) => {
    // The last one is still leaving the history: its back() would pop this
    if (!viewerClosing()) setShown(image)
  }, [])
  const onClose = useCallback(() => setShown(null), [])
  const viewer = shown && (
    <Suspense fallback={null}>
      <LazyImageViewer
        {...shown}
        stale={shown.src !== src}
        returnFocus={returnFocus}
        actions={actions}
        onClose={onClose}
      />
    </Suspense>
  )
  return { open, viewer }
}
