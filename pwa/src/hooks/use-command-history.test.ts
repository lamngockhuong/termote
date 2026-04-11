import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Reset module state between tests by re-importing fresh each time
async function importHook() {
  const mod = await import('./use-command-history')
  return mod.useCommandHistory
}

describe('useCommandHistory', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.resetModules()
  })

  it('starts with empty history', async () => {
    const useCommandHistory = await importHook()
    const { result } = renderHook(() => useCommandHistory())
    expect(result.current.history).toEqual([])
  })

  it('loads history from localStorage on init', async () => {
    const stored = [{ id: 'abc', text: 'ls -la', timestamp: 1000 }]
    localStorage.setItem('termote-command-history', JSON.stringify(stored))
    const useCommandHistory = await importHook()
    const { result } = renderHook(() => useCommandHistory())
    expect(result.current.history).toHaveLength(1)
    expect(result.current.history[0].text).toBe('ls -la')
  })

  it('handles corrupt localStorage gracefully', async () => {
    localStorage.setItem('termote-command-history', 'not-json')
    const useCommandHistory = await importHook()
    const { result } = renderHook(() => useCommandHistory())
    expect(result.current.history).toEqual([])
  })

  it('addCommand adds a new command', async () => {
    const useCommandHistory = await importHook()
    const { result } = renderHook(() => useCommandHistory())
    act(() => { result.current.addCommand('git status') })
    expect(result.current.history).toHaveLength(1)
    expect(result.current.history[0].text).toBe('git status')
  })

  it('addCommand ignores empty or whitespace-only strings', async () => {
    const useCommandHistory = await importHook()
    const { result } = renderHook(() => useCommandHistory())
    act(() => { result.current.addCommand('') })
    act(() => { result.current.addCommand('   ') })
    expect(result.current.history).toHaveLength(0)
  })

  it('addCommand trims whitespace from command', async () => {
    const useCommandHistory = await importHook()
    const { result } = renderHook(() => useCommandHistory())
    act(() => { result.current.addCommand('  git log  ') })
    expect(result.current.history[0].text).toBe('git log')
  })

  it('addCommand deduplicates — moves existing command to top', async () => {
    const useCommandHistory = await importHook()
    const { result } = renderHook(() => useCommandHistory())
    act(() => { result.current.addCommand('ls') })
    act(() => { result.current.addCommand('pwd') })
    act(() => { result.current.addCommand('ls') })
    expect(result.current.history).toHaveLength(2)
    expect(result.current.history[0].text).toBe('ls')
  })

  it('addCommand persists to localStorage', async () => {
    const useCommandHistory = await importHook()
    const { result } = renderHook(() => useCommandHistory())
    act(() => { result.current.addCommand('echo hello') })
    const stored = JSON.parse(localStorage.getItem('termote-command-history')!)
    expect(stored[0].text).toBe('echo hello')
  })

  it('addCommand assigns a unique id', async () => {
    const useCommandHistory = await importHook()
    const { result } = renderHook(() => useCommandHistory())
    act(() => { result.current.addCommand('cmd1') })
    act(() => { result.current.addCommand('cmd2') })
    const ids = result.current.history.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('addCommand stores timestamp', async () => {
    const now = Date.now()
    const useCommandHistory = await importHook()
    const { result } = renderHook(() => useCommandHistory())
    act(() => { result.current.addCommand('date') })
    expect(result.current.history[0].timestamp).toBeGreaterThanOrEqual(now)
  })

  it('removeCommand removes entry by id', async () => {
    const useCommandHistory = await importHook()
    const { result } = renderHook(() => useCommandHistory())
    act(() => { result.current.addCommand('rm -rf /tmp/test') })
    const id = result.current.history[0].id
    act(() => { result.current.removeCommand(id) })
    expect(result.current.history).toHaveLength(0)
  })

  it('removeCommand persists removal to localStorage', async () => {
    const useCommandHistory = await importHook()
    const { result } = renderHook(() => useCommandHistory())
    act(() => { result.current.addCommand('cat /etc/hosts') })
    const id = result.current.history[0].id
    act(() => { result.current.removeCommand(id) })
    const stored = JSON.parse(localStorage.getItem('termote-command-history')!)
    expect(stored).toHaveLength(0)
  })

  it('clearHistory removes all entries', async () => {
    const useCommandHistory = await importHook()
    const { result } = renderHook(() => useCommandHistory())
    act(() => { result.current.addCommand('cmd1') })
    act(() => { result.current.addCommand('cmd2') })
    act(() => { result.current.clearHistory() })
    expect(result.current.history).toHaveLength(0)
  })

  it('clearHistory persists empty list to localStorage', async () => {
    const useCommandHistory = await importHook()
    const { result } = renderHook(() => useCommandHistory())
    act(() => { result.current.addCommand('something') })
    act(() => { result.current.clearHistory() })
    const stored = JSON.parse(localStorage.getItem('termote-command-history')!)
    expect(stored).toHaveLength(0)
  })

  it('syncs across multiple hook instances', async () => {
    const useCommandHistory = await importHook()
    const { result: a } = renderHook(() => useCommandHistory())
    const { result: b } = renderHook(() => useCommandHistory())
    act(() => { a.current.addCommand('shared-cmd') })
    expect(b.current.history[0].text).toBe('shared-cmd')
  })

  it('caps history at 100 commands', async () => {
    const useCommandHistory = await importHook()
    const { result } = renderHook(() => useCommandHistory())
    act(() => {
      for (let i = 0; i < 110; i++) {
        result.current.addCommand(`cmd-${i}`)
      }
    })
    expect(result.current.history).toHaveLength(100)
  })

  it('uses fallback id generation when crypto.randomUUID is unavailable', async () => {
    const original = crypto.randomUUID
    // @ts-expect-error intentionally removing randomUUID
    crypto.randomUUID = undefined
    try {
      const useCommandHistory = await importHook()
      const { result } = renderHook(() => useCommandHistory())
      act(() => { result.current.addCommand('no-uuid') })
      expect(result.current.history[0].id).toMatch(/^\d+-[a-z0-9]+$/)
    } finally {
      crypto.randomUUID = original
    }
  })
})
