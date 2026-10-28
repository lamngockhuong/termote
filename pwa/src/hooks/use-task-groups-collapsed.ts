import { useCallback, useState } from 'react'
import { isFocusWindow } from '../utils/focus-mode'

// Collapsed sections of the Tasks view, keyed by section id (script, make,
// user or a tool), kept per device.
const STORAGE_KEY = 'termote-task-groups-collapsed'

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

export function useTaskGroupsCollapsed() {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(load)

  const toggle = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = { ...prev }
      if (next[id]) delete next[id]
      else next[id] = true
      if (!isFocusWindow())
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
      return next
    })
  }, [])

  const isCollapsed = useCallback((id: string) => !!collapsed[id], [collapsed])

  return { isCollapsed, toggle }
}
