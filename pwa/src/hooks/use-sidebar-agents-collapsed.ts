import { useCallback, useState } from 'react'

const STORAGE_KEY = 'sidebar-agents-collapsed'

// Whether the compact sidebar's Agents section is folded to its title, kept
// on this device. Storage that cannot be read or written (a private window,
// blocked site data) leaves it open and the choice for this page only.
export function useSidebarAgentsCollapsed() {
  const [isCollapsed, setIsCollapsed] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === 'true'
    } catch {
      return false
    }
  })

  const toggle = useCallback(() => {
    setIsCollapsed((prev) => {
      const next = !prev
      try {
        localStorage.setItem(STORAGE_KEY, String(next))
      } catch {
        // kept for this page only
      }
      return next
    })
  }, [])

  return { isCollapsed, toggle }
}
