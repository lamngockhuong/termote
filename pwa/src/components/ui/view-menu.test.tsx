import { fireEvent, render, screen } from '@testing-library/react'
import { FolderGit2, MessageSquare, SquareTerminal } from 'lucide-react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { ViewMenu } from './view-menu'
import type { ViewOption } from './view-switcher'

type View = 'terminal' | 'chat' | 'files'
const VIEWS: ViewOption<View>[] = [
  { id: 'terminal', label: 'Terminal', Icon: SquareTerminal },
  { id: 'chat', label: 'Chat', Icon: MessageSquare },
  { id: 'files', label: 'Files', Icon: FolderGit2 },
]

function Controlled({ onChange = vi.fn() }) {
  const [view, setView] = useState<View>('terminal')
  return (
    <ViewMenu
      views={VIEWS}
      value={view}
      onChange={(v) => {
        setView(v)
        onChange(v)
      }}
    />
  )
}

const button = (name: string) => screen.getByRole('button', { name })
const option = (name: string) => screen.getByRole('menuitemradio', { name })

describe('ViewMenu', () => {
  it('renders nothing with a single view', () => {
    const { container } = render(
      <ViewMenu
        views={VIEWS.slice(0, 1)}
        value="terminal"
        onChange={vi.fn()}
      />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('is one button named after the current view, with a touch-size target', () => {
    render(<Controlled />)
    const trigger = button('View: Terminal')
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(trigger).toHaveClass('pointer-coarse:size-touch')
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('lists every view with its icon, the current one checked', () => {
    render(<Controlled />)
    fireEvent.click(button('View: Terminal'))
    expect(screen.getByRole('menu', { name: 'View: Terminal' })).toBeVisible()
    expect(screen.getByRole('group', { name: 'View' })).toBeVisible()
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(3)
    expect(option('Terminal')).toHaveAttribute('aria-checked', 'true')
    expect(option('Chat')).toHaveAttribute('aria-checked', 'false')
    expect(option('Files').querySelector('svg')).toBeInTheDocument()
  })

  it('switches view on select, closes and renames the button', () => {
    const onChange = vi.fn()
    render(<Controlled onChange={onChange} />)
    fireEvent.click(button('View: Terminal'))
    fireEvent.click(option('Chat'))
    expect(onChange).toHaveBeenCalledWith('chat')
    expect(screen.queryByRole('menu')).toBeNull()
    const trigger = button('View: Chat')
    expect(trigger).toHaveFocus()
    fireEvent.click(trigger)
    expect(option('Chat')).toHaveAttribute('aria-checked', 'true')
    expect(option('Terminal')).toHaveAttribute('aria-checked', 'false')
  })

  it('opens and moves with the keyboard', () => {
    const onChange = vi.fn()
    render(<Controlled onChange={onChange} />)
    // detail 0: a click from Enter/Space
    fireEvent.click(button('View: Terminal'), { detail: 0 })
    expect(option('Terminal')).toHaveFocus()
    fireEvent.keyDown(option('Terminal'), { key: 'ArrowDown' })
    expect(option('Chat')).toHaveFocus()
    fireEvent.keyDown(option('Chat'), { key: 'End' })
    expect(option('Files')).toHaveFocus()
    fireEvent.click(option('Files'), { detail: 0 })
    expect(onChange).toHaveBeenCalledWith('files')
    expect(button('View: Files')).toHaveFocus()
  })

  it('closes on Escape without switching', () => {
    const onChange = vi.fn()
    render(<Controlled onChange={onChange} />)
    fireEvent.click(button('View: Terminal'), { detail: 0 })
    fireEvent.keyDown(option('Terminal'), { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(button('View: Terminal')).toHaveFocus()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('names the first view when the value is unknown', () => {
    render(<ViewMenu views={VIEWS} value={'diff' as View} onChange={vi.fn()} />)
    fireEvent.click(button('View: Terminal'))
    expect(option('Terminal')).toHaveAttribute('aria-checked', 'true')
  })
})
