import { useCallback, useState } from 'react'

const MIN_SIZE = 6
const MAX_SIZE = 24
const DEFAULT_SIZE = 14
const STORAGE_KEY = 'terminal-font-size'

export function useFontSize() {
  const [fontSize, setFontSize] = useState(() => {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (!saved) return DEFAULT_SIZE
    const parsed = parseInt(saved, 10)
    // Handle NaN or out-of-range values
    return Number.isNaN(parsed) || parsed < MIN_SIZE || parsed > MAX_SIZE
      ? DEFAULT_SIZE
      : parsed
  })

  const increase = useCallback(() => {
    setFontSize((prev) => {
      const next = Math.min(prev + 2, MAX_SIZE)
      localStorage.setItem(STORAGE_KEY, String(next))
      return next
    })
  }, [])

  const decrease = useCallback(() => {
    setFontSize((prev) => {
      const next = Math.max(prev - 2, MIN_SIZE)
      localStorage.setItem(STORAGE_KEY, String(next))
      return next
    })
  }, [])

  const reset = useCallback(() => {
    localStorage.setItem(STORAGE_KEY, String(DEFAULT_SIZE))
    setFontSize(DEFAULT_SIZE)
  }, [])

  return { fontSize, increase, decrease, reset }
}
