import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostStats } from '../hooks/use-mux-api'
import { HostDetails, HostSheet } from './host-sheet'

const GB = 1024 ** 3
const stats = (over: Partial<HostStats> = {}): HostStats => ({
  scope: 'host',
  cpu: { percent: 23, count: 8 },
  load: [1.23, 1, 0.5],
  memory: { total: 16 * GB, used: 8 * GB, percent: 50, approx: false },
  swap: { total: 2 * GB, used: GB / 2, percent: 25, approx: false },
  disks: [{ label: 'home', total: 500 * GB, free: 120 * GB, percent: 76 }],
  battery: { percent: 84, charging: false, plugged: false, minutesLeft: 125 },
  sampledAt: '2026-11-01T00:00:00Z',
  history: [
    { t: '2026-10-31T23:59:50Z', cpu: null, mem: 40 },
    { t: '2026-10-31T23:59:55Z', cpu: 10, mem: 45 },
    { t: '2026-11-01T00:00:00Z', cpu: 30, mem: 50 },
  ],
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

describe('HostDetails', () => {
  it('shows the scope, both lines, load and every meter', () => {
    render(<HostDetails stats={stats()} />)
    expect(screen.getByText('This machine')).toBeTruthy()
    expect(
      screen.getByRole('img', {
        name: 'CPU, last 15 min: now 23%, peak 30%',
      }),
    ).toBeTruthy()
    expect(
      screen.getByRole('img', {
        name: 'Memory, last 15 min: now 50%, peak 50%',
      }),
    ).toBeTruthy()
    expect(
      screen.getByText('1 min 1.23 · 5 min 1.00 · 15 min 0.50'),
    ).toBeTruthy()
    const meters = screen
      .getAllByRole('meter')
      .map((m) => m.getAttribute('aria-label'))
    expect(meters).toEqual(['Memory', 'Swap', 'Disk', 'Battery'])
    expect(screen.getByText('On battery · 2 h 05 min left')).toBeTruthy()
    expect(screen.getByText('120 GB free of 500 GB')).toBeTruthy()
  })

  it('names the WSL disks and the VM', () => {
    render(
      <HostDetails
        stats={stats({
          scope: 'wsl',
          disks: [
            { label: 'home', total: 1000 * GB, free: 900 * GB, percent: 10 },
            { label: 'windows', total: 500 * GB, free: 50 * GB, percent: 90 },
          ],
        })}
      />,
    )
    expect(screen.getByText('WSL virtual machine')).toBeTruthy()
    expect(
      screen.getByRole('meter', { name: 'Linux disk (virtual)' }),
    ).toBeTruthy()
    expect(
      screen.getByRole('meter', { name: 'Windows drive C:' }).dataset.level,
    ).toBe('warning')
  })

  it('says a container shows its own numbers, without a battery', () => {
    render(<HostDetails stats={stats({ scope: 'container', battery: null })} />)
    expect(screen.getByText('Container')).toBeTruthy()
    expect(screen.getByText(/the kernel's running the container/)).toBeTruthy()
    expect(screen.queryByRole('meter', { name: 'Battery' })).toBeNull()
  })

  it("names a container's memory limit", () => {
    render(
      <HostDetails
        stats={stats({
          scope: 'container',
          memory: {
            total: 2 * GB,
            used: GB,
            percent: 50,
            approx: false,
            limit: true,
          },
        })}
      />,
    )
    expect(screen.getByText('Memory · container limit')).toBeTruthy()
    expect(screen.getByText('1 GB of 2 GB used')).toBeTruthy()
  })

  it('hides the load on Windows and marks approximate memory', () => {
    render(
      <HostDetails
        stats={stats({
          load: null,
          swap: null,
          memory: { total: 16 * GB, used: 6 * GB, percent: 37.5, approx: true },
        })}
      />,
    )
    expect(screen.queryByText('Load average')).toBeNull()
    expect(screen.getByText('Memory · approximate')).toBeTruthy()
    expect(screen.queryByRole('meter', { name: 'Swap' })).toBeNull()
  })

  it('says when a line has no data yet', () => {
    render(<HostDetails stats={stats({ cpu: null, history: [] })} />)
    expect(screen.getByRole('img', { name: 'CPU: no data yet' })).toBeTruthy()
  })
})

describe('HostSheet', () => {
  it('says when nothing could be read', () => {
    render(<HostSheet isOpen onClose={() => {}} stats={undefined} />)
    expect(screen.getByText('Host stats are not available')).toBeTruthy()
  })
})
