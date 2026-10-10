import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type PairingCode, RequestError } from '../hooks/use-mux-api'
import {
  formatLeft,
  PairDeviceSheet,
  pairProblem,
  validityChoices,
  validityNote,
} from './pair-device-sheet'

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn().mockImplementation(function (
    this: HTMLDialogElement,
  ) {
    this.setAttribute('open', '')
  })
  HTMLDialogElement.prototype.close = vi.fn()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const inMs = (ms: number) => new Date(Date.now() + ms).toISOString()

const made = (over: Partial<PairingCode> = {}): PairingCode => ({
  code: 'ABCDE-FGHIJ',
  expiresAt: inMs(5 * 60_000),
  expiresIn: 300,
  url: 'https://box.local:7680/pair?code=ABCDE-FGHIJ',
  qr: 'data:image/png;base64,AAAA',
  ...over,
})

function renderSheet(
  onPair: (
    role: 'view' | 'full',
    name: string,
    validFor: number | null,
  ) => Promise<PairingCode> = vi.fn(async () => made()),
  onClose = vi.fn(),
  extra: { canPairFull?: boolean; validityLeft?: number } = {},
) {
  const view = render(
    <PairDeviceSheet isOpen onClose={onClose} onPair={onPair} {...extra} />,
  )
  return { ...view, onClose, onPair }
}

const validityField = () =>
  screen.getByLabelText('Stays signed in for') as HTMLSelectElement

const nameField = () => screen.getByRole('textbox') as HTMLInputElement

describe('pairProblem', () => {
  it.each([
    [
      new RequestError(429, 'too_many_codes', 'x'),
      'Too many codes are waiting. Use one, or wait 5 minutes',
    ],
    [
      new RequestError(400, 'invalid_name', 'x'),
      'Use a shorter name without special characters',
    ],
    [new RequestError(403, 'view_only', 'x'), 'This device is view-only'],
    [
      new RequestError(403, 'full_needs_password', 'x'),
      'A full device is paired from a password sign-in or the CLI',
    ],
    [
      new RequestError(409, 'creator_gone', 'x'),
      'This device can no longer pair devices',
    ],
    [
      new RequestError(400, 'invalid_validity', 'x'),
      'Pick how long the new device stays signed in',
    ],
    [
      new RequestError(500, 'internal', 'x'),
      'Could not make a pairing code. Try again',
    ],
    [new Error('offline'), 'Could not make a pairing code. Try again'],
  ])('%s', (err, want) => {
    expect(pairProblem(err)).toBe(want)
  })
})

describe('validityChoices', () => {
  it('offers every choice, Never included, without a limit of its own', () => {
    expect(validityChoices().map((o) => [o.label, o.disabled])).toEqual([
      ['1 day', false],
      ['7 days', false],
      ['30 days', false],
      ['90 days', false],
      ['Never', false],
    ])
  })

  it('a limited device gets no Never and nothing longer than it has left', () => {
    expect(
      validityChoices(10 * 86400).map((o) => [o.label, o.disabled]),
    ).toEqual([
      ['1 day', false],
      ['7 days', false],
      ['30 days', true],
      ['90 days', true],
    ])
    // Less than a day left: the shortest stays, the server cuts it.
    expect(validityChoices(3600).filter((o) => !o.disabled)).toHaveLength(1)
  })
})

describe('validityNote', () => {
  it.each([
    [undefined, 'stays signed in with no time limit'],
    [0, 'stays signed in with no time limit'],
    [86400, 'stays signed in for 1 day'],
    [30 * 86400, 'stays signed in for 30 days'],
    [3600, 'stays signed in for 1 hour'],
    [7000, 'stays signed in for 2 hours'],
  ])('%s', (secs, want) => {
    expect(validityNote(secs)).toBe(want)
  })
})

describe('formatLeft', () => {
  it.each([
    [300_000, '5:00'],
    [299_999, '5:00'],
    [65_000, '1:05'],
    [59_000, '0:59'],
    [1, '0:01'],
    [0, '0:00'],
    [-5_000, '0:00'],
  ])('%i ms reads %s', (ms, want) => {
    expect(formatLeft(ms)).toBe(want)
  })
})

describe('PairDeviceSheet', () => {
  it('renders nothing while closed', () => {
    const { container } = render(
      <PairDeviceSheet isOpen={false} onClose={vi.fn()} onPair={vi.fn()} />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('offers a view-only device by default, and explains each role', () => {
    renderSheet()
    expect(screen.getByRole('radio', { name: 'View only' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    expect(
      screen.getByText(
        'Watches the terminal, Chat and Files; changes nothing.',
      ),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: 'Full' }))
    expect(
      screen.getByText(
        'Everything this device can do: typing, files, agents, devices.',
      ),
    ).toBeInTheDocument()
  })

  it('makes a code for the chosen role and the trimmed name', async () => {
    const onPair = vi.fn(async () => made())
    renderSheet(onPair)
    fireEvent.click(screen.getByRole('radio', { name: 'Full' }))
    fireEvent.change(nameField(), { target: { value: '  Phone  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Make code' }))
    expect(onPair).toHaveBeenCalledWith('full', 'Phone', 30 * 86400)
    expect(await screen.findByLabelText('Pairing code')).toHaveTextContent(
      'ABCDE-FGHIJ',
    )
  })

  it('refuses a name longer than 64 bytes, though it has fewer characters', () => {
    const onPair = vi.fn()
    renderSheet(onPair)
    // 40 characters of 2 bytes each: 80 bytes
    fireEvent.change(nameField(), { target: { value: 'é'.repeat(40) } })
    fireEvent.click(screen.getByRole('button', { name: 'Make code' }))
    expect(onPair).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Use a name of at most 64 characters',
    )
    expect(nameField()).toHaveAttribute('aria-invalid', 'true')
    expect(nameField()).toHaveAttribute('aria-describedby')
  })

  it('accepts a 64-byte name', async () => {
    const onPair = vi.fn(async () => made())
    renderSheet(onPair)
    fireEvent.change(nameField(), { target: { value: 'a'.repeat(64) } })
    fireEvent.click(screen.getByRole('button', { name: 'Make code' }))
    await waitFor(() =>
      expect(onPair).toHaveBeenCalledWith('view', 'a'.repeat(64), 30 * 86400),
    )
  })

  it('says why a code was refused, and clears it when the name changes', async () => {
    const onPair = vi.fn(async () => {
      throw new RequestError(429, 'too_many_codes', 'x')
    })
    renderSheet(onPair)
    fireEvent.click(screen.getByRole('button', { name: 'Make code' }))
    expect(
      await screen.findByText(
        'Too many codes are waiting. Use one, or wait 5 minutes',
      ),
    ).toBeInTheDocument()
    expect(nameField()).toHaveAttribute('aria-invalid', 'true')
    fireEvent.change(nameField(), { target: { value: 'x' } })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(nameField()).not.toHaveAttribute('aria-invalid')
  })

  it('disables Make code while a request is out', async () => {
    let answer!: (c: PairingCode) => void
    const onPair = vi.fn(() => new Promise<PairingCode>((r) => (answer = r)))
    renderSheet(onPair)
    fireEvent.click(screen.getByRole('button', { name: 'Make code' }))
    expect(screen.getByRole('button', { name: 'Make code' })).toBeDisabled()
    await act(async () => answer(made()))
    expect(await screen.findByLabelText('Pairing code')).toBeInTheDocument()
  })

  it('shows the code, its QR code, the countdown and the link', async () => {
    renderSheet()
    fireEvent.click(screen.getByRole('button', { name: 'Make code' }))
    expect(
      await screen.findByRole('img', { name: 'QR code of the pairing link' }),
    ).toHaveAttribute('src', 'data:image/png;base64,AAAA')
    expect(screen.getByText('Expires in 5:00 · works once')).toBeInTheDocument()
    expect(
      screen.getByText('https://box.local:7680/pair?code=ABCDE-FGHIJ'),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Copy link' }),
    ).toBeInTheDocument()
  })

  it('shows a code whose lifetime the server did not say as expired', async () => {
    renderSheet(vi.fn(async () => made({ expiresIn: undefined })))
    fireEvent.click(screen.getByRole('button', { name: 'Make code' }))
    expect(
      await screen.findByText('This code expired. Make a new one.'),
    ).toBeInTheDocument()
  })

  it('shows no QR code when the server sent none', async () => {
    renderSheet(vi.fn(async () => made({ qr: undefined })))
    fireEvent.click(screen.getByRole('button', { name: 'Make code' }))
    await screen.findByLabelText('Pairing code')
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('counts down once a second, then says the code expired and offers a new one', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false })
    vi.setSystemTime(new Date('2026-10-09T10:00:00Z'))
    const onPair = vi.fn(async () => made({ expiresIn: 62 }))
    renderSheet(onPair)
    fireEvent.click(screen.getByRole('button', { name: 'Make code' }))
    await act(async () => {})
    expect(screen.getByText('Expires in 1:02 · works once')).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(screen.getByText('Expires in 1:01 · works once')).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(62_000)
    })
    expect(
      screen.getByText('This code expired. Make a new one.'),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Copy link' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'New code' }))
    expect(
      screen.getByRole('button', { name: 'Make code' }),
    ).toBeInTheDocument()
    expect(screen.queryByLabelText('Pairing code')).toBeNull()
  })

  it('copies the link and says so, then reads Copied', async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    renderSheet()
    fireEvent.click(screen.getByRole('button', { name: 'Make code' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Copy link' }))
    expect(writeText).toHaveBeenCalledWith(
      'https://box.local:7680/pair?code=ABCDE-FGHIJ',
    )
    expect(
      await screen.findByRole('button', { name: 'Copied' }),
    ).toBeInTheDocument()
  })

  it('a clipboard that refuses leaves the link selectable, without a Copied', async () => {
    const writeText = vi.fn(async () => {
      throw new Error('insecure')
    })
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    renderSheet()
    fireEvent.click(screen.getByRole('button', { name: 'Make code' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Copy link' }))
    await waitFor(() => expect(writeText).toHaveBeenCalled())
    expect(
      screen.getByRole('button', { name: 'Copy link' }),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Copied' })).toBeNull()
  })

  it('Cancel closes the sheet', async () => {
    const { onClose } = renderSheet()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('Done closes the sheet from the code', async () => {
    const { onClose } = renderSheet()
    fireEvent.click(screen.getByRole('button', { name: 'Make code' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Done' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('a code that comes back after the sheet closed shows nothing', async () => {
    let answer!: (c: PairingCode) => void
    const onPair = vi.fn(() => new Promise<PairingCode>((r) => (answer = r)))
    const { rerender, unmount } = renderSheet(onPair)
    fireEvent.click(screen.getByRole('button', { name: 'Make code' }))
    rerender(
      <PairDeviceSheet isOpen={false} onClose={vi.fn()} onPair={onPair} />,
    )
    await act(async () => answer(made()))
    expect(screen.queryByLabelText('Pairing code')).toBeNull()
    unmount()
  })

  it('a refusal that comes back after the sheet closed shows nothing', async () => {
    let refuse!: (e: unknown) => void
    const onPair = vi.fn(
      () => new Promise<PairingCode>((_, rej) => (refuse = rej)),
    )
    const { rerender } = renderSheet(onPair)
    fireEvent.click(screen.getByRole('button', { name: 'Make code' }))
    rerender(
      <PairDeviceSheet isOpen={false} onClose={vi.fn()} onPair={onPair} />,
    )
    await act(async () => refuse(new RequestError(500, '', 'x')))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('defaults to 30 days, sends Never as no limit and says how long once made', async () => {
    const { onPair } = renderSheet(vi.fn(async () => made({ validFor: 0 })))
    expect(validityField().value).toBe(String(30 * 86400))
    fireEvent.change(validityField(), { target: { value: 'never' } })
    fireEvent.click(screen.getByRole('button', { name: 'Make code' }))
    await waitFor(() => expect(onPair).toHaveBeenCalledWith('view', '', null))
    expect(
      await screen.findByText(
        'The new device stays signed in with no time limit.',
      ),
    ).toBeInTheDocument()
  })

  it('sends the chosen limit', async () => {
    const { onPair } = renderSheet()
    fireEvent.change(validityField(), { target: { value: String(86400) } })
    fireEvent.click(screen.getByRole('button', { name: 'Make code' }))
    await waitFor(() => expect(onPair).toHaveBeenCalledWith('view', '', 86400))
  })

  it('on a paired device, offers view only, says why, and links the security model', async () => {
    const { onPair } = renderSheet(undefined, undefined, { canPairFull: false })
    expect(screen.queryByRole('radiogroup')).toBeNull()
    expect(screen.getByText('termote pair --role full')).toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: 'Security model' }),
    ).toHaveAttribute('href', 'https://termote.ohnice.app/usage/security/')
    fireEvent.click(screen.getByRole('button', { name: 'Make code' }))
    await waitFor(() =>
      expect(onPair).toHaveBeenCalledWith('view', '', 30 * 86400),
    )
  })

  it('a device with a limit cannot outlast it: no Never, the longest it may pick', () => {
    renderSheet(undefined, undefined, { validityLeft: 10 * 86400 })
    const labels = [...validityField().options].map((o) => o.textContent)
    expect(labels).not.toContain('Never')
    expect(validityField().value).toBe(String(7 * 86400))
    expect(screen.getByText("Can't outlast this device")).toBeInTheDocument()
  })
})
