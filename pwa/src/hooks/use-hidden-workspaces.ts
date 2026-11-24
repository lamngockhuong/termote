import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SessionGroup } from '../types/session'
import { currentMachine } from '../utils/api-base'
import { isFocusWindow } from '../utils/focus-mode'
import {
  closeHiddenNotifications,
  hiddenGroupIds,
  hiddenKey,
  renameHiddenKey,
  resolveHiddenKeys,
  writeHiddenForWorker,
} from '../utils/hidden-workspaces'

// Workspaces hidden on this browser (utils/hidden-workspaces.ts). The list
// is kept per browser, for every machine; showing them for a while (reveal)
// lasts until rehide or the page loads again.
export const HIDDEN_STORAGE_KEY = 'termote-hidden-workspaces'

function parse(raw: string | null): string[] {
  try {
    return resolveHiddenKeys(raw ? JSON.parse(raw) : [])
  } catch {
    return []
  }
}

function load(): string[] {
  try {
    return parse(localStorage.getItem(HIDDEN_STORAGE_KEY))
  } catch {
    return []
  }
}

function save(keys: string[]) {
  // A focus window keeps nothing on the device
  if (isFocusWindow()) return
  try {
    localStorage.setItem(HIDDEN_STORAGE_KEY, JSON.stringify(keys))
  } catch {
    // Storage refused (private window, quota): the list lasts this page
  }
}

function sameKeys(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && a.every((k, i) => k === b[i])
}

export function useHiddenWorkspaces(groups: readonly SessionGroup[]) {
  // Switching machine loads the page again
  const [machineId] = useState(currentMachine)
  const [keys, setKeys] = useState<string[]>(load)
  const [revealed, setRevealed] = useState(false)

  const update = useCallback((change: (prev: string[]) => string[]) => {
    setKeys((prev) => {
      const next = change(prev)
      if (sameKeys(prev, next)) return prev
      save(next)
      return next
    })
  }, [])

  const hide = useCallback(
    (group: SessionGroup) => {
      const key = hiddenKey(machineId, group.name)
      update((prev) => (prev.includes(key) ? prev : [...prev, key]))
      // Its linked worktrees are hidden with it
      for (const g of [
        group,
        ...groups.filter((w) => w.worktree?.parent === group.id),
      ]) {
        void closeHiddenNotifications(g.id, machineId)
      }
    },
    [groups, machineId, update],
  )

  // A linked worktree hidden with its repository checkout is shown again
  // with it.
  const unhide = useCallback(
    (group: SessionGroup) => {
      const parent = groups.find((g) => g.id === group.worktree?.parent)
      const drop = new Set(
        [group, ...(parent ? [parent] : [])].map((g) =>
          hiddenKey(machineId, g.name),
        ),
      )
      update((prev) => prev.filter((k) => !drop.has(k)))
    },
    [groups, machineId, update],
  )

  // A workspace created with a hidden one's name is shown. No name (a
  // herdr-core space takes its folder's): nothing to forget.
  const forgetName = useCallback(
    (name: string) => {
      if (!name.trim()) return
      const key = hiddenKey(machineId, name)
      update((prev) => prev.filter((k) => k !== key))
    },
    [machineId, update],
  )

  // A group renamed from this page: its key follows the new name, also
  // where the name is the id (a Zellij session's id is its name, encoded)
  const rename = useCallback(
    (oldName: string | undefined, newName: string) => {
      if (oldName === undefined) return
      update((prev) => renameHiddenKey(prev, machineId, oldName, newName))
    },
    [machineId, update],
  )

  const reveal = useCallback(() => setRevealed(true), [])
  const rehide = useCallback(() => setRevealed(false), [])

  // A hidden group renamed while this page is open (here, by tmux
  // rename-session, in herdr-app, or an unnamed hc session following its
  // folder) keeps its id: the key follows the new name. Only between two
  // reads of the same ids: tmux started again numbers its sessions anew
  // from $0, so an id that came back, or a list that changed meanwhile
  // (emptied, restored one by one), is no rename. Nor while the old name is
  // still open under another id.
  const lastNames = useRef<Map<string, string> | null>(null)
  useEffect(() => {
    const before = lastNames.current
    lastNames.current = groups.length
      ? new Map(groups.map((g) => [g.id, g.name]))
      : null
    if (
      !before ||
      before.size !== groups.length ||
      groups.some((g) => !before.has(g.id))
    )
      return
    const open = new Set(groups.map((g) => hiddenKey(machineId, g.name)))
    update((prev) => {
      let next = prev
      for (const g of groups) {
        const old = before.get(g.id)
        if (old === undefined || old === g.name) continue
        if (open.has(hiddenKey(machineId, old))) continue
        next = renameHiddenKey(next, machineId, old, g.name)
      }
      return next
    })
  }, [groups, machineId, update])

  // Another tab of this browser changed the list
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== HIDDEN_STORAGE_KEY) return
      const next = parse(e.newValue)
      setKeys((prev) => (sameKeys(prev, next) ? prev : next))
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  // The worker leaves these names out of a push shown while no page is open
  useEffect(() => {
    void writeHiddenForWorker(keys)
  }, [keys])

  // Hidden whether or not they are shown for a while: notifications leave
  // their names out either way.
  const hiddenIds = useMemo(
    () => hiddenGroupIds(groups, keys, machineId),
    [groups, keys, machineId],
  )

  return {
    keys,
    machineId,
    revealed,
    hiddenIds,
    hide,
    unhide,
    forgetName,
    rename,
    reveal,
    rehide,
  }
}
