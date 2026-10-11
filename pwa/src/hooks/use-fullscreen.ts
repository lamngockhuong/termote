import { useCallback, useEffect, useState } from 'react'

export function useFullscreen() {
  const [isFullscreen, setIsFullscreen] = useState(!!document.fullscreenElement)
  // Both checks: iPhone has neither (only a video can go fullscreen), and an
  // iframe without allow="fullscreen" has the method but fullscreenEnabled false
  const [isSupported] = useState(
    () =>
      document.fullscreenEnabled === true &&
      typeof document.documentElement.requestFullscreen === 'function',
  )

  useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', handler)
    return () => document.removeEventListener('fullscreenchange', handler)
  }, [])

  const toggleFullscreen = useCallback(() => {
    if (!isSupported) return
    if (document.fullscreenElement) {
      document
        .exitFullscreen()
        .catch((e) => console.warn('Fullscreen exit failed:', e))
    } else {
      document.documentElement
        .requestFullscreen()
        .catch((e) => console.warn('Fullscreen request denied:', e))
    }
  }, [isSupported])

  return { isFullscreen, isSupported, toggleFullscreen }
}
