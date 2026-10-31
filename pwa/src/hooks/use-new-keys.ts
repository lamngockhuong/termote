import { useRef } from 'react'

// Where an item added to a list enters from: a little lower, transparent.
// Only for items the list did not show at first (useNewKeys); the item's own
// transition has to take opacity and translate.
export const ENTER_FROM =
  'motion-safe:starting:translate-y-1 motion-safe:starting:opacity-0'

// Tells the items added to a list since it first showed something (or since
// resetKey changed: another conversation) from those it showed then, so only
// the new ones animate in. The list's first load is not new: a chat's
// history, a tree's first listing. isNew(key) is true for an added key.
export function useNewKeys(keys: readonly string[], resetKey?: unknown) {
  const shown = useRef<{ keys: Set<string> | null; reset: unknown }>({
    keys: null,
    reset: resetKey,
  })
  if (shown.current.reset !== resetKey)
    shown.current = { keys: null, reset: resetKey }
  // Empty is not shown yet: the first items are still loading
  if (shown.current.keys === null && keys.length > 0)
    shown.current.keys = new Set(keys)
  const first = shown.current.keys
  return (key: string) => first !== null && !first.has(key)
}
