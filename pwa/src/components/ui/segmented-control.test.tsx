import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { SegmentedControl } from './segmented-control'

type Theme = 'light' | 'dark' | 'system'
const OPTIONS = [
  { value: 'light' as const, content: '☀', label: 'Light theme' },
  { value: 'dark' as const, content: '☾', label: 'Dark theme' },
  { value: 'system' as const, content: 'System' },
]

function Controlled({ initial = 'dark' as Theme, onChange = vi.fn() }) {
  const [value, setValue] = useState<Theme>(initial)
  return (
    <SegmentedControl
      label="Theme"
      options={OPTIONS}
      value={value}
      onChange={(v) => {
        setValue(v)
        onChange(v)
      }}
    />
  )
}

const radio = (name: string) => screen.getByRole('radio', { name })

describe('SegmentedControl', () => {
  it('is a named radio group with one checked option and one tab stop', () => {
    render(<Controlled />)
    expect(
      screen.getByRole('radiogroup', { name: 'Theme' }),
    ).toBeInTheDocument()
    expect(radio('Dark theme')).toHaveAttribute('aria-checked', 'true')
    expect(radio('Dark theme')).toHaveAttribute('tabindex', '0')
    expect(radio('Light theme')).toHaveAttribute('aria-checked', 'false')
    expect(radio('Light theme')).toHaveAttribute('tabindex', '-1')
    // Text content names an option without a label
    expect(radio('System')).toBeInTheDocument()
  })

  it('selects an option on click', () => {
    const onChange = vi.fn()
    render(<Controlled onChange={onChange} />)
    fireEvent.click(radio('System'))
    expect(onChange).toHaveBeenCalledWith('system')
    expect(radio('System')).toHaveAttribute('aria-checked', 'true')
  })

  it('moves the selection and focus with arrows, wrapping, and Home/End', () => {
    const onChange = vi.fn()
    render(<Controlled onChange={onChange} />)
    const group = screen.getByRole('radiogroup')
    fireEvent.keyDown(group, { key: 'ArrowRight' })
    expect(radio('System')).toHaveAttribute('aria-checked', 'true')
    expect(document.activeElement).toBe(radio('System'))
    fireEvent.keyDown(group, { key: 'ArrowDown' })
    expect(radio('Light theme')).toHaveAttribute('aria-checked', 'true')
    fireEvent.keyDown(group, { key: 'ArrowLeft' })
    expect(radio('System')).toHaveAttribute('aria-checked', 'true')
    fireEvent.keyDown(group, { key: 'ArrowUp' })
    expect(radio('Dark theme')).toHaveAttribute('aria-checked', 'true')
    fireEvent.keyDown(group, { key: 'ArrowDown' })
    expect(radio('System')).toHaveAttribute('aria-checked', 'true')
    fireEvent.keyDown(group, { key: 'Home' })
    expect(radio('Light theme')).toHaveAttribute('aria-checked', 'true')
    fireEvent.keyDown(group, { key: 'ArrowUp' })
    expect(radio('System')).toHaveAttribute('aria-checked', 'true')
    fireEvent.keyDown(group, { key: 'Home' })
    fireEvent.keyDown(group, { key: 'End' })
    expect(radio('System')).toHaveAttribute('aria-checked', 'true')
    onChange.mockClear()
    fireEvent.keyDown(group, { key: 'Enter' })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('keeps a tab stop on the first option when the value matches none', () => {
    render(
      <SegmentedControl
        label="Theme"
        options={OPTIONS}
        value={'sepia' as Theme}
        onChange={vi.fn()}
        className="ml-auto"
      />,
    )
    expect(screen.getByRole('radiogroup')).toHaveClass('ml-auto')
    expect(radio('Light theme')).toHaveAttribute('tabindex', '0')
    expect(
      screen.queryByRole('radio', { checked: true }),
    ).not.toBeInTheDocument()
  })

  it('from no match, arrows start at the ends', () => {
    const onChange = vi.fn()
    render(
      <SegmentedControl
        label="Theme"
        options={OPTIONS}
        value={'sepia' as Theme}
        onChange={onChange}
      />,
    )
    const group = screen.getByRole('radiogroup')
    fireEvent.keyDown(group, { key: 'ArrowRight' })
    expect(onChange).toHaveBeenLastCalledWith('light')
    fireEvent.keyDown(group, { key: 'ArrowLeft' })
    expect(onChange).toHaveBeenLastCalledWith('system')
  })
})
