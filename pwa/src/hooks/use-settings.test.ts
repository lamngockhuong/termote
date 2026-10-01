import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { useSettings } from './use-settings'

describe('useSettings', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('returns defaults when no saved settings', () => {
    const { result } = renderHook(() => useSettings())
    expect(result.current.settings.imeSendBehavior).toBe('send-only')
    expect(result.current.settings.toolbarDefaultExpanded).toBe(false)
    expect(result.current.settings.disableContextMenu).toBe(true)
    expect(result.current.settings.pollInterval).toBe(5)
    expect(result.current.settings.driveTerminalSize).toBe(false)
  })

  it('updates driveTerminalSize and persists', () => {
    const { result } = renderHook(() => useSettings())
    act(() => result.current.updateSetting('driveTerminalSize', true))
    expect(result.current.settings.driveTerminalSize).toBe(true)
    expect(
      JSON.parse(localStorage.getItem('termote-settings')!).driveTerminalSize,
    ).toBe(true)
  })

  it('opens a config saved before uiStyle existed in the neutral style', () => {
    localStorage.setItem(
      'termote-settings',
      JSON.stringify({ imeSendBehavior: 'send-enter', pollInterval: 10 }),
    )
    const { result } = renderHook(() => useSettings())
    expect(result.current.settings.uiStyle).toBe('neutral')
    expect(result.current.settings.imeSendBehavior).toBe('send-enter')
    expect(result.current.settings.pollInterval).toBe(10)
  })

  it('replaces an unknown saved uiStyle with neutral', () => {
    localStorage.setItem(
      'termote-settings',
      JSON.stringify({ uiStyle: 'fancy', pollInterval: 10 }),
    )
    const { result } = renderHook(() => useSettings())
    expect(result.current.settings.uiStyle).toBe('neutral')
    expect(result.current.settings.pollInterval).toBe(10)
  })

  it('updates uiStyle and persists', () => {
    const { result } = renderHook(() => useSettings())
    act(() => result.current.updateSetting('uiStyle', 'terminal'))
    expect(result.current.settings.uiStyle).toBe('terminal')
    expect(JSON.parse(localStorage.getItem('termote-settings')!).uiStyle).toBe(
      'terminal',
    )
  })

  it('restores saved settings from localStorage', () => {
    localStorage.setItem(
      'termote-settings',
      JSON.stringify({
        imeSendBehavior: 'send-enter',
        toolbarDefaultExpanded: true,
      }),
    )
    const { result } = renderHook(() => useSettings())
    expect(result.current.settings.imeSendBehavior).toBe('send-enter')
    expect(result.current.settings.toolbarDefaultExpanded).toBe(true)
  })

  it('merges partial saved settings with defaults', () => {
    localStorage.setItem(
      'termote-settings',
      JSON.stringify({ imeSendBehavior: 'send-enter' }),
    )
    const { result } = renderHook(() => useSettings())
    expect(result.current.settings.imeSendBehavior).toBe('send-enter')
    expect(result.current.settings.toolbarDefaultExpanded).toBe(false)
    expect(result.current.settings.disableContextMenu).toBe(true)
    expect(result.current.settings.pollInterval).toBe(5)
  })

  it('handles corrupt localStorage gracefully', () => {
    localStorage.setItem('termote-settings', 'not-json')
    const { result } = renderHook(() => useSettings())
    expect(result.current.settings.imeSendBehavior).toBe('send-only')
  })

  it('updates a single setting and persists', () => {
    const { result } = renderHook(() => useSettings())
    act(() => result.current.updateSetting('imeSendBehavior', 'send-enter'))

    expect(result.current.settings.imeSendBehavior).toBe('send-enter')
    // Other settings unchanged
    expect(result.current.settings.toolbarDefaultExpanded).toBe(false)

    const stored = JSON.parse(localStorage.getItem('termote-settings')!)
    expect(stored.imeSendBehavior).toBe('send-enter')
  })

  it('syncs across multiple hook instances', () => {
    const { result: a } = renderHook(() => useSettings())
    const { result: b } = renderHook(() => useSettings())

    act(() => a.current.updateSetting('toolbarDefaultExpanded', true))

    expect(b.current.settings.toolbarDefaultExpanded).toBe(true)
  })

  it('updates disableContextMenu and persists', () => {
    const { result } = renderHook(() => useSettings())
    act(() => result.current.updateSetting('disableContextMenu', false))

    expect(result.current.settings.disableContextMenu).toBe(false)

    const stored = JSON.parse(localStorage.getItem('termote-settings')!)
    expect(stored.disableContextMenu).toBe(false)
  })

  it('restores disableContextMenu from localStorage', () => {
    localStorage.setItem(
      'termote-settings',
      JSON.stringify({ disableContextMenu: false }),
    )
    const { result } = renderHook(() => useSettings())
    expect(result.current.settings.disableContextMenu).toBe(false)
  })

  it('updates pollInterval and persists', () => {
    const { result } = renderHook(() => useSettings())
    act(() => result.current.updateSetting('pollInterval', 30))

    expect(result.current.settings.pollInterval).toBe(30)

    const stored = JSON.parse(localStorage.getItem('termote-settings')!)
    expect(stored.pollInterval).toBe(30)
  })

  it('restores pollInterval from localStorage', () => {
    localStorage.setItem(
      'termote-settings',
      JSON.stringify({ pollInterval: 120 }),
    )
    const { result } = renderHook(() => useSettings())
    expect(result.current.settings.pollInterval).toBe(120)
  })
})
