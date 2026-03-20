import { useCallback } from 'react'
import { vibrate, canVibrate } from '../utils/haptic'

interface UseHapticOptions {
  enabled?: boolean
}

export function useHaptic(options: UseHapticOptions = {}) {
  const { enabled = true } = options

  const trigger = useCallback(
    (pattern: 'light' | 'medium' | 'heavy' | 'selection' = 'light') => {
      if (!enabled) return
      vibrate(pattern)
    },
    [enabled]
  )

  return {
    trigger,
    isSupported: canVibrate(),
  }
}
