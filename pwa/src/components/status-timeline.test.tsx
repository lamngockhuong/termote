import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ActivityEvent } from '../hooks/use-mux-api'
import { StatusTimeline } from './status-timeline'

const NOW = Date.parse('2026-10-13T10:00:00Z')
const ev = (seq: number, agoMin: number, to: string, key = '@7') =>
  ({
    seq,
    ts: new Date(NOW - agoMin * 60_000).toISOString(),
    key,
    groupId: 'g',
    tabId: 't',
    paneId: '2',
    agent: 'claude',
    from: '',
    to,
  }) as ActivityEvent

describe('StatusTimeline', () => {
  it('draws the last hour by status, named for a screen reader', () => {
    const { container } = render(
      <StatusTimeline
        events={[
          ev(1, 30, 'working'),
          ev(2, 15, 'blocked'),
          ev(3, 0.2, 'unknown'),
          ev(4, 40, 'idle', '@9'),
        ]}
        paneKey="@7"
        now={NOW}
      />,
    )
    const strip = screen.getByRole('img', { name: /^Last 60 min:/ })
    expect(strip).toHaveAccessibleName(
      'Last 60 min: working 15 min, needs you 15 min, unknown <1 min',
    )
    const segs = container.querySelectorAll('[data-status]:not([role])')
    const drawn = [...segs].filter((s) => s.parentElement === strip)
    expect(drawn.map((s) => s.getAttribute('data-status'))).toEqual([
      'working',
      'blocked',
      'unknown',
    ])
    // Half the hour in, a quarter wide; blocked is striped, not colour alone
    expect((drawn[0] as HTMLElement).style.left).toBe('50%')
    expect((drawn[0] as HTMLElement).style.width).toBe('25%')
    expect(drawn[1].className).toMatch(/repeating-linear-gradient/)
    expect(drawn[2].className).toMatch(/bg-fg-subtle/)
  })

  it('says when nothing was recorded', () => {
    render(<StatusTimeline events={[]} paneKey="@7" now={NOW} />)
    expect(
      screen.getByRole('img', {
        name: 'Last 60 min: no status changes recorded',
      }),
    ).toBeInTheDocument()
    expect(screen.getByText('No data yet')).toBeInTheDocument()
  })
})
