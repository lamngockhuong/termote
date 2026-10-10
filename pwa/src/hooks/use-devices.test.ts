import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useDevices } from './use-devices'
import type { PairedDevice } from './use-mux-api'

const mocks = vi.hoisted(() => ({
  fetchDevices: vi.fn(),
  createPairingCode: vi.fn(),
  revokeDevice: vi.fn(),
}))

vi.mock('./use-mux-api', async (orig) => ({
  ...(await orig<typeof import('./use-mux-api')>()),
  fetchDevices: (...a: unknown[]) => mocks.fetchDevices(...a),
  createPairingCode: (...a: unknown[]) => mocks.createPairingCode(...a),
  revokeDevice: (...a: unknown[]) => mocks.revokeDevice(...a),
}))

const { RequestError } = await import('./use-mux-api')

const device = (id: string, current = false): PairedDevice => ({
  id,
  name: `Device ${id}`,
  role: 'full',
  createdAt: '2026-10-01T00:00:00Z',
  lastUsedAt: '2026-10-02T00:00:00Z',
  current,
  validUntil: null,
  expired: false,
  pairedBy: 'password',
})

beforeEach(() => {
  vi.resetAllMocks()
})

describe('useDevices', () => {
  it('reads nothing while disabled', () => {
    const { result } = renderHook(() => useDevices(false))
    expect(mocks.fetchDevices).not.toHaveBeenCalled()
    expect(result.current.devices).toBeNull()
    expect(result.current.error).toBeNull()
  })

  it('reads the list when enabled', async () => {
    mocks.fetchDevices.mockResolvedValue([device('a', true)])
    const { result } = renderHook(() => useDevices(true))
    await waitFor(() => expect(result.current.devices).toHaveLength(1))
    expect(result.current.devices![0].id).toBe('a')
    expect(result.current.error).toBeNull()
  })

  it('says why a read failed, and clears it on the next one that works', async () => {
    mocks.fetchDevices.mockRejectedValueOnce(new RequestError(500, '', 'x'))
    const { result } = renderHook(() => useDevices(true))
    await waitFor(() =>
      expect(result.current.error).toBe('Could not read the paired devices'),
    )
    expect(result.current.devices).toBeNull()

    mocks.fetchDevices.mockResolvedValueOnce([])
    await act(() => result.current.refresh())
    expect(result.current.error).toBeNull()
    expect(result.current.devices).toEqual([])
  })

  it('lets only the latest read land: an older answer never replaces it', async () => {
    let finishSlow!: (list: PairedDevice[]) => void
    mocks.fetchDevices
      .mockImplementationOnce(
        () => new Promise<PairedDevice[]>((r) => (finishSlow = r)),
      )
      .mockResolvedValueOnce([device('new')])
    const { result } = renderHook(() => useDevices(true))
    await act(() => result.current.refresh())
    expect(result.current.devices!.map((d) => d.id)).toEqual(['new'])
    await act(async () => finishSlow([device('old')]))
    expect(result.current.devices!.map((d) => d.id)).toEqual(['new'])
  })

  it('ignores an older read that fails after a newer one', async () => {
    let failSlow!: (err: unknown) => void
    mocks.fetchDevices
      .mockImplementationOnce(
        () => new Promise<PairedDevice[]>((_, rej) => (failSlow = rej)),
      )
      .mockResolvedValueOnce([device('new')])
    const { result } = renderHook(() => useDevices(true))
    await act(() => result.current.refresh())
    await act(async () => failSlow(new Error('late')))
    expect(result.current.error).toBeNull()
    expect(result.current.devices!.map((d) => d.id)).toEqual(['new'])
  })

  it('removes a revoked device at once and reads the list again', async () => {
    mocks.fetchDevices.mockResolvedValueOnce([device('a'), device('b')])
    mocks.revokeDevice.mockResolvedValue(['a'])
    const { result } = renderHook(() => useDevices(true))
    await waitFor(() => expect(result.current.devices).toHaveLength(2))
    mocks.fetchDevices.mockResolvedValueOnce([device('b')])
    await act(() => result.current.revoke('a'))
    expect(mocks.revokeDevice).toHaveBeenCalledWith('a')
    expect(mocks.fetchDevices).toHaveBeenCalledTimes(2)
    expect(result.current.devices!.map((d) => d.id)).toEqual(['b'])
  })

  it('removes every device the server revoked, and returns their ids', async () => {
    mocks.fetchDevices.mockResolvedValueOnce([
      device('a'),
      device('b'),
      device('c'),
    ])
    mocks.revokeDevice.mockResolvedValue(['a', 'c'])
    const { result } = renderHook(() => useDevices(true))
    await waitFor(() => expect(result.current.devices).toHaveLength(3))
    // The read after the revoke has not answered yet
    mocks.fetchDevices.mockReturnValue(new Promise(() => {}))
    let gone: string[] = []
    await act(async () => {
      gone = await result.current.revoke('a')
    })
    expect(gone).toEqual(['a', 'c'])
    expect(result.current.devices!.map((d) => d.id)).toEqual(['b'])
  })

  it('a device revoked meanwhile (another device, the CLI) is gone all the same', async () => {
    mocks.fetchDevices.mockResolvedValueOnce([device('a')])
    mocks.revokeDevice.mockRejectedValue(
      new RequestError(404, 'unknown_device', 'x'),
    )
    const { result } = renderHook(() => useDevices(true))
    await waitFor(() => expect(result.current.devices).toHaveLength(1))
    mocks.fetchDevices.mockResolvedValueOnce([])
    await act(() => result.current.revoke('a'))
    expect(result.current.devices).toEqual([])
  })

  it('a revoke that fails for another reason throws and keeps the list', async () => {
    mocks.fetchDevices.mockResolvedValueOnce([device('a')])
    const refused = new RequestError(500, 'internal', 'x')
    mocks.revokeDevice.mockRejectedValue(refused)
    const { result } = renderHook(() => useDevices(true))
    await waitFor(() => expect(result.current.devices).toHaveLength(1))
    await expect(result.current.revoke('a')).rejects.toBe(refused)
    expect(result.current.devices!.map((d) => d.id)).toEqual(['a'])
    expect(mocks.fetchDevices).toHaveBeenCalledTimes(1)
  })

  it('a revoke before the first read leaves the list unread', async () => {
    mocks.revokeDevice.mockResolvedValue(['a'])
    // The read after the revoke has not answered yet
    mocks.fetchDevices.mockReturnValue(new Promise(() => {}))
    const { result } = renderHook(() => useDevices(false))
    await act(() => result.current.revoke('a'))
    expect(result.current.devices).toBeNull()
  })

  it('pairs through the API, passing role, name and validity on', async () => {
    const code = { code: 'ABCDE-FGHIJ', expiresAt: 'x', url: 'u' }
    mocks.createPairingCode.mockResolvedValue(code)
    const { result } = renderHook(() => useDevices(false))
    await expect(result.current.pair('view', 'Phone', 3600)).resolves.toBe(code)
    expect(mocks.createPairingCode).toHaveBeenCalledWith('view', 'Phone', 3600)
  })
})
