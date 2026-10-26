import { useCallback, useState } from 'react'
import { isFocusWindow } from '../utils/focus-mode'

const STORAGE_KEY = 'sidebar-collapsed'

export function useSidebarCollapsed() {
  const [isCollapsed, setIsCollapsed] = useState(
    () => localStorage.getItem(STORAGE_KEY) === 'true',
  )

  const toggle = useCallback(() => {
    setIsCollapsed((prev) => {
      const next = !prev
      if (!isFocusWindow()) localStorage.setItem(STORAGE_KEY, String(next))
      return next
    })
  }, [])

  return { isCollapsed, toggle }
}
