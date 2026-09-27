import { useCallback, useState } from 'react'

// Collapsed state of each sidebar group, keyed by group id. Separate from
// use-sidebar-collapsed, which folds the whole sidebar.
const STORAGE_KEY = 'termote-group-collapsed'

function load(): Record<string, boolean> {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    const parsed = stored && JSON.parse(stored)
    if (parsed && typeof parsed === 'object') return parsed
  } catch {
    // ignore
  }
  return {}
}

export function useGroupCollapsed() {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(load)

  const toggle = useCallback((groupId: string) => {
    setCollapsed((prev) => {
      const next = { ...prev }
      if (next[groupId]) delete next[groupId]
      else next[groupId] = true
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
      return next
    })
  }, [])

  const isCollapsed = useCallback(
    (groupId: string) => !!collapsed[groupId],
    [collapsed],
  )

  return { isCollapsed, toggle }
}
