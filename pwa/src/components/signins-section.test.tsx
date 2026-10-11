import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SignedInBrowser } from '../hooks/use-mux-api'
import type { SigninsState } from '../hooks/use-signins'
import { browserLabel, SigninsSection } from './signins-section'

const hook = vi.hoisted(() => ({
  state: null as unknown as SigninsState,
}))
const mockRevokeSignin = vi.hoisted(() => vi.fn(async (_id: string) => {}))
vi.mock('../hooks/use-mux-api', async (orig) => ({
  ...(await orig<typeof import('../hooks/use-mux-api')>()),
  revokeSignin: (id: string) => mockRevokeSignin(id),
}))
vi.mock('../hooks/use-signins', () => ({
  useSignins: () => hook.state,
}))

const ago = (ms: number) => new Date(Date.now() - ms).toISOString()

const FIREFOX =
  'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0'
const SAFARI_IOS =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'

const browser = (over: Partial<SignedInBrowser> = {}): SignedInBrowser => ({
  id: 'aaaaaaaaaaaaaaaa',
  createdAt: ago(3 * 3600_000),
  lastUsedAt: ago(3 * 60_000),
  expiresAt: ago(-21 * 3600_000),
  via: 'form',
  ip: '192.0.2.9',
  userAgent: FIREFOX,
  current: false,
  ...over,
})

function setState(over: Partial<SigninsState> = {}) {
  hook.state = {
    sessions: [],
    canRevoke: true,
    error: null,
    refresh: vi.fn(async () => {}),
    revoke: vi.fn(async () => {}),
    revokeOthers: vi.fn(async () => 0),
    ...over,
  }
  return hook.state
}

beforeEach(() => {
  mockRevokeSignin.mockReset()
  mockRevokeSignin.mockResolvedValue(undefined)
  HTMLDialogElement.prototype.showModal = vi.fn().mockImplementation(function (
    this: HTMLDialogElement,
  ) {
    this.setAttribute('open', '')
  })
  HTMLDialogElement.prototype.close = vi.fn()
})

describe('browserLabel', () => {
  it.each([
    [FIREFOX, 'Firefox on Linux'],
    [SAFARI_IOS, 'Safari on iOS'],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36 Edg/129.0',
      'Edge on Windows',
    ],
    [
      'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36',
      'Chrome on Android',
    ],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36 OPR/114.0',
      'Opera on macOS',
    ],
    [
      'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36',
      'Chrome on ChromeOS',
    ],
    ['Firefox/131.0', 'Firefox'],
    ['curl/8.5.0', 'curl'],
    ['Mozilla/5.0 (Windows NT 10.0)', 'A browser on Windows'],
    ['Mozilla/5.0', 'Unknown browser'],
    ['', 'Unknown browser'],
  ])('names %j as %j', (ua, want) => {
    expect(browserLabel(ua)).toBe(want)
  })
})

describe('SigninsSection', () => {
  it('says the cookie is what a sign-out ends', () => {
    setState()
    render(<SigninsSection />)
    expect(
      screen.getByText(/Signing out ends the browser's cookie/),
    ).toHaveTextContent('termote start --fresh')
  })

  it('says when no browser is signed in, and nothing before the first read', () => {
    setState({ sessions: [] })
    const { unmount } = render(<SigninsSection />)
    expect(
      screen.getByText('No browser is signed in with the password.'),
    ).toBeInTheDocument()
    unmount()
    setState({ sessions: null })
    render(<SigninsSection />)
    expect(screen.queryByRole('list')).toBeNull()
    expect(
      screen.queryByText('No browser is signed in with the password.'),
    ).toBeNull()
  })

  it('lists each browser with how and where it signed in, and this browser', () => {
    setState({
      sessions: [
        browser({ id: 'a', current: true }),
        browser({
          id: 'b',
          userAgent: SAFARI_IOS,
          via: 'basic',
          ip: '',
          lastUsedAt: ago(2 * 3600_000),
        }),
        browser({ id: 'c', via: 'link', ip: '127.0.0.1' }),
      ],
    })
    render(<SigninsSection />)
    const list = screen.getByRole('list', { name: 'Signed-in browsers' })
    const [mine, phone, link] = within(list).getAllByRole('listitem')
    expect(mine).toHaveTextContent('Firefox on LinuxThis browser')
    expect(mine).toHaveTextContent('Sign-in form · 192.0.2.9 · used 3 min ago')
    expect(within(mine).getByText(/Firefox on Linux/)).toHaveAttribute(
      'title',
      FIREFOX,
    )
    expect(phone).toHaveTextContent('Safari on iOS')
    expect(phone).toHaveTextContent('Basic auth · used 2 h ago')
    expect(within(phone).queryByText('This browser')).toBeNull()
    expect(link).toHaveTextContent('Link from the CLI · 127.0.0.1')
  })

  it('shows the read error', () => {
    setState({ error: 'Could not read the signed-in browsers' })
    render(<SigninsSection />)
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Could not read the signed-in browsers',
    )
  })

  it('a paired device sees the list but no button', () => {
    setState({
      canRevoke: false,
      sessions: [browser({ id: 'a' }), browser({ id: 'b' })],
    })
    render(<SigninsSection />)
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(screen.queryByRole('button', { name: /Sign out/ })).toBeNull()
  })

  it('signs another browser out after confirming, and keeps this page', async () => {
    const revoke = vi.fn(async () => {})
    setState({
      sessions: [
        browser({ id: 'me', current: true }),
        browser({ id: 'b', userAgent: SAFARI_IOS }),
      ],
      revoke,
    })
    const onSignedOut = vi.fn()
    render(<SigninsSection onSignedOut={onSignedOut} />)
    fireEvent.click(
      screen.getByRole('button', { name: 'Sign out Safari on iOS' }),
    )
    expect(screen.getByText('Sign out this browser?')).toBeInTheDocument()
    expect(
      screen.getByText(
        'Safari on iOS is signed out at its next request, and its open terminals close.',
      ),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    await vi.waitFor(() => expect(revoke).toHaveBeenCalledWith('b'))
    expect(mockRevokeSignin).not.toHaveBeenCalled()
    expect(onSignedOut).not.toHaveBeenCalled()
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Signed out Safari on iOS',
    )
  })

  it('signing this browser out leaves the page at once', async () => {
    const revoke = vi.fn(async () => {})
    setState({ sessions: [browser({ id: 'me', current: true })], revoke })
    const onSignedOut = vi.fn()
    render(<SigninsSection onSignedOut={onSignedOut} />)
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Sign out Firefox on Linux (this browser)',
      }),
    )
    expect(
      screen.getByText(
        'This is the browser you are using: it is signed out at once.',
      ),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    await vi.waitFor(() => expect(onSignedOut).toHaveBeenCalled())
    expect(mockRevokeSignin).toHaveBeenCalledWith('me')
    expect(revoke).not.toHaveBeenCalled()
  })

  it('goes to the sign-in page by default once this browser is signed out', async () => {
    const assign = vi.fn()
    vi.stubGlobal('location', { ...window.location, assign })
    try {
      setState({ sessions: [browser({ id: 'me', current: true })] })
      render(<SigninsSection />)
      fireEvent.click(
        screen.getByRole('button', {
          name: 'Sign out Firefox on Linux (this browser)',
        }),
      )
      fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
      await vi.waitFor(() => expect(assign).toHaveBeenCalledWith('/login'))
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('shows a way of signing in it does not know as the server names it', () => {
    setState({
      sessions: [
        browser({ via: 'qr' as SignedInBrowser['via'], ip: '', userAgent: '' }),
      ],
    })
    render(<SigninsSection />)
    expect(screen.getByRole('listitem')).toHaveTextContent(
      'qr · used 3 min ago',
    )
  })

  it('signs this browser out through the Log out of the app when given one', async () => {
    const logOut = vi.fn(async () => {})
    const revoke = vi.fn(async () => {})
    setState({ sessions: [browser({ id: 'me', current: true })], revoke })
    const onSignedOut = vi.fn()
    render(<SigninsSection logOut={logOut} onSignedOut={onSignedOut} />)
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Sign out Firefox on Linux (this browser)',
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    await vi.waitFor(() => expect(logOut).toHaveBeenCalledTimes(1))
    expect(mockRevokeSignin).not.toHaveBeenCalled()
    expect(revoke).not.toHaveBeenCalled()
    expect(onSignedOut).not.toHaveBeenCalled()
  })

  it('says when a sign-out fails', async () => {
    setState({
      sessions: [browser({ id: 'b' })],
      revoke: vi.fn(async () => {
        throw new Error('refused')
      }),
    })
    render(<SigninsSection />)
    fireEvent.click(
      screen.getByRole('button', { name: 'Sign out Firefox on Linux' }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not sign Firefox on Linux out. Try again',
    )
  })

  it('cancelling a sign-out does nothing', () => {
    const revoke = vi.fn(async () => {})
    setState({ sessions: [browser({ id: 'b' })], revoke })
    render(<SigninsSection />)
    fireEvent.click(
      screen.getByRole('button', { name: 'Sign out Firefox on Linux' }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(revoke).not.toHaveBeenCalled()
  })

  it('signs every other browser out, offered only when there is one', async () => {
    setState({ sessions: [browser({ id: 'me', current: true })] })
    const { unmount } = render(<SigninsSection />)
    expect(
      screen.queryByRole('button', { name: 'Sign out all others' }),
    ).toBeNull()
    unmount()

    const revokeOthers = vi.fn(async () => 2)
    setState({
      sessions: [
        browser({ id: 'me', current: true }),
        browser({ id: 'b' }),
        browser({ id: 'c' }),
      ],
      revokeOthers,
    })
    render(<SigninsSection />)
    fireEvent.click(screen.getByRole('button', { name: 'Sign out all others' }))
    expect(
      screen.getByText('Sign out every other browser?'),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/2 browsers are signed out at the next request/),
    ).toHaveTextContent('This browser stays signed in.')
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Signed out 2 other browsers',
    )
    expect(revokeOthers).toHaveBeenCalledTimes(1)
  })

  it('names one other browser in the singular, and says when all others fail', async () => {
    const revokeOthers = vi
      .fn<() => Promise<number>>()
      .mockResolvedValueOnce(1)
      .mockRejectedValueOnce(new Error('refused'))
    setState({ sessions: [browser({ id: 'b' })], revokeOthers })
    render(<SigninsSection />)
    fireEvent.click(screen.getByRole('button', { name: 'Sign out all others' }))
    expect(
      screen.getByText(/1 browser is signed out at the next request/),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Signed out 1 other browser',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Sign out all others' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not sign the other browsers out. Try again',
    )
  })
})
