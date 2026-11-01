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
  it('takes CPU and RAM, leaving out what is null', () => {
    expect(hostParts(stats()).map((p) => p.kind)).toEqual(['cpu', 'ram'])
    expect(hostParts(stats({ cpu: null })).map((p) => p.kind)).toEqual(['ram'])
    expect(hostParts(stats({ cpu: null, memory: null }))).toEqual([])
  })
})

describe('HostChip', () => {
  it('shows the higher of CPU and RAM, with every value in its name and tooltip', () => {
    render(<HostChip stats={stats()} isMobile={false} onOpen={() => {}} />)
    const chip = screen.getByRole('button', {
      name: 'Host: CPU 23%, RAM 61%, battery 84%, charging. Open the host details',
    })
    expect(chip.textContent).toBe('61%')
    expect(chip.title).toBe('Host: CPU 23%, RAM 61%, battery 84%, charging')
    expect(chip.dataset.level).toBe('normal')
  })

  it('shows CPU when it is the higher', () => {
    render(
      <HostChip
        stats={stats({ cpu: { percent: 90, count: 8 } })}
        isMobile
        onOpen={() => {}}
      />,
    )
    expect(screen.getByRole('button').textContent).toBe('90%')
    expect(screen.getByRole('button').dataset.level).toBe('warning')
  })

  it('shows the battery when it is the worst part, or all there is', () => {
    const low = { percent: 9, charging: false, plugged: false, minutesLeft: 12 }
    const { rerender } = render(
      <HostChip
        stats={stats({ battery: low })}
        isMobile={false}
        onOpen={() => {}}
      />,
    )
    expect(screen.getByRole('button').textContent).toBe('9%')
    expect(screen.getByRole('button').dataset.level).toBe('danger')
    rerender(
      <HostChip
        stats={stats({ cpu: null, memory: null })}
        isMobile={false}
        onOpen={() => {}}
      />,
    )
    expect(screen.getByRole('button').textContent).toBe('84%')
  })

  it('marks approximate memory', () => {
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
    expect(screen.getByRole('button').textContent).toBe('~38%')
  })

  it('hides below 360 px on a phone when the usage chip is beside it', () => {
    const { rerender } = render(
      <HostChip stats={stats()} isMobile crowded onOpen={() => {}} />,
    )
    expect(screen.getByRole('button').className).toContain('max-[359px]:hidden')
    rerender(<HostChip stats={stats()} isMobile onOpen={() => {}} />)
    expect(screen.getByRole('button').className).not.toContain('hidden')
    rerender(
      <HostChip stats={stats()} isMobile={false} crowded onOpen={() => {}} />,
    )
    expect(screen.getByRole('button').className).not.toContain('hidden')
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
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog', { name: 'Host' })).toBeNull()
  })
})
