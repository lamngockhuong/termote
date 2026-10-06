import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LatestRelease } from '../hooks/use-update-check'
import { formatAgo, UpdatesSection } from './updates-section'

const mockCheck = vi.fn()
let mockState: {
  latest: LatestRelease | null
  checking: boolean
  failed: boolean
}

vi.mock('../hooks/use-update-check', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('../hooks/use-update-check')>()
  return {
    ...real,
    useUpdateCheck: () => ({ ...mockState, check: mockCheck }),
  }
})

// A fixed page version, so the comparisons do not change with each release
vi.mock('../utils/app-info', () => ({ APP_INFO: { version: '1.13.0' } }))

const LATEST: LatestRelease = {
  version: '1.14.0',
  url: 'https://github.com/lamngockhuong/termote/releases/tag/v1.14.0',
  checkedAt: Date.now(),
}

function renderSection(
  props: Partial<Parameters<typeof UpdatesSection>[0]> = {},
) {
  const onReload = vi.fn()
  render(
    <UpdatesSection
      server={{ version: '1.13.0', install: 'release' }}
      stale={false}
      onReload={onReload}
      {...props}
    />,
  )
  return { onReload }
}

describe('UpdatesSection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockState = { latest: null, checking: false, failed: false }
  })

  it('checks when shown, and again (forced) from the button', () => {
    renderSection()
    expect(mockCheck).toHaveBeenCalledWith()
    fireEvent.click(screen.getByRole('button', { name: /Check for updates/ }))
    expect(mockCheck).toHaveBeenCalledWith(true)
    expect(screen.getByText('Not checked yet')).toBeInTheDocument()
  })

  it('disables the button while checking', () => {
    mockState.checking = true
    renderSection()
    expect(screen.getByRole('button', { name: /Checking/ })).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('Checking for updates')
  })

  it('says the server is on the newest version', () => {
    mockState.latest = { ...LATEST, version: '1.13.0' }
    renderSection()
    expect(screen.getByText('Running v1.13.0')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(
      'You are on the newest version.',
    )
    expect(screen.queryByText(/Release notes/)).not.toBeInTheDocument()
  })

  // The update is the server's: this page may already be newer or older.
  it('compares the server version, not the page one', () => {
    mockState.latest = LATEST
    renderSection({ server: { version: '1.14.0', install: 'release' } })
    expect(screen.getByRole('status')).toHaveTextContent(
      'You are on the newest version.',
    )
  })

  it('names the command and the release notes for an installed release', () => {
    mockState.latest = LATEST
    renderSection()
    expect(screen.getAllByRole('status')[0]).toHaveTextContent(
      'Version 1.14.0 is available.',
    )
    expect(screen.getByText('termote update')).toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: 'Release notes for v1.14.0' }),
    ).toHaveAttribute('href', LATEST.url)
  })

  it('names the container update, run on the host', () => {
    mockState.latest = LATEST
    renderSection({ server: { version: '1.13.0', install: 'container' } })
    expect(
      screen.getByText('termote update && termote container up'),
    ).toBeInTheDocument()
    expect(screen.getByText(/not in this container/)).toBeInTheDocument()
  })

  // A checkout's commands differ by OS; an unknown install has none.
  it.each([
    ['checkout', /from a git checkout/],
    ['unknown', /the way it was installed/],
  ] as const)(
    'gives a %s install a hint and the release notes',
    (install, hint) => {
      mockState.latest = LATEST
      renderSection({ server: { version: '1.13.0', install } })
      expect(screen.getByText(hint)).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Copy' })).toBe(null)
      expect(screen.getByRole('link')).toBeInTheDocument()
    },
  )

  it('falls back to the page version before the server answered', () => {
    mockState.latest = LATEST
    renderSection({ server: null })
    expect(screen.getByText('Running v1.13.0')).toBeInTheDocument()
    expect(screen.queryByText('termote update')).toBe(null)
  })

  it('copies the command and says so', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    mockState.latest = LATEST
    renderSection()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    })
    expect(writeText).toHaveBeenCalledWith('termote update')
    expect(screen.getByText('Copied')).toBeInTheDocument()
    expect(screen.getByText('Command copied')).toHaveAttribute('role', 'status')
    // A second copy keeps "Copied" for 2s from then
    act(() => vi.advanceTimersByTime(1500))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copied' }))
    })
    act(() => vi.advanceTimersByTime(1500))
    expect(screen.getByText('Copied')).toBeInTheDocument()
    act(() => vi.advanceTimersByTime(500))
    expect(screen.queryByText('Copied')).toBe(null)
    vi.useRealTimers()
  })

  it('keeps the command selectable when the clipboard is refused', async () => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('no')) },
    })
    mockState.latest = LATEST
    renderSection()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    })
    expect(screen.queryByText('Copied')).toBe(null)
  })

  it('says GitHub could not be reached', () => {
    mockState.failed = true
    renderSection()
    expect(screen.getByRole('status')).toHaveTextContent(
      'Could not reach GitHub to check for updates.',
    )
  })

  it('offers the reload when this page is older than the server', () => {
    const { onReload } = renderSection({
      server: { version: '1.14.0', install: 'release' },
      stale: true,
    })
    expect(
      screen.getByText('This page is v1.13.0; reload to use v1.14.0.'),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    expect(onReload).toHaveBeenCalled()
  })

  it('disables the reload while it waits for the new version', () => {
    renderSection({
      server: { version: '1.14.0', install: 'release' },
      stale: true,
      reloading: true,
    })
    expect(screen.getByRole('button', { name: 'Reloading…' })).toBeDisabled()
  })

  it('formats how long ago it checked', () => {
    expect(formatAgo(30_000)).toBe('just now')
    expect(formatAgo(5 * 60_000)).toBe('5 min ago')
    expect(formatAgo(3 * 3_600_000)).toBe('3 h ago')
  })
})
