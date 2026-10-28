import { compareVersions } from '../hooks/use-update-check'

// Page version this browser last ran, to tell an update from a first visit
export const SEEN_VERSION_KEY = 'termote-seen-version'

// 'pending' after an update until the star card is followed or closed, then
// 'done' for good: the card asks once, whatever updates come later.
export const STAR_PROMPT_KEY = 'termote-star-prompt'

const STABLE = /^\d+\.\d+\.\d+$/

function readKey(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeKey(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Storage unavailable: no prompt, and nothing kept to ask about later.
  }
}

/**
 * Keeps the page version and marks the star prompt pending when it rose
 * from an earlier stable version: after an update the reloaded page carries
 * the new one. A first visit, the same version, a downgrade or a pre-release
 * asks nothing.
 */
export function recordVersion(current: string): void {
  const seen = readKey(SEEN_VERSION_KEY)
  if (seen === current) return
  writeKey(SEEN_VERSION_KEY, current)
  if (
    seen &&
    STABLE.test(seen) &&
    STABLE.test(current) &&
    compareVersions(current, seen) > 0 &&
    readKey(STAR_PROMPT_KEY) !== 'done'
  ) {
    writeKey(STAR_PROMPT_KEY, 'pending')
  }
}

export function isStarPromptPending(): boolean {
  return readKey(STAR_PROMPT_KEY) === 'pending'
}

export function finishStarPrompt(): void {
  writeKey(STAR_PROMPT_KEY, 'done')
}
