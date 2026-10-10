import { useEffect, useState } from 'react'

export function useKeyboardVisible() {
  const [isVisible, setIsVisible] = useState(false)
  const [keyboardHeight, setKeyboardHeight] = useState(0)
  // Height of the part of the page the keyboard leaves visible
  const [viewportHeight, setViewportHeight] = useState(0)
  // How far iOS has panned the visible part down the page: focusing a field
  // with the keyboard up moves what is visible, not the page
  const [viewportOffsetTop, setViewportOffsetTop] = useState(0)

  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return

    const handleResize = () => {
      // Keyboard is open when visual viewport height is less than window height
      const heightDiff = window.innerHeight - viewport.height
      const isKeyboardOpen = heightDiff > 150 // threshold to avoid false positives
      setIsVisible(isKeyboardOpen)
      setKeyboardHeight(isKeyboardOpen ? heightDiff : 0)
      setViewportHeight(viewport.height)
      setViewportOffsetTop(isKeyboardOpen ? viewport.offsetTop : 0)
    }

    viewport.addEventListener('resize', handleResize)
    viewport.addEventListener('scroll', handleResize)

    return () => {
      viewport.removeEventListener('resize', handleResize)
      viewport.removeEventListener('scroll', handleResize)
    }
  }, [])

  return { isVisible, keyboardHeight, viewportHeight, viewportOffsetTop }
}
