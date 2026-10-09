import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DevicesState } from '../hooks/use-devices'
import type { PairedDevice } from '../hooks/use-mux-api'
import { DevicesSection } from './devices-section'

const hook = vi.hoisted(() => ({
  state: null as unknown as DevicesState,
}))
const mockRevokeDevice = vi.hoisted(() => vi.fn(async (_id: string) => {}))
vi.mock('../hooks/use-mux-api', async (orig) => ({
  ...(await orig<typeof import('../hooks/use-mux-api')>()),
  revokeDevice: (id: string) => mockRevokeDevice(id),
}))
vi.mock('../hooks/use-devices', () => ({
  useDevices: () => hook.state,
}))

vi.mock('./pair-device-sheet', () => ({
  PairDeviceSheet: (p: { isOpen: boolean; onClose: () => void }) =>
    p.isOpen ? (
      <div data-testid="pair-sheet">
        <button type="button" onClick={p.onClose}>
          ClosePair
        </button>
      </div>
    ) : null,
}))

const ago = (ms: number) => new Date(Date.now() - ms).toISOString()

const device = (over: Partial<PairedDevice> = {}): PairedDevice => ({
  id: 'd1',
  name: 'Phone',
  role: 'full',
  createdAt: ago(3 * 3600_000),
  lastUsedAt: ago(3 * 60_000),
  current: false,
  ...over,
})

function setState(over: Partial<DevicesState> = {}) {
  hook.state = {
    devices: [],
    error: null,
    refresh: vi.fn(async () => {}),
    revoke: vi.fn(async () => {}),
    pair: vi.fn(),
    ...over,
  }
  return hook.state
}

beforeEach(() => {
  mockRevokeDevice.mockReset()
  mockRevokeDevice.mockResolvedValue(undefined)
  HTMLDialogElement.prototype.showModal = vi.fn().mockImplementation(function (
    this: HTMLDialogElement,
  ) {
    this.setAttribute('open', '')
  })
  HTMLDialogElement.prototype.close = vi.fn()
})

describe('DevicesSection', () => {
  it('says no device is paired yet when the list is empty', () => {
    setState({ devices: [] })
    render(<DevicesSection />)
    expect(screen.getByText('No device is paired yet.')).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'Paired devices' })).toBeNull()
  })

  it('shows nothing about devices until the first read answers', () => {
    setState({ devices: null })
    render(<DevicesSection />)
    expect(screen.queryByText('No device is paired yet.')).toBeNull()
    expect(screen.queryByRole('list')).toBeNull()
  })

  it('lists each device with its role, last use and this device', () => {
    setState({
      devices: [
        device({ id: 'a', name: 'Phone', current: true }),
        device({
          id: 'b',
          name: 'Tablet',
          role: 'view',
          lastUsedAt: '',
          createdAt: ago(5 * 60_000),
        }),
      ],
    })
    render(<DevicesSection />)
    const list = screen.getByRole('list', { name: 'Paired devices' })
    const [phone, tablet] = within(list).getAllByRole('listitem')
    expect(within(phone).getByText('This device')).toBeInTheDocument()
    expect(phone).toHaveTextContent('Full · used 3 min ago')
    expect(tablet).toHaveTextContent('View only · paired 5 min ago')
    expect(within(tablet).queryByText('This device')).toBeNull()
  })

  it('reads a last use that is not a date as the pairing time', () => {
    setState({
      devices: [
        device({ lastUsedAt: 'not a date', createdAt: ago(7_200_000) }),
      ],
    })
    render(<DevicesSection />)
    expect(screen.getByRole('listitem')).toHaveTextContent(
      'Full · paired 2 h ago',
    )
  })

  it('shows the read error', () => {
    setState({ error: 'Could not read the paired devices' })
    render(<DevicesSection />)
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Could not read the paired devices',
    )
  })

  it('revokes another device after confirming, and keeps this page', async () => {
    const revoke = vi.fn(async () => {})
    setState({ devices: [device({ id: 'b', name: 'Tablet' })], revoke })
    const onSignedOut = vi.fn()
    render(<DevicesSection onSignedOut={onSignedOut} />)
    fireEvent.click(screen.getByRole('button', { name: 'Revoke Tablet' }))
    expect(screen.getByText('Revoke this device?')).toBeInTheDocument()
    expect(
      screen.getByText(
        'Tablet is signed out at its next request, and its open terminals close.',
      ),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }))
    await vi.waitFor(() => expect(revoke).toHaveBeenCalledWith('b'))
    expect(mockRevokeDevice).not.toHaveBeenCalled()
    expect(onSignedOut).not.toHaveBeenCalled()
  })

  it('signs this page out when it revokes its own device, without reading the list', async () => {
    const revoke = vi.fn(async () => {})
    const state = setState({
      devices: [device({ id: 'a', name: 'Phone', current: true })],
      revoke,
    })
    const onSignedOut = vi.fn()
    render(<DevicesSection onSignedOut={onSignedOut} />)
    fireEvent.click(screen.getByRole('button', { name: 'Revoke Phone' }))
    expect(
      screen.getByText(
        'This is the device you are using: it is signed out at once.',
      ),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }))
    await vi.waitFor(() => expect(onSignedOut).toHaveBeenCalledTimes(1))
    expect(mockRevokeDevice).toHaveBeenCalledWith('a')
    expect(revoke).not.toHaveBeenCalled()
    expect(state.refresh).not.toHaveBeenCalled()
  })

  it('says why signing this device out failed, and stays signed in', async () => {
    mockRevokeDevice.mockRejectedValueOnce(new Error('down'))
    const onSignedOut = vi.fn()
    setState({ devices: [device({ id: 'a', name: 'Phone', current: true })] })
    render(<DevicesSection onSignedOut={onSignedOut} />)
    fireEvent.click(screen.getByRole('button', { name: 'Revoke Phone' }))
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }))
    expect(
      await screen.findByText('Could not revoke Phone. Try again'),
    ).toBeInTheDocument()
    expect(onSignedOut).not.toHaveBeenCalled()
  })

  it('signs out to the sign-in page by default', async () => {
    const assign = vi.fn()
    vi.stubGlobal('location', { ...window.location, assign })
    try {
      setState({
        devices: [device({ id: 'a', name: 'Phone', current: true })],
      })
      render(<DevicesSection />)
      fireEvent.click(screen.getByRole('button', { name: 'Revoke Phone' }))
      fireEvent.click(screen.getByRole('button', { name: 'Revoke' }))
      await vi.waitFor(() => expect(assign).toHaveBeenCalledWith('/login'))
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('says why a revoke failed and keeps the device listed', async () => {
    const revoke = vi.fn(async () => {
      throw new Error('down')
    })
    setState({ devices: [device({ id: 'b', name: 'Tablet' })], revoke })
    render(<DevicesSection />)
    fireEvent.click(screen.getByRole('button', { name: 'Revoke Tablet' }))
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }))
    expect(
      await screen.findByText('Could not revoke Tablet. Try again'),
    ).toBeInTheDocument()
    expect(screen.getByRole('listitem')).toHaveTextContent('Tablet')
  })

  it('cancelling the confirmation revokes nothing', () => {
    const revoke = vi.fn()
    setState({ devices: [device({ id: 'b', name: 'Tablet' })], revoke })
    render(<DevicesSection />)
    fireEvent.click(screen.getByRole('button', { name: 'Revoke Tablet' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(revoke).not.toHaveBeenCalled()
    expect(screen.queryByText('Revoke this device?')).toBeNull()
  })

  it('opens the pairing sheet, and reads the list again when it closes', () => {
    const refresh = vi.fn(async () => {})
    setState({ refresh })
    render(<DevicesSection />)
    expect(screen.queryByTestId('pair-sheet')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Pair a device' }))
    expect(screen.getByTestId('pair-sheet')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'ClosePair' }))
    expect(screen.queryByTestId('pair-sheet')).toBeNull()
    expect(refresh).toHaveBeenCalledTimes(1)
  })
})
