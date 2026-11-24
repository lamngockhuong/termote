import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionGroup } from '../types/session'
import { setCurrentMachineForTest } from '../utils/api-base'
import { setFocusWindowForTest } from '../utils/focus-mode'
import * as hidden from '../utils/hidden-workspaces'
import { hiddenKey } from '../utils/hidden-workspaces'
import {
  HIDDEN_STORAGE_KEY,
  useHiddenWorkspaces,
} from './use-hidden-workspaces'

const M = '0123456789abcdef'
const saved = () => JSON.parse(localStorage.getItem(HIDDEN_STORAGE_KEY)!)

const api: SessionGroup = { id: '$1', name: 'api' }
const web: SessionGroup = { id: '$2', name: 'web' }
const fix: SessionGroup = {
  id: '$3',
  name: 'web-fix',
  worktree: { linked: true, parent: '$2' },
}

function render(groups: SessionGroup[]) {
  return renderHook(({ g }) => useHiddenWorkspaces(g), {
    initialProps: { g: groups },
  })
}

describe('useHiddenWorkspaces', () => {
  let close: ReturnType<typeof vi.spyOn>
  let write: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    localStorage.clear()
    close = vi
      .spyOn(hidden, 'closeHiddenNotifications')
      .mockResolvedValue(undefined)
    write = vi.spyOn(hidden, 'writeHiddenForWorker').mockResolvedValue()
  })
  afterEach(() => {
    vi.restoreAllMocks()
    setCurrentMachineForTest('')
    setFocusWindowForTest(false)
  })

  it('hides a group by name, saves it and closes its notifications', () => {
    const { result } = render([api, web])
    expect(result.current.hiddenIds.size).toBe(0)
    act(() => result.current.hide(api))
    expect([...result.current.hiddenIds]).toEqual(['$1'])
    expect(saved()).toEqual([hiddenKey('', 'api')])
    expect(close).toHaveBeenCalledWith('$1', '')
    expect(write).toHaveBeenLastCalledWith([hiddenKey('', 'api')])
    // Hiding it again changes nothing
    act(() => result.current.hide(api))
    expect(result.current.keys).toHaveLength(1)
  })

  it('keys a group on the open machine by its id', () => {
    setCurrentMachineForTest(M)
    const { result } = render([api])
    act(() => result.current.hide(api))
    expect(result.current.machineId).toBe(M)
    expect(saved()).toEqual([hiddenKey(M, 'api')])
  })

  it('restores the saved list, survives a renumbered id', () => {
    localStorage.setItem(
      HIDDEN_STORAGE_KEY,
      JSON.stringify([hiddenKey('', 'api')]),
    )
    const { result } = render([{ id: '$9', name: 'api' }, web])
    expect([...result.current.hiddenIds]).toEqual(['$9'])
  })

  it('reads a corrupt or unreadable list as none', () => {
    localStorage.setItem(HIDDEN_STORAGE_KEY, '{oops')
    expect(render([api]).result.current.keys).toEqual([])
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(render([api]).result.current.keys).toEqual([])
  })

  it('keeps the list for the page when storage refuses it', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    const { result } = render([api])
    act(() => result.current.hide(api))
    expect([...result.current.hiddenIds]).toEqual(['$1'])
  })

  it('saves nothing in a focus window', () => {
    setFocusWindowForTest(true)
    const { result } = render([api])
    act(() => result.current.hide(api))
    expect([...result.current.hiddenIds]).toEqual(['$1'])
    expect(localStorage.getItem(HIDDEN_STORAGE_KEY)).toBeNull()
  })

  it('unhides a group, and a worktree with its checkout', () => {
    const { result } = render([api, web, fix])
    act(() => result.current.hide(api))
    act(() => result.current.hide(web))
    expect([...result.current.hiddenIds].sort()).toEqual(['$1', '$2', '$3'])
    act(() => result.current.unhide(fix))
    expect([...result.current.hiddenIds]).toEqual(['$1'])
    act(() => result.current.unhide(api))
    expect(saved()).toEqual([])
  })

  it('forgets a name a new workspace takes', () => {
    const { result } = render([api])
    act(() => result.current.hide(api))
    act(() => result.current.forgetName(' api '))
    expect(result.current.keys).toEqual([])
    act(() => result.current.forgetName('other'))
    expect(result.current.keys).toEqual([])
  })

  it('shows the hidden ones for a while, without saving that', () => {
    const { result } = render([api])
    act(() => result.current.hide(api))
    act(() => result.current.reveal())
    expect(result.current.revealed).toBe(true)
    // Still hidden for notifications
    expect(result.current.hiddenIds.size).toBe(1)
    act(() => result.current.rehide())
    expect(result.current.revealed).toBe(false)
    expect(render([api]).result.current.revealed).toBe(false)
  })

  it('follows a hidden group renamed while the page is open', () => {
    const { result, rerender } = render([api, web])
    act(() => result.current.hide(api))
    // An empty list (reconnecting) leaves the names it knows
    rerender({ g: [] })
    rerender({ g: [{ id: '$1', name: 'backend' }, web] })
    expect(result.current.keys).toEqual([hiddenKey('', 'backend')])
    expect([...result.current.hiddenIds]).toEqual(['$1'])
    // A group that was not hidden renamed: nothing moves
    rerender({
      g: [
        { id: '$1', name: 'backend' },
        { id: '$2', name: 'www' },
      ],
    })
    expect(result.current.keys).toEqual([hiddenKey('', 'backend')])
  })

  it('moves nothing when the old name is still open under another id', () => {
    const { result, rerender } = render([api, web])
    act(() => result.current.hide(api))
    // tmux numbered its sessions anew: the ids swapped names
    rerender({
      g: [
        { id: '$1', name: 'web' },
        { id: '$2', name: 'api' },
      ],
    })
    expect(result.current.keys).toEqual([hiddenKey('', 'api')])
    expect([...result.current.hiddenIds]).toEqual(['$2'])
  })

  it("takes another tab's change to the list", () => {
    const { result } = render([api, web])
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: HIDDEN_STORAGE_KEY,
          newValue: JSON.stringify([hiddenKey('', 'web')]),
        }),
      )
    })
    expect([...result.current.hiddenIds]).toEqual(['$2'])
    const keys = result.current.keys
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: HIDDEN_STORAGE_KEY,
          newValue: JSON.stringify([hiddenKey('', 'web')]),
        }),
      )
      window.dispatchEvent(new StorageEvent('storage', { key: 'other' }))
    })
    expect(result.current.keys).toBe(keys)
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: HIDDEN_STORAGE_KEY,
          newValue: null,
        }),
      )
    })
    expect(result.current.keys).toEqual([])
  })
})
