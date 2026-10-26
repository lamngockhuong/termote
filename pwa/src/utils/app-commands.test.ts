import { describe, expect, it, vi } from 'vitest'
import {
  type AppCommand,
  type AppCommandContext,
  buildAppCommands,
} from './app-commands'

function context(over: Partial<AppCommandContext> = {}): AppCommandContext {
  return {
    apple: false,
    readOnly: false,
    viewIds: ['terminal', 'chat'],
    panelIds: ['files', 'changes'],
    sidePanelId: null,
    startOffered: true,
    hasAgent: false,
    devices: true,
    canFullscreen: true,
    previousTab: 'a',
    nextTab: 'c',
    openPalette: vi.fn(),
    changeView: vi.fn(),
    showTerminal: vi.fn(),
    showChat: vi.fn(),
    togglePanel: vi.fn(),
    openOverview: vi.fn(),
    searchContent: vi.fn(),
    newTab: vi.fn(),
    selectTab: vi.fn(),
    openSettings: vi.fn(),
    openHelp: vi.fn(),
    openAbout: vi.fn(),
    toggleSidebar: vi.fn(),
    toggleFullscreen: vi.fn(),
    fontIncrease: vi.fn(),
    fontDecrease: vi.fn(),
    setTheme: vi.fn(),
    ...over,
  }
}

function command(ctx: AppCommandContext, id: string): AppCommand {
  const c = buildAppCommands(ctx).find((x) => x.id === id)
  if (!c) throw new Error(`no command ${id}`)
  return c
}

describe('buildAppCommands', () => {
  it('lists each id once, with a title and a category', () => {
    const list = buildAppCommands(context())
    expect(new Set(list.map((c) => c.id)).size).toBe(list.length)
    for (const c of list) {
      expect(c.title).toBeTruthy()
      expect(c.category).toBeTruthy()
    }
  })

  it('opens the palette in each mode', () => {
    const ctx = context()
    for (const [id, mode] of [
      ['palette.quickOpen', 'files'],
      ['palette.commands', 'commands'],
      ['palette.goToLine', 'line'],
      ['palette.sessions', 'sessions'],
    ] as const) {
      command(ctx, id).run()
      expect(ctx.openPalette).toHaveBeenLastCalledWith(mode)
    }
  })

  it('runs quick open in the terminal only on Apple; the palette everywhere', () => {
    expect(command(context(), 'palette.quickOpen')).toMatchObject({
      defaultKey: 'Mod+P',
      inTerminal: false,
    })
    expect(
      command(context({ apple: true }), 'palette.quickOpen').inTerminal,
    ).toBe(true)
    expect(command(context(), 'palette.commands')).toMatchObject({
      defaultKey: 'Mod+Shift+P',
      inTerminal: true,
    })
  })

  it('switches views and toggles the side panels', () => {
    const ctx = context()
    command(ctx, 'view.terminal').run()
    expect(ctx.showTerminal).toHaveBeenCalled()
    command(ctx, 'view.chat').run()
    expect(ctx.showChat).toHaveBeenCalled()
    command(ctx, 'view.filesPanel').run()
    expect(ctx.togglePanel).toHaveBeenLastCalledWith('files')
    command(ctx, 'view.changesPanel').run()
    expect(ctx.togglePanel).toHaveBeenLastCalledWith('changes')
    const open = context({ sidePanelId: 'files' })
    command(open, 'view.filesPanel').run()
    expect(open.togglePanel).toHaveBeenLastCalledWith(null)
    command(ctx, 'view.overview').run()
    expect(ctx.openOverview).toHaveBeenCalled()
  })

  it('says why a view or panel is not offered', () => {
    const ctx = context({ viewIds: ['terminal'], panelIds: [] })
    expect(command(ctx, 'view.chat').disabledReason).toBe(
      'No agent chat in this pane',
    )
    expect(command(ctx, 'view.filesPanel').disabledReason).toBe(
      'Not available for this pane',
    )
    expect(command(ctx, 'files.searchContent').disabledReason).toBe(
      'Not available for this pane',
    )
  })

  it('searches the content of files', () => {
    const ctx = context()
    const c = command(ctx, 'files.searchContent')
    expect(c.defaultKey).toBe('Mod+Shift+F')
    expect(c.disabledReason).toBeUndefined()
    c.run()
    expect(ctx.searchContent).toHaveBeenCalled()
  })

  it('adds and moves between tabs', () => {
    const ctx = context()
    command(ctx, 'tab.new').run()
    expect(ctx.newTab).toHaveBeenCalled()
    command(ctx, 'tab.previous').run()
    expect(ctx.selectTab).toHaveBeenLastCalledWith('a')
    command(ctx, 'tab.next').run()
    expect(ctx.selectTab).toHaveBeenLastCalledWith('c')
  })

  it('says why a tab command cannot run', () => {
    const ctx = context({
      readOnly: true,
      previousTab: undefined,
      nextTab: undefined,
    })
    expect(command(ctx, 'tab.new').disabledReason).toBe('View only')
    const prev = command(ctx, 'tab.previous')
    expect(prev.disabledReason).toBe('No tab before this one')
    prev.run()
    const next = command(ctx, 'tab.next')
    expect(next.disabledReason).toBe('No tab after this one')
    next.run()
    expect(ctx.selectTab).not.toHaveBeenCalled()
  })

  it('starts an agent from its Chat view, or says why not', () => {
    const ctx = context()
    command(ctx, 'agent.start').run()
    expect(ctx.changeView).toHaveBeenLastCalledWith('chat')
    const reason = (over: Partial<AppCommandContext>) =>
      command(context({ startOffered: false, ...over }), 'agent.start')
        .disabledReason
    expect(reason({ readOnly: true })).toBe('View only')
    expect(reason({ hasAgent: true })).toBe(
      'An agent already runs in this pane',
    )
    expect(reason({})).toBe('This pane cannot start an agent')
  })

  it('opens Settings, its groups, Help and About', () => {
    const ctx = context()
    command(ctx, 'settings.open').run()
    expect(ctx.openSettings).toHaveBeenLastCalledWith()
    command(ctx, 'settings.devices').run()
    expect(ctx.openSettings).toHaveBeenLastCalledWith('devices')
    command(ctx, 'settings.shortcuts').run()
    expect(ctx.openSettings).toHaveBeenLastCalledWith('shortcuts')
    command(ctx, 'app.help').run()
    expect(ctx.openHelp).toHaveBeenCalled()
    command(ctx, 'app.about').run()
    expect(ctx.openAbout).toHaveBeenCalled()
    expect(
      command(context({ devices: false }), 'settings.devices').disabledReason,
    ).toBe('Not available on this server')
  })

  it('runs the app and terminal toggles', () => {
    const ctx = context()
    command(ctx, 'app.toggleSidebar').run()
    expect(ctx.toggleSidebar).toHaveBeenCalled()
    command(ctx, 'app.fullscreen').run()
    expect(ctx.toggleFullscreen).toHaveBeenCalled()
    command(ctx, 'terminal.fontIncrease').run()
    expect(ctx.fontIncrease).toHaveBeenCalled()
    command(ctx, 'terminal.fontDecrease').run()
    expect(ctx.fontDecrease).toHaveBeenCalled()
    expect(
      command(context({ canFullscreen: false }), 'app.fullscreen')
        .disabledReason,
    ).toBe('Not supported by this browser')
  })

  it('sets the theme', () => {
    const ctx = context()
    for (const t of ['light', 'dark', 'system'] as const) {
      command(ctx, `theme.${t}`).run()
      expect(ctx.setTheme).toHaveBeenLastCalledWith(t)
    }
  })
})
