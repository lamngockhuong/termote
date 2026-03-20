import { useEffect, useState } from 'react'

export function useViewport() {
  const [viewportHeight, setViewportHeight] = useState(window.innerHeight)
  const [keyboardVisible, setKeyboardVisible] = useState(false)

  useEffect(() => {
    const handleResize = () => {
      const newHeight = window.visualViewport?.height ?? window.innerHeight
      setViewportHeight(newHeight)

      // Detect keyboard by comparing viewport to window height
      // Keyboard is typically >150px on mobile
      const heightDiff = window.innerHeight - newHeight
      setKeyboardVisible(heightDiff > 150)
    }

    // Initial check
    handleResize()

    // Listen for viewport changes
    window.visualViewport?.addEventListener('resize', handleResize)
    window.addEventListener('resize', handleResize)

    return () => {
      window.visualViewport?.removeEventListener('resize', handleResize)
      window.removeEventListener('resize', handleResize)
    }
  }, [])

  return { viewportHeight, keyboardVisible }
}
