import { fireEvent, render, screen } from '@testing-library/react'
import { FolderGit2, MessageSquare, SquareTerminal } from 'lucide-react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { type ViewOption, ViewSwitcher } from './view-switcher'

type View = 'terminal' | 'chat' | 'files'
const VIEWS: ViewOption<View>[] = [
  { id: 'terminal', label: 'Terminal', Icon: SquareTerminal },
  { id: 'chat', label: 'Chat', Icon: MessageSquare },
  { id: 'files', label: 'Files', Icon: FolderGit2 },
]

function Controlled({ showLabels = false, onChange = vi.fn() }) {
  const [view, setView] = useState<View>('terminal')
  return (
    <ViewSwitcher
      views={VIEWS}
      value={view}
      showLabels={showLabels}
      onChange={(v) => {
        setView(v)
        onChange(v)
      }}
    />
  )
}

const tab = (name: string) => screen.getByRole('tab', { name })

describe('ViewSwitcher', () => {
  it('renders nothing with a single view', () => {
    const { container } = render(
      <ViewSwitcher
        views={VIEWS.slice(0, 1)}
        value="terminal"
        onChange={vi.fn()}
      />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('is a tab list with the current view selected and one tab stop', () => {
    render(<Controlled />)
    expect(screen.getByRole('tablist', { name: 'View' })).toBeInTheDocument()
    expect(tab('Terminal')).toHaveAttribute('aria-selected', 'true')
    expect(tab('Terminal')).toHaveAttribute('tabindex', '0')
    expect(tab('Chat')).toHaveAttribute('aria-selected', 'false')
    expect(tab('Chat')).toHaveAttribute('tabindex', '-1')
    // Icon only: the name comes from aria-label
    expect(tab('Chat')).toHaveAttribute('aria-label', 'Chat')
  })

  it('switches on click', () => {
    const onChange = vi.fn()
    render(<Controlled onChange={onChange} />)
    fireEvent.click(tab('Files'))
    expect(onChange).toHaveBeenCalledWith('files')
    expect(tab('Files')).toHaveAttribute('aria-selected', 'true')
  })

  it('moves with arrow keys (wrapping), Home and End', () => {
    const onChange = vi.fn()
    render(<Controlled onChange={onChange} />)
    const list = screen.getByRole('tablist')
    fireEvent.keyDown(list, { key: 'ArrowLeft' })
    expect(tab('Files')).toHaveAttribute('aria-selected', 'true')
    expect(document.activeElement).toBe(tab('Files'))
    fireEvent.keyDown(list, { key: 'ArrowRight' })
    expect(tab('Terminal')).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(list, { key: 'ArrowRight' })
    expect(tab('Chat')).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(list, { key: 'ArrowLeft' })
    expect(tab('Terminal')).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(list, { key: 'End' })
    expect(tab('Files')).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(list, { key: 'Home' })
    expect(tab('Terminal')).toHaveAttribute('aria-selected', 'true')
    onChange.mockClear()
    fireEvent.keyDown(list, { key: 'ArrowDown' })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('shows visible labels when asked', () => {
    render(<Controlled showLabels />)
    expect(tab('Chat')).not.toHaveAttribute('aria-label')
    expect(tab('Chat')).toHaveTextContent('Chat')
  })

  it('points each tab at its panel when given panel ids', () => {
    render(
      <ViewSwitcher
        views={VIEWS}
        value="terminal"
        onChange={vi.fn()}
        panelId={(id) => `panel-${id}`}
      />,
    )
    expect(tab('Chat')).toHaveAttribute('aria-controls', 'panel-chat')
  })

  it('selects the first view when the value is unknown', () => {
    render(
      <ViewSwitcher views={VIEWS} value={'diff' as View} onChange={vi.fn()} />,
    )
    expect(tab('Terminal')).toHaveAttribute('aria-selected', 'true')
  })
})
