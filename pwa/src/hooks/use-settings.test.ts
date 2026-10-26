import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  FIND_EXCLUDES_DEFAULT,
  FIND_EXCLUDES_MAX,
  findExcludeProblem,
  resolveEditorFontSize,
  resolveEditorTabSize,
  resolveFindExcludes,
  resolveTaskHistoryLines,
  TASK_HISTORY_LINES_DEFAULT,
  TASK_HISTORY_LINES_MAX,
  TASK_HISTORY_LINES_MIN,
  useSettings,
} from './use-settings'

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
    expect(result.current.settings.sidePanelWidth).toBe(440)
  })

  it('updates sidePanelWidth and persists', () => {
    const { result } = renderHook(() => useSettings())
    act(() => result.current.updateSetting('sidePanelWidth', 600))
    expect(result.current.settings.sidePanelWidth).toBe(600)
    expect(
      JSON.parse(localStorage.getItem('termote-settings')!).sidePanelWidth,
    ).toBe(600)
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

  it('returns default sidebarFilter of "all"', () => {
    const { result } = renderHook(() => useSettings())
    expect(result.current.settings.sidebarFilter).toBe('all')
  })

  it('updates sidebarFilter and persists', () => {
    const { result } = renderHook(() => useSettings())
    act(() => result.current.updateSetting('sidebarFilter', 'needs-you'))
    expect(result.current.settings.sidebarFilter).toBe('needs-you')
    expect(
      JSON.parse(localStorage.getItem('termote-settings')!).sidebarFilter,
    ).toBe('needs-you')
  })

  it('replaces an unknown saved sidebarFilter with "all"', () => {
    localStorage.setItem(
      'termote-settings',
      JSON.stringify({ sidebarFilter: 'invalid-filter' }),
    )
    const { result } = renderHook(() => useSettings())
    expect(result.current.settings.sidebarFilter).toBe('all')
  })

  it('restores valid sidebarFilter from localStorage', () => {
    localStorage.setItem(
      'termote-settings',
      JSON.stringify({ sidebarFilter: 'working' }),
    )
    const { result } = renderHook(() => useSettings())
    expect(result.current.settings.sidebarFilter).toBe('working')
  })

  it('returns default sortBlockedFirst of false', () => {
    const { result } = renderHook(() => useSettings())
    expect(result.current.settings.sortBlockedFirst).toBe(false)
  })

  it('updates sortBlockedFirst and persists', () => {
    const { result } = renderHook(() => useSettings())
    act(() => result.current.updateSetting('sortBlockedFirst', true))
    expect(result.current.settings.sortBlockedFirst).toBe(true)
    expect(
      JSON.parse(localStorage.getItem('termote-settings')!).sortBlockedFirst,
    ).toBe(true)
  })

  it('restores sortBlockedFirst from localStorage', () => {
    localStorage.setItem(
      'termote-settings',
      JSON.stringify({ sortBlockedFirst: true }),
    )
    const { result } = renderHook(() => useSettings())
    expect(result.current.settings.sortBlockedFirst).toBe(true)
  })

  it('merges partial saved settings with new defaults', () => {
    localStorage.setItem(
      'termote-settings',
      JSON.stringify({ pollInterval: 30 }),
    )
    const { result } = renderHook(() => useSettings())
    expect(result.current.settings.pollInterval).toBe(30)
    expect(result.current.settings.sidebarFilter).toBe('all')
    expect(result.current.settings.sortBlockedFirst).toBe(false)
  })

  it('searches without ignored files and with the default exclusions', () => {
    const { result } = renderHook(() => useSettings())
    expect(result.current.settings.findIncludeIgnored).toBe(false)
    expect(result.current.settings.findExcludes).toEqual(FIND_EXCLUDES_DEFAULT)
    act(() => result.current.updateSetting('findIncludeIgnored', true))
    act(() => result.current.updateSetting('findExcludes', ['x']))
    const saved = JSON.parse(localStorage.getItem('termote-settings')!)
    expect(saved.findIncludeIgnored).toBe(true)
    expect(saved.findExcludes).toEqual(['x'])
  })

  it('searches contents without the options until turned on, and keeps them', () => {
    const { result } = renderHook(() => useSettings())
    const { searchCase, searchWord, searchRegex } = result.current.settings
    expect([searchCase, searchWord, searchRegex]).toEqual([false, false, false])
    act(() => result.current.updateSetting('searchRegex', true))
    const saved = JSON.parse(localStorage.getItem('termote-settings')!)
    expect(saved.searchRegex).toBe(true)
    expect(saved.searchCase).toBe(false)
  })

  it('reads a broken saved search setting as its default', () => {
    localStorage.setItem(
      'termote-settings',
      JSON.stringify({ findIncludeIgnored: 'yes', findExcludes: 'dist' }),
    )
    const { result } = renderHook(() => useSettings())
    expect(result.current.settings.findIncludeIgnored).toBe(false)
    expect(result.current.settings.findExcludes).toEqual(FIND_EXCLUDES_DEFAULT)
  })

  it('notifies about agents only once turned on', () => {
    localStorage.setItem(
      'termote-settings',
      JSON.stringify({ notifyAgents: 'yes' }),
    )
    const { result } = renderHook(() => useSettings())
    expect(result.current.settings.notifyAgents).toBe(false)
    act(() => result.current.updateSetting('notifyAgents', true))
    expect(result.current.settings.notifyAgents).toBe(true)
    const saved = JSON.parse(localStorage.getItem('termote-settings')!)
    expect(saved.notifyAgents).toBe(true)
  })

  it('keeps a stuck threshold from 3 to 60 minutes, else 10', () => {
    localStorage.setItem(
      'termote-settings',
      JSON.stringify({ stuckMinutes: 600 }),
    )
    const { result } = renderHook(() => useSettings())
    expect(result.current.settings.stuckMinutes).toBe(10)
    act(() => result.current.updateSetting('stuckMinutes', 30))
    expect(result.current.settings.stuckMinutes).toBe(30)
  })

  it('shows the usage chip unless turned off', () => {
    const { result } = renderHook(() => useSettings())
    expect(result.current.settings.showUsageChip).toBe(true)
    act(() => result.current.updateSetting('showUsageChip', false))
    expect(result.current.settings.showUsageChip).toBe(false)
    localStorage.setItem(
      'termote-settings',
      JSON.stringify({ showUsageChip: 0 }),
    )
    const again = renderHook(() => useSettings())
    expect(again.result.current.settings.showUsageChip).toBe(true)
  })

  it('copies on select only once turned on', () => {
    localStorage.setItem(
      'termote-settings',
      JSON.stringify({ copyOnSelect: 1 }),
    )
    const { result } = renderHook(() => useSettings())
    expect(result.current.settings.copyOnSelect).toBe(false)
    act(() => result.current.updateSetting('copyOnSelect', true))
    expect(result.current.settings.copyOnSelect).toBe(true)
  })

  it('shows tables by default, also for a config saved before the setting', () => {
    localStorage.setItem(
      'termote-settings',
      JSON.stringify({ markdownPreview: false }),
    )
    const { result } = renderHook(() => useSettings())
    expect(result.current.settings.tablePreview).toBe(true)
    act(() => result.current.updateSetting('tablePreview', false))
    const saved = JSON.parse(localStorage.getItem('termote-settings')!)
    expect(saved.tablePreview).toBe(false)
    expect(saved.markdownPreview).toBe(false)
  })
})

describe('excluded folder names', () => {
  it('takes one folder name, never a path or a pattern', () => {
    expect(findExcludeProblem('node_modules')).toBeUndefined()
    expect(findExcludeProblem('')).toBe('Enter a folder name')
    for (const bad of ['.', '..', 'a\0b'])
      expect(findExcludeProblem(bad)).toBe('Not a folder name')
    expect(findExcludeProblem('a/b')).toBe('One folder name, not a path')
    expect(findExcludeProblem('a\\b')).toBe('One folder name, not a path')
    expect(findExcludeProblem('*.js')).toBe('A name, not a pattern')
    expect(findExcludeProblem('a'.repeat(256))).toBe('Name too long')
  })

  it('keeps the valid names of a saved list, each once, up to the cap', () => {
    expect(resolveFindExcludes(['a', 'a', 'b/c', 3, 'd'])).toEqual(['a', 'd'])
    expect(resolveFindExcludes([])).toEqual([])
    const many = Array.from(
      { length: FIND_EXCLUDES_MAX + 5 },
      (_, i) => `d${i}`,
    )
    expect(resolveFindExcludes(many)).toHaveLength(FIND_EXCLUDES_MAX)
    expect(resolveFindExcludes(null)).toBe(FIND_EXCLUDES_DEFAULT)
  })
})

describe('editor settings', () => {
  beforeEach(() => localStorage.clear())

  it('keeps a saved size only when it is one offered', () => {
    expect(resolveEditorFontSize(16)).toBe(16)
    expect(resolveEditorFontSize(40)).toBe(13)
    expect(resolveEditorFontSize('14')).toBe(13)
    expect(resolveEditorTabSize(2)).toBe(2)
    expect(resolveEditorTabSize(3)).toBe(4)
    expect(resolveEditorTabSize(undefined)).toBe(4)
  })

  it('reads a saved config, and repairs a broken one', () => {
    localStorage.setItem(
      'termote-settings',
      JSON.stringify({
        editorFontSize: 18,
        editorTabSize: 8,
        editorWrap: true,
        editorVim: true,
      }),
    )
    const { result, unmount } = renderHook(() => useSettings())
    expect(result.current.settings).toMatchObject({
      editorFontSize: 18,
      editorTabSize: 8,
      editorWrap: true,
      editorVim: true,
    })
    unmount()
    localStorage.setItem(
      'termote-settings',
      JSON.stringify({
        editorFontSize: 99,
        editorTabSize: 'x',
        editorWrap: 'yes',
        editorVim: 1,
      }),
    )
    const again = renderHook(() => useSettings())
    expect(again.result.current.settings).toMatchObject({
      editorFontSize: 13,
      editorTabSize: 4,
      editorWrap: false,
      editorVim: false,
    })
  })
})

describe('task history lines', () => {
  beforeEach(() => localStorage.clear())

  it('keeps a saved count only when it is a whole number in range', () => {
    expect(TASK_HISTORY_LINES_DEFAULT).toBe(400)
    expect(resolveTaskHistoryLines(1000)).toBe(1000)
    expect(resolveTaskHistoryLines(TASK_HISTORY_LINES_MIN)).toBe(
      TASK_HISTORY_LINES_MIN,
    )
    expect(resolveTaskHistoryLines(TASK_HISTORY_LINES_MAX)).toBe(
      TASK_HISTORY_LINES_MAX,
    )
    expect(resolveTaskHistoryLines(TASK_HISTORY_LINES_MIN - 1)).toBe(400)
    expect(resolveTaskHistoryLines(TASK_HISTORY_LINES_MAX + 1)).toBe(400)
    expect(resolveTaskHistoryLines(250.5)).toBe(400)
    expect(resolveTaskHistoryLines('1000')).toBe(400)
    expect(resolveTaskHistoryLines(undefined)).toBe(400)
    expect(resolveTaskHistoryLines(Number.NaN)).toBe(400)
  })

  it('defaults in the snapshot, reads a saved value, repairs a bad one', () => {
    const first = renderHook(() => useSettings())
    expect(first.result.current.settings.taskHistoryLines).toBe(400)
    first.unmount()
    localStorage.setItem(
      'termote-settings',
      JSON.stringify({ taskHistoryLines: 2000 }),
    )
    const saved = renderHook(() => useSettings())
    expect(saved.result.current.settings.taskHistoryLines).toBe(2000)
    saved.unmount()
    localStorage.setItem(
      'termote-settings',
      JSON.stringify({ taskHistoryLines: 7 }),
    )
    const bad = renderHook(() => useSettings())
    expect(bad.result.current.settings.taskHistoryLines).toBe(400)
  })

  it('updates and persists the count', () => {
    const { result } = renderHook(() => useSettings())
    act(() => result.current.updateSetting('taskHistoryLines', 200))
    expect(result.current.settings.taskHistoryLines).toBe(200)
    expect(
      JSON.parse(localStorage.getItem('termote-settings') ?? '{}')
        .taskHistoryLines,
    ).toBe(200)
  })
})
