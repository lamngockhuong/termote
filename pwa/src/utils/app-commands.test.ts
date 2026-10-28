import { describe, expect, it, vi } from 'vitest'
import {
  type AppCommand,
  type AppCommandContext,
  buildAppCommands,
} from './app-commands'
import { APP_INFO } from './app-info'

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
    paneLayout: true,
    paneStream: false,
    canSwapNext: true,
    desktop: true,
    splitPane: vi.fn(),
    zoomPane: vi.fn(),
    swapNextPane: vi.fn(),
    resizePane: vi.fn(),
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
  it('opens what is on screen in a new window, where a link names it', () => {
    const openWindow = vi.fn()
    const on = command(context({ openWindow }), 'window.openNew')
    expect(on.disabledReason).toBeUndefined()
    on.run?.()
    expect(openWindow).toHaveBeenCalled()
    const off = command(context(), 'window.openNew')
    expect(off.disabledReason).toBe('No link names this pane')
    expect(() => off.run?.()).not.toThrow()
  })

  it('turns off what leaves a focus window, and nothing else', () => {
    const left = new Set([
      'palette.sessions',
      'view.overview',
      'tab.new',
      'tab.previous',
      'tab.next',
      'app.toggleSidebar',
      'window.openNew',
    ])
    const normal = buildAppCommands(context({ previousTab: 'a', nextTab: 'b' }))
    const focus = buildAppCommands(
      context({ previousTab: 'a', nextTab: 'b', focus: true }),
    )
    expect(focus.map((c) => c.id)).toEqual(normal.map((c) => c.id))
    for (const [i, c] of focus.entries()) {
      if (left.has(c.id)) expect(c.disabledReason).toBe('Not in a focus window')
      else expect(c.disabledReason).toBe(normal[i].disabledReason)
    }
  })

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

  it('shows Tasks where the view is offered, and says why when it is not', () => {
    const on = context({ viewIds: ['terminal', 'tasks'] })
    const show = command(on, 'view.tasks')
    expect(show.title).toBe('Show Tasks')
    expect(show.disabledReason).toBeUndefined()
    show.run()
    expect(on.changeView).toHaveBeenCalledWith('tasks')
    expect(
      command(context({ readOnly: true }), 'view.tasks').disabledReason,
    ).toBe('View only')
    expect(command(context(), 'view.tasks').disabledReason).toBe(
      'No tasks for this pane',
    )
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

  it('opens Settings, its groups, Help, About and the docs', () => {
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
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    command(ctx, 'app.docs').run()
    expect(open).toHaveBeenCalledWith(
      APP_INFO.links.docs,
      '_blank',
      'noopener,noreferrer',
    )
    open.mockRestore()
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

describe('pane layout commands', () => {
  const ids = [
    'pane.splitRight',
    'pane.splitDown',
    'pane.zoom',
    'pane.swapNext',
    'pane.resizeLeft',
    'pane.resizeRight',
    'pane.resizeUp',
    'pane.resizeDown',
  ]

  it('act on the pane shown, under Panes', () => {
    const ctx = context()
    for (const id of ids) {
      const c = command(ctx, id)
      expect(c.category).toBe('Panes')
      expect(c.disabledReason).toBeUndefined()
      expect(c.restoreFocus).toBe(true)
      c.run()
    }
    expect(ctx.splitPane).toHaveBeenNthCalledWith(1, 'right')
    expect(ctx.splitPane).toHaveBeenNthCalledWith(2, 'down')
    expect(ctx.zoomPane).toHaveBeenCalledTimes(1)
    expect(ctx.swapNextPane).toHaveBeenCalledTimes(1)
    expect(vi.mocked(ctx.resizePane).mock.calls).toEqual([
      ['left'],
      ['right'],
      ['up'],
      ['down'],
    ])
    expect(command(ctx, 'pane.resizeUp').title).toBe('Resize pane up')
  })

  it('stay listed with the reason they cannot run', () => {
    const view = context({ readOnly: true })
    const none = context({ paneLayout: false })
    for (const id of ids) {
      expect(command(view, id).disabledReason).toBe('View only')
      expect(command(none, id).disabledReason).toBe(
        'Not available for this backend',
      )
    }
    expect(
      command(context({ canSwapNext: false }), 'pane.swapNext').disabledReason,
    ).toBe('No pane after this one')
    expect(
      command(context({ canSwapNext: false }), 'pane.zoom').disabledReason,
    ).toBeUndefined()
  })

  it('split alone where the page shows one pane (Herdr)', () => {
    const herdr = context({ paneStream: true, canSwapNext: false })
    for (const id of ids) {
      expect(command(herdr, id).disabledReason).toBe(
        id.startsWith('pane.split')
          ? undefined
          : 'Changes only the Herdr desktop',
      )
    }
    expect(
      command(context({ paneStream: true, readOnly: true }), 'pane.zoom')
        .disabledReason,
    ).toBe('View only')
  })

  it('offer resizing on a desktop only, and stay in a focus window', () => {
    const phone = buildAppCommands(context({ desktop: false })).map((c) => c.id)
    expect(phone).toContain('pane.zoom')
    expect(phone.some((id) => id.startsWith('pane.resize'))).toBe(false)
    expect(
      command(context({ focus: true }), 'pane.splitRight').disabledReason,
    ).toBeUndefined()
  })
})
