import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostStats } from '../hooks/use-mux-api'

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }))
vi.mock('../hooks/use-mux-api', async (orig) => ({
  ...(await orig<typeof import('../hooks/use-mux-api')>()),
  fetchHostStats: () => mockFetch(),
}))

import { HeaderHostChip, HostChip, hostParts } from './host-chip'

const GB = 1024 ** 3
const stats = (over: Partial<HostStats> = {}): HostStats => ({
  scope: 'host',
  cpu: { percent: 23, count: 8 },
  load: [1.2, 1, 0.8],
  memory: { total: 16 * GB, used: 9.8 * GB, percent: 61, approx: false },
  swap: null,
  disks: [{ label: 'home', total: 500 * GB, free: 120 * GB, percent: 76 }],
  battery: { percent: 84, charging: true, plugged: true, minutesLeft: 30 },
  sampledAt: '2026-11-01T00:00:00Z',
  history: [],
  ...over,
})

// Open a <dialog> as the browser does, so role queries see its content
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn().mockImplementation(function (
    this: HTMLDialogElement,
  ) {
    this.setAttribute('open', '')
  })
  HTMLDialogElement.prototype.close = vi.fn()
})

describe('hostParts', () => {
  it('takes CPU and RAM, only the higher on a phone', () => {
    expect(hostParts(stats(), false).map((p) => p.kind)).toEqual(['cpu', 'ram'])
    expect(hostParts(stats(), true).map((p) => p.kind)).toEqual(['ram'])
  })

  it('leaves out what is null', () => {
    expect(hostParts(stats({ cpu: null }), false).map((p) => p.kind)).toEqual([
      'ram',
    ])
    expect(hostParts(stats({ cpu: null, memory: null }), false)).toEqual([])
  })
})

describe('HostChip', () => {
  it('shows CPU, RAM and battery, and reads every value', () => {
    render(<HostChip stats={stats()} isMobile={false} onOpen={() => {}} />)
    const chip = screen.getByRole('button', {
      name: 'Host: CPU 23%, RAM 61%, battery 84%, charging. Open the host details',
    })
    expect(chip.textContent).toBe('CPU 23% · RAM 61%·84%')
    expect(chip.dataset.level).toBe('normal')
  })

  it('shows the higher part on a phone, but still reads both', () => {
    render(<HostChip stats={stats()} isMobile onOpen={() => {}} />)
    const chip = screen.getByRole('button', { name: /CPU 23%, RAM 61%/ })
    expect(chip.textContent).toBe('RAM 61%·84%')
  })

  it('colours by the worst part', () => {
    const { rerender } = render(
      <HostChip
        stats={stats({ cpu: { percent: 85, count: 8 } })}
        isMobile={false}
        onOpen={() => {}}
      />,
    )
    expect(screen.getByRole('button').dataset.level).toBe('warning')
    rerender(
      <HostChip
        stats={stats({
          battery: {
            percent: 8,
            charging: false,
            plugged: false,
            minutesLeft: 9,
          },
        })}
        isMobile={false}
        onOpen={() => {}}
      />,
    )
    expect(screen.getByRole('button').dataset.level).toBe('danger')
  })

  it('marks approximate memory and leaves out a missing battery', () => {
    render(
      <HostChip
        stats={stats({
          battery: null,
          memory: { total: 16 * GB, used: 6 * GB, percent: 37.5, approx: true },
        })}
        isMobile={false}
        onOpen={() => {}}
      />,
    )
    expect(screen.getByRole('button').textContent).toBe('CPU 23% · RAM ~38%')
  })

  it('renders nothing without a value to show', () => {
    const { container } = render(
      <HostChip
        stats={stats({ cpu: null, memory: null, battery: null })}
        isMobile={false}
        onOpen={() => {}}
      />,
    )
    expect(container.innerHTML).toBe('')
  })
})

describe('HeaderHostChip', () => {
  beforeEach(() => {
    mockFetch.mockReset()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reads nothing and shows nothing when the setting is off', async () => {
    const { container } = render(
      <HeaderHostChip enabled={false} isMobile={false} />,
    )
    await act(async () => {})
    expect(mockFetch).not.toHaveBeenCalled()
    expect(container.querySelector('button')).toBeNull()
  })

  it('shows nothing when the read fails', async () => {
    mockFetch.mockRejectedValue(new Error('down'))
    const { container } = render(<HeaderHostChip enabled isMobile={false} />)
    await act(async () => {})
    expect(container.querySelector('button')).toBeNull()
  })

  it('opens the Host sheet', async () => {
    mockFetch.mockResolvedValue(stats())
    render(<HeaderHostChip enabled isMobile={false} />)
    await act(async () => {})
    fireEvent.click(
      screen.getByRole('button', { name: /Open the host details/ }),
    )
    expect(await screen.findByRole('dialog', { name: 'Host' })).toBeTruthy()
    expect(screen.getByText('This machine')).toBeTruthy()
  })
})
