type HapticPattern = 'light' | 'medium' | 'heavy' | 'selection'

const PATTERNS: Record<HapticPattern, number | number[]> = {
  light: 10,
  medium: 25,
  heavy: 50,
  selection: [10, 30, 10],
}

export function vibrate(pattern: HapticPattern = 'light'): void {
  if (typeof navigator === 'undefined') return
  if (!('vibrate' in navigator)) return

  try {
    navigator.vibrate(PATTERNS[pattern])
  } catch {
    // Silently fail - some browsers throw on vibrate
  }
}

export function canVibrate(): boolean {
  return typeof navigator !== 'undefined' && 'vibrate' in navigator
}
