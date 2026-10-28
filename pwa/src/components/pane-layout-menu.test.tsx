import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { RequestError } from '../hooks/use-mux-api'
import { PaneLayoutMenu, paneLayoutMessage } from './pane-layout-menu'

function show(over: Partial<Parameters<typeof PaneLayoutMenu>[0]> = {}) {
  const p = {
    desktop: true,
    canSwapNext: true,
    canClose: true,
    onSplit: vi.fn(),
    onZoom: vi.fn(),
    onSwapNext: vi.fn(),
    onResize: vi.fn(),
    onClose: vi.fn(),
    ...over,
  }
  render(<PaneLayoutMenu {...p} />)
  fireEvent.click(screen.getByRole('button', { name: 'Pane' }))
  return p
}

const item = (name: string) => screen.getByRole('menuitem', { name })

describe('PaneLayoutMenu', () => {
  it('runs each action on the pane', () => {
    const p = show()
    fireEvent.click(item('Split right'))
    expect(p.onSplit).toHaveBeenLastCalledWith('right')
    fireEvent.click(screen.getByRole('button', { name: 'Pane' }))
    fireEvent.click(item('Split down'))
    expect(p.onSplit).toHaveBeenLastCalledWith('down')
    fireEvent.click(screen.getByRole('button', { name: 'Pane' }))
    fireEvent.click(item('Zoom'))
    expect(p.onZoom).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Pane' }))
    fireEvent.click(item('Swap with next pane'))
    expect(p.onSwapNext).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Pane' }))
    fireEvent.click(item('Close pane'))
    expect(p.onClose).toHaveBeenCalled()
  })

  it('resizes on a desktop, the menu staying open', () => {
    const p = show()
    for (const d of ['left', 'right', 'up', 'down'] as const) {
      fireEvent.click(item(`Resize ${d}`))
      expect(p.onResize).toHaveBeenLastCalledWith(d)
    }
    expect(screen.getByRole('menu')).toBeInTheDocument()
  })

  it('offers no resize on a phone, no swap without a next pane, no close of the last pane', () => {
    const p = show({ desktop: false, canSwapNext: false, canClose: false })
    expect(screen.queryByRole('menuitem', { name: /Resize/ })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'Close pane' })).toBeNull()
    expect(item('Swap with next pane')).toBeDisabled()
    fireEvent.click(item('Swap with next pane'))
    expect(p.onSwapNext).not.toHaveBeenCalled()
  })
})

describe('paneLayoutMessage', () => {
  it('words each code the server refuses with', () => {
    const err = (code: string) => new RequestError(400, code, code)
    expect(paneLayoutMessage(err('unknown_pane'))).toBe('The pane is gone')
    expect(paneLayoutMessage(err('no_neighbor'))).toBe('No pane on that side')
    expect(paneLayoutMessage(err('no_room'))).toBe('No room for another pane')
    expect(paneLayoutMessage(err('busy'))).toBe('Busy, try again')
    expect(paneLayoutMessage(err('unsupported'))).toBe(
      'Not supported for this pane',
    )
    expect(paneLayoutMessage(err('view_only'))).toBe('This device is view-only')
    expect(paneLayoutMessage(err('invalid_mode'))).toBe(
      'Could not change the panes',
    )
    expect(paneLayoutMessage(new Error('offline'))).toBe(
      'Could not change the panes',
    )
  })
})
