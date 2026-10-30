import { act, fireEvent, render, screen } from '@testing-library/react'
import { type ComponentProps, useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionPane, TabLayout } from '../types/session'
import { TerminalStack } from './terminal-stack'
import type { TerminalHandle } from './terminal-view'

// A terminal per mounted pane: mounting one opens a stream, so the count of
// mounts is the count of new WebSockets.
const mounts: string[] = []
const views = new Map<string, Record<string, unknown>>()
const focus = vi.fn()
vi.mock('./terminal-view', () => ({
  MIN_FONT_SIZE: 6,
  TerminalView: (props: {
    paneId?: string
    ref?: (h: TerminalHandle | null) => void
  }) => {
    const id = props.paneId ?? 'none'
    views.set(id, props)
    // biome-ignore lint/correctness/useExhaustiveDependencies: once per mount
    useEffect(() => {
      mounts.push(id)
      props.ref?.({ term: { focus: () => focus(id) } } as never)
      return () => props.ref?.(null)
    }, [])
    return <div data-testid={`term-${id}`} />
  },
}))

// The cell of the terminal font: 60x120 at 100px
vi.mock('../utils/layout-view', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/layout-view')>()),
  measureCell: vi.fn(() => ({ width: 60, height: 120 })),
}))

let resizeObserved: () => void = () => {}
let box = { width: 1200, height: 800 }
class FakeResizeObserver {
  constructor(cb: () => void) {
    resizeObserved = cb
  }
  observe() {}
  disconnect() {}
}
function setBox(width: number, height: number) {
  box = { width, height }
  act(() => resizeObserved())
}

const PANES: SessionPane[] = [
  { id: 'a', label: 'shell', hasAgent: false },
  { id: 'b', label: 'claude', hasAgent: true },
]
// 120x40: at 1200x800 and a 60x120 cell, a 16px font
const LAYOUT: TabLayout = {
  cols: 120,
  rows: 40,
  zoomed: false,
  panes: [
    { id: 'a', x: 0, y: 0, cols: 60, rows: 40 },
    { id: 'b', x: 60, y: 0, cols: 60, rows: 40 },
  ],
}

type StackProps = ComponentProps<typeof TerminalStack>
const onSelect = vi.fn()
const onShown = vi.fn()
const onSignal = vi.fn()
const onState = vi.fn()
const terminalRef: StackProps['terminalRef'] = { current: null }

function props(over: Partial<StackProps> = {}): StackProps {
  return {
    view: {
      paneId: over.activePaneId ?? 'a',
      backend: 'herdr',
      driveSize: true,
      bracketedPaste: true,
      onConnectionStateChange: onState,
    },
    panes: PANES,
    activePaneId: 'a',
    layout: LAYOUT,
    layoutWanted: true,
    perPane: true,
    agentPaste: true,
    terminalRef,
    onSelect,
    onLayoutShownChange: onShown,
    onLayoutSignal: onSignal,
    ...over,
  }
}

function renderStack(over: Partial<StackProps> = {}) {
  const view = render(<TerminalStack {...props(over)} />)
  return {
    ...view,
    update: (next: Partial<StackProps>) =>
      view.rerender(<TerminalStack {...props(next)} />),
  }
}

const paneEl = (id: string) =>
  document.querySelector(`[data-pane-id="${id}"]`) as HTMLElement

beforeEach(() => {
  mounts.length = 0
  views.clear()
  focus.mockClear()
  onSelect.mockClear()
  onShown.mockClear()
  terminalRef.current = null
  box = { width: 1200, height: 800 }
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(
    () => box.width,
  )
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(
    () => box.height,
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('TerminalStack', () => {
  it('without the layout view: one terminal, the active pane, as before', () => {
    renderStack({ layoutWanted: false, perPane: false })
    expect(mounts).toEqual(['a'])
    expect(document.querySelector('[data-pane-id]')).toBeNull()
    const a = views.get('a')!
    expect(a.fixedFontSize).toBeUndefined()
    expect(a.driveSize).toBe(true)
    expect(a.bracketedPaste).toBe(true)
    expect(a.onConnectionStateChange).toBe(onState)
    expect(a.onLayoutSignal).toBeUndefined()
    expect(onShown).toHaveBeenLastCalledWith(false)
    expect(terminalRef.current).not.toBeNull()
  })

  it('places every pane at its rect, at the font the area fits at', () => {
    renderStack()
    expect(onShown).toHaveBeenLastCalledWith(true)
    expect(mounts.sort()).toEqual(['a', 'b'])
    expect(paneEl('a').style.left).toBe('0%')
    expect(paneEl('b').style.left).toBe('50%')
    expect(paneEl('b').style.width).toBe('50%')
    expect(paneEl('b')).toHaveAttribute('aria-label', 'Pane claude')
    const [a, b] = [views.get('a')!, views.get('b')!]
    expect(a.fixedFontSize).toBe(16)
    expect(b.fixedFontSize).toBe(16)
    // None drives the size; only the active one reports its state
    expect(a.driveSize).toBe(false)
    expect(b.driveSize).toBe(false)
    expect(a.onConnectionStateChange).toBe(onState)
    expect(b.onConnectionStateChange).toBeUndefined()
    // A pane's own agent decides its pastes
    expect(b.bracketedPaste).toBe(true)
    expect(a.onLayoutSignal).toBe(onSignal)
    expect(b.onLayoutSignal).toBe(onSignal)
    // The active pane is marked
    expect(paneEl('a').querySelector('.ring-accent')).not.toBeNull()
    expect(paneEl('b').querySelector('.ring-accent')).toBeNull()
  })

  it('draws a line only where a pane meets another, none while zoomed', () => {
    const grid: TabLayout = {
      cols: 120,
      rows: 40,
      zoomed: false,
      panes: [
        { id: 'a', x: 0, y: 0, cols: 60, rows: 20 },
        { id: 'b', x: 60, y: 0, cols: 60, rows: 20 },
        { id: 'c', x: 0, y: 20, cols: 120, rows: 20 },
      ],
    }
    const panes = [...PANES, { ...PANES[0], id: 'c', label: 'c' }]
    const divider = (id: string) =>
      paneEl(id).querySelector('[data-pane-divider]')
    const { update } = renderStack({ layout: grid, panes })
    expect(divider('a')).toBeNull()
    expect(divider('b')?.className).toContain('border-l')
    expect(divider('b')?.className).not.toContain('border-t')
    expect(divider('c')?.className).toContain('border-t')
    expect(divider('c')?.className).not.toContain('border-l')
    update({ layout: { ...grid, zoomed: true, zoomedPaneId: 'b' }, panes })
    expect(document.querySelector('[data-pane-divider]')).toBeNull()
  })

  it('a pane without an agent gets plain pastes', () => {
    renderStack({ activePaneId: 'b' })
    expect(views.get('a')!.bracketedPaste).toBe(false)
  })

  it('opens no stream to pick a pane, zoom, or switch to the strip and back', () => {
    const { update } = renderStack()
    expect(mounts).toHaveLength(2)
    update({ activePaneId: 'b' })
    update({
      activePaneId: 'b',
      layout: { ...LAYOUT, zoomed: true, zoomedPaneId: 'b' },
    })
    update({ activePaneId: 'b' })
    expect(mounts).toHaveLength(2)
    // To the strip: the active pane keeps its terminal
    update({ activePaneId: 'b', layoutWanted: false })
    expect(mounts).toHaveLength(2)
    expect(screen.queryByTestId('term-a')).toBeNull()
    // Back: only the other pane is opened again
    update({ activePaneId: 'b' })
    expect(mounts).toEqual(expect.arrayContaining(['a', 'b']))
    expect(mounts).toHaveLength(3)
    expect(mounts[2]).toBe('a')
  })

  it('terminalRef is the active pane', () => {
    const { update } = renderStack()
    const a = terminalRef.current
    update({ activePaneId: 'b' })
    expect(terminalRef.current).not.toBe(a)
    expect(terminalRef.current).not.toBeNull()
  })

  it('a click or the focus in another pane picks it', () => {
    renderStack()
    fireEvent.focus(screen.getByTestId('term-b'))
    expect(onSelect).toHaveBeenCalledWith('b')
    // The active pane picks nothing
    onSelect.mockClear()
    fireEvent.focus(screen.getByTestId('term-a'))
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('a pane picked elsewhere gets the keys, unless the focus is somewhere else', () => {
    const { update } = renderStack()
    focus.mockClear()
    update({ activePaneId: 'b' })
    expect(focus).toHaveBeenCalledWith('b')
    // From the strip
    const strip = document.createElement('fieldset')
    strip.dataset.tour = 'pane-strip'
    const button = document.createElement('button')
    strip.appendChild(button)
    document.body.appendChild(strip)
    button.focus()
    focus.mockClear()
    update({ activePaneId: 'a' })
    expect(focus).toHaveBeenCalledWith('a')
    // A dialog's input keeps it
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    focus.mockClear()
    update({ activePaneId: 'b' })
    expect(focus).not.toHaveBeenCalled()
    strip.remove()
    input.remove()
  })

  it('a desktop zoom shows that pane only and the page works on it, then on the one before', () => {
    const zoomed = { ...LAYOUT, zoomed: true, zoomedPaneId: 'b' }
    const { update } = renderStack({ layout: zoomed })
    expect(onSelect).toHaveBeenCalledWith('b')
    expect(paneEl('a')).toHaveAttribute('hidden')
    expect(paneEl('b')).not.toHaveAttribute('hidden')
    // The zoomed pane fills the box
    expect(paneEl('b').style.left).toBe('')
    update({ activePaneId: 'b', layout: zoomed })
    onSelect.mockClear()
    update({ activePaneId: 'b' })
    expect(onSelect).toHaveBeenCalledWith('a')
  })

  it('a pane picked during a zoom shows, and stays picked after it', () => {
    const zoomed = { ...LAYOUT, zoomed: true, zoomedPaneId: 'b' }
    const { update } = renderStack({ activePaneId: 'b', layout: zoomed })
    update({ activePaneId: 'a', layout: zoomed })
    expect(paneEl('a')).not.toHaveAttribute('hidden')
    expect(paneEl('b')).toHaveAttribute('hidden')
    // Back on the zoomed pane: it shows again
    update({ activePaneId: 'b', layout: zoomed })
    expect(paneEl('a')).toHaveAttribute('hidden')
    update({ activePaneId: 'a', layout: zoomed })
    onSelect.mockClear()
    update({ activePaneId: 'a' })
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('keeps its size while covered, and measures again once shown', () => {
    const { update } = renderStack({ view: { paneId: 'a' } })
    update({ view: { paneId: 'a', covered: true } })
    setBox(400, 260)
    expect(views.get('a')!.fixedFontSize).toBe(16)
    update({ view: { paneId: 'a', covered: false } })
    expect(onShown).toHaveBeenLastCalledWith(false)
    // The same size again changes nothing
    onShown.mockClear()
    setBox(400, 260)
    expect(onShown).not.toHaveBeenCalled()
  })

  it("Herdr's strip gives the keys to the pane it opens, when its terminal had them", () => {
    const { update } = renderStack({ layoutWanted: false })
    // Focus outside: nothing moves
    update({ layoutWanted: false, activePaneId: 'b' })
    expect(focus).not.toHaveBeenCalled()
    // In the terminal, which is replaced: the new one gets it
    fireEvent.focus(screen.getByTestId('term-b'))
    update({ layoutWanted: false, activePaneId: 'a' })
    expect(focus).toHaveBeenCalledWith('a')
    // Moved to somewhere else on the page first: not
    const button = document.createElement('button')
    document.body.appendChild(button)
    fireEvent.blur(screen.getByTestId('term-a'), { relatedTarget: button })
    focus.mockClear()
    update({ layoutWanted: false, activePaneId: 'b' })
    expect(focus).not.toHaveBeenCalled()
    button.remove()
  })

  it('tmux keeps one terminal and moves no focus on a pane pick', () => {
    const { update } = renderStack({ layoutWanted: false, perPane: false })
    fireEvent.focus(screen.getByTestId('term-a'))
    update({ layoutWanted: false, perPane: false, activePaneId: 'b' })
    expect(mounts).toEqual(['a'])
    expect(focus).not.toHaveBeenCalled()
  })

  it('a zoom on the active pane moves nothing, nor its end', () => {
    const zoomed = { ...LAYOUT, zoomed: true, zoomedPaneId: 'a' }
    const { update } = renderStack({ layout: zoomed })
    update({})
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('after a zoom, a pane that closed meanwhile is not picked', () => {
    const zoomed = { ...LAYOUT, zoomed: true, zoomedPaneId: 'b' }
    const { update } = renderStack({ layout: zoomed })
    onSelect.mockClear()
    update({
      activePaneId: 'b',
      panes: [PANES[1]],
      layout: { ...LAYOUT, panes: [LAYOUT.panes[1]] },
    })
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('leaves the layout below the minimum font and comes back a pixel above it', () => {
    renderStack()
    // 6px (rows of 8px: 40 of them need 320): still shown
    setBox(450, 320)
    expect(onShown).toHaveBeenLastCalledWith(true)
    expect(views.get('a')!.fixedFontSize).toBe(6)
    // 5px: the strip
    setBox(400, 260)
    expect(onShown).toHaveBeenLastCalledWith(false)
    // 6px again: not yet
    setBox(450, 320)
    expect(onShown).toHaveBeenLastCalledWith(false)
    setBox(520, 360)
    expect(onShown).toHaveBeenLastCalledWith(true)
  })

  it('a pane the snapshot does not list yet is named by its id; an active pane the layout lacks gets no terminal', () => {
    const layout = {
      ...LAYOUT,
      panes: [LAYOUT.panes[0], { ...LAYOUT.panes[1], id: 'c' }],
    }
    const { update } = renderStack({ layout })
    expect(paneEl('c')).toHaveAttribute('aria-label', 'Pane c')
    focus.mockClear()
    update({ activePaneId: 'b', layout })
    expect(focus).not.toHaveBeenCalled()
    expect(terminalRef.current).toBeNull()
  })

  it('no stream: no terminal opens one', () => {
    renderStack({ view: { backend: 'herdr' } })
    expect(views.has('a')).toBe(false)
    expect(mounts).toEqual(['none', 'none'])
  })

  it('measures the font again once web fonts are loaded', async () => {
    const { measureCell } = await import('../utils/layout-view')
    let loaded: () => void = () => {}
    vi.stubGlobal('document', document)
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { ready: new Promise<void>((r) => (loaded = r)) },
    })
    const { unmount } = renderStack()
    const calls = vi.mocked(measureCell).mock.calls.length
    await act(async () => loaded())
    expect(vi.mocked(measureCell).mock.calls.length).toBeGreaterThan(calls)
    unmount()
    // Unmounted before the fonts load: nothing set
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { ready: new Promise<void>((r) => (loaded = r)) },
    })
    renderStack().unmount()
    await act(async () => loaded())
  })

  it('without ResizeObserver nothing is measured: the strip', () => {
    vi.stubGlobal('ResizeObserver', undefined)
    renderStack()
    expect(onShown).toHaveBeenLastCalledWith(false)
  })
})
