import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { UsageMeter } from './usage-meter'

describe('UsageMeter', () => {
  it('is a meter with its value, coloured by level', () => {
    render(
      <UsageMeter
        percent={72.4}
        label="Context"
        valueText="72%, 144k of 200k tokens"
        className="w-12"
      />,
    )
    const m = screen.getByRole('meter', { name: 'Context' })
    expect(m).toHaveAttribute('aria-valuenow', '72')
    expect(m).toHaveAttribute('aria-valuemin', '0')
    expect(m).toHaveAttribute('aria-valuemax', '100')
    expect(m).toHaveAttribute('aria-valuetext', '72%, 144k of 200k tokens')
    expect(m).toHaveAttribute('data-level', 'warning')
    expect(m).toHaveClass('w-12')
    expect(m.firstElementChild).toHaveClass('bg-warning')
    expect((m.firstElementChild as HTMLElement).style.width).toBe('72.4%')
  })

  it('keeps the bar within 0 and 100', () => {
    const { rerender } = render(
      <UsageMeter percent={140} label="Limit" valueText="full" />,
    )
    const m = screen.getByRole('meter')
    expect(m).toHaveAttribute('aria-valuenow', '100')
    expect(m.firstElementChild).toHaveClass('bg-danger')
    rerender(<UsageMeter percent={-5} label="Limit" valueText="none" />)
    expect(m).toHaveAttribute('aria-valuenow', '0')
    expect(m.firstElementChild).toHaveClass('bg-fg-muted')
  })
})
