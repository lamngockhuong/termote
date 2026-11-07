import { fireEvent, render, screen, within } from '@testing-library/react'
import { FolderTree, MessageSquare, SquareTerminal } from 'lucide-react'
import type { ComponentProps } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { ToolbarRail } from './toolbar-rail'

type Props = ComponentProps<typeof ToolbarRail>

function renderRail(over: Partial<Props> = {}) {
  const p: Props = {
    views: [
      { id: 'terminal', label: 'Terminal', Icon: SquareTerminal },
      { id: 'chat', label: 'Chat', Icon: MessageSquare },
    ],
    viewId: 'terminal',
    onViewChange: vi.fn(),
    viewPanelId: (id) => `panel-${id}`,
    panelViews: [{ id: 'files', label: 'Files', Icon: FolderTree }],
    sidePanelId: null,
    onTogglePanel: vi.fn(),
    paneMenu: <button type="button">Pane</button>,
    isFullscreen: false,
    onToggleFullscreen: vi.fn(),
    fullscreenKey: 'F11',
    onOpenPalette: vi.fn(),
    paletteKey: 'Ctrl+Shift+P',
    ...over,
  }
  render(<ToolbarRail {...p} />)
  return p
}

const bar = () => screen.getByRole('navigation', { name: 'Toolbar' })

describe('ToolbarRail', () => {
  it('holds the views, panels, Pane menu, fullscreen and palette in order', () => {
    renderRail()
    const names = [...bar().querySelectorAll('button')].map(
      (el) => el.getAttribute('aria-label') ?? el.textContent,
    )
    expect(names).toEqual([
      'Terminal',
      'Chat',
      'Files',
      'Pane',
      'Enter fullscreen',
      'Command palette',
    ])
  })

  it('stacks the views, icons only, moved with Up and Down', () => {
    const p = renderRail()
    const list = within(bar()).getByRole('tablist', { name: 'View' })
    expect(list).toHaveAttribute('aria-orientation', 'vertical')
    expect(list).toHaveClass('flex-col')
    const terminal = screen.getByRole('tab', { name: 'Terminal' })
    expect(terminal).toHaveClass('size-8')
    expect(terminal).toHaveAttribute('aria-controls', 'panel-terminal')
    expect(screen.getByText('Terminal')).not.toHaveClass('@[60rem]:not-sr-only')
    fireEvent.keyDown(terminal, { key: 'ArrowDown' })
    expect(p.onViewChange).toHaveBeenLastCalledWith('chat')
    fireEvent.keyDown(terminal, { key: 'ArrowUp' })
    expect(p.onViewChange).toHaveBeenLastCalledWith('chat')
    fireEvent.keyDown(terminal, { key: 'ArrowRight' })
    expect(p.onViewChange).toHaveBeenCalledTimes(2)
  })

  it('stacks the side panel toggles, icons only', () => {
    const p = renderRail({ sidePanelId: 'files' })
    const files = screen.getByRole('button', { name: 'Files' })
    expect(files.parentElement).toHaveClass('flex-col')
    expect(files).toHaveClass('size-8')
    expect(files).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('Files')).not.toHaveClass('@[60rem]:not-sr-only')
    fireEvent.click(files)
    expect(p.onTogglePanel).toHaveBeenCalledWith(null)
  })

  it('names fullscreen by state and the palette, with their keys', () => {
    const p = renderRail()
    const full = screen.getByRole('button', { name: 'Enter fullscreen' })
    expect(full).toHaveAttribute('title', 'Enter fullscreen (F11)')
    fireEvent.click(full)
    expect(p.onToggleFullscreen).toHaveBeenCalledOnce()
    const palette = screen.getByRole('button', { name: 'Command palette' })
    expect(palette).toHaveAttribute('title', 'Command palette (Ctrl+Shift+P)')
    expect(palette).toHaveAttribute('data-tour', 'palette')
    fireEvent.click(palette)
    expect(p.onOpenPalette).toHaveBeenCalledOnce()
  })

  it('names Exit fullscreen once fullscreen, without keys', () => {
    renderRail({
      isFullscreen: true,
      fullscreenKey: undefined,
      paletteKey: undefined,
    })
    expect(
      screen.getByRole('button', { name: 'Exit fullscreen' }),
    ).toHaveAttribute('title', 'Exit fullscreen')
    expect(
      screen.getByRole('button', { name: 'Command palette' }),
    ).toHaveAttribute('title', 'Command palette')
  })

  it('leaves out what is not offered', () => {
    renderRail({
      views: [{ id: 'terminal', label: 'Terminal', Icon: SquareTerminal }],
      onTogglePanel: undefined,
      paneMenu: undefined,
      onToggleFullscreen: undefined,
      onOpenPalette: undefined,
    })
    expect(bar().querySelectorAll('button')).toHaveLength(0)
  })

  it('shows no toggles without panel views', () => {
    renderRail({ panelViews: undefined })
    expect(screen.queryByRole('group', { name: 'Side panel' })).toBeNull()
  })
})
