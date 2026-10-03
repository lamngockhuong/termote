// iPadOS 26 draws the window controls (close, minimize, resize) over the
// top-left corner of an app shown in a window, and reports no inset for them:
// env(safe-area-inset-*) stays 0 and the Window Controls Overlay API is not
// supported. So an installed app detects the window itself and marks <html>
// with data-ipad-window, which the ipad-window: variant in index.css reads.

interface WindowLike {
  innerWidth: number
  innerHeight: number
  screen: { width: number; height: number }
  navigator: Navigator & { standalone?: boolean }
  matchMedia?: (query: string) => MediaQueryList
}

export function isIPadWindowed(w: WindowLike): boolean {
  const nav = w.navigator
  // iPadOS reports a Mac user agent; touch points tell the two apart.
  const iPad =
    /iPad/.test(nav.userAgent) ||
    (/Macintosh/.test(nav.userAgent) && nav.maxTouchPoints > 1)
  // In Safari the browser's own bar sits under the controls, not the page.
  const standalone =
    nav.standalone === true ||
    w.matchMedia?.('(display-mode: standalone)').matches === true
  if (!iPad || !standalone) return false
  // Full screen, the page spans the screen side that matches its orientation
  // (screen.width/height stay in portrait on iPadOS); a window is narrower.
  const long = Math.max(w.screen.width, w.screen.height)
  const short = Math.min(w.screen.width, w.screen.height)
  const side = w.innerWidth > w.innerHeight ? long : short
  return w.innerWidth < side - 1
}

// Keeps data-ipad-window in step as the window is resized or rotated.
export function watchIPadWindow(w: Window = window): () => void {
  const update = () => {
    if (isIPadWindowed(w)) w.document.documentElement.dataset.ipadWindow = ''
    else delete w.document.documentElement.dataset.ipadWindow
  }
  update()
  w.addEventListener('resize', update)
  return () => w.removeEventListener('resize', update)
}
