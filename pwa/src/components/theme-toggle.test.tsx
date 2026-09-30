import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ThemeProvider } from '../contexts/theme-context'
import { ThemeToggle } from './theme-toggle'

function renderWithTheme() {
  return render(
    <ThemeProvider>
      <ThemeToggle />
    </ThemeProvider>,
  )
}

describe('ThemeToggle', () => {
  it('renders all three theme options', () => {
    renderWithTheme()
    expect(screen.getByLabelText('Light theme')).toBeInTheDocument()
    expect(screen.getByLabelText('Dark theme')).toBeInTheDocument()
    expect(screen.getByLabelText('System theme')).toBeInTheDocument()
  })

  it('system theme option is checked by default', () => {
    renderWithTheme()
    expect(screen.getByLabelText('System theme')).toHaveAttribute(
      'aria-checked',
      'true',
    )
    expect(screen.getByLabelText('Light theme')).toHaveAttribute(
      'aria-checked',
      'false',
    )
    expect(screen.getByLabelText('Dark theme')).toHaveAttribute(
      'aria-checked',
      'false',
    )
  })

  it('clicking light sets theme to light', () => {
    renderWithTheme()
    fireEvent.click(screen.getByLabelText('Light theme'))
    expect(screen.getByLabelText('Light theme')).toHaveAttribute(
      'aria-checked',
      'true',
    )
    expect(screen.getByLabelText('System theme')).toHaveAttribute(
      'aria-checked',
      'false',
    )
  })

  it('clicking dark sets theme to dark', () => {
    renderWithTheme()
    fireEvent.click(screen.getByLabelText('Dark theme'))
    expect(screen.getByLabelText('Dark theme')).toHaveAttribute(
      'aria-checked',
      'true',
    )
  })

  it('clicking system sets theme to system', () => {
    renderWithTheme()
    fireEvent.click(screen.getByLabelText('Light theme'))
    fireEvent.click(screen.getByLabelText('System theme'))
    expect(screen.getByLabelText('System theme')).toHaveAttribute(
      'aria-checked',
      'true',
    )
  })
})
