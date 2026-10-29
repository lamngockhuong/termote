import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '../types/session'
import {
  registerInstallPrompt,
  resetInstallPromptForTest,
} from '../utils/install-prompt'
import { WELCOME_VERSION } from '../utils/welcome'
import { WELCOME_READY_MS, WelcomeHost } from './welcome-host'

const devices = vi.hoisted(() => ({
  list: null as unknown[] | null,
  enabled: [] as boolean[],
}))
vi.mock('../hooks/use-devices', () => ({
  useDevices: (enabled: boolean) => {
    devices.enabled.push(enabled)
    return { devices: devices.list }
  },
}))
const install = vi.hoisted(() => ({ prompt: vi.fn(async () => true) }))
vi.mock('../utils/install-prompt', async (orig) => ({
  ...(await orig<typeof import('../utils/install-prompt')>()),
  promptInstall: install.prompt,
}))

const shell: Session = { id: 's1', name: 'api', icon: '', description: '' }
const blocked: Session = {
  ...shell,
  id: 's2',
  panes: [
    { id: 'p1', label: 'claude', hasAgent: true, agentStatus: 'blocked' },
  ],
}

function props(over: Partial<Parameters<typeof WelcomeHost>[0]> = {}) {
  return {
    ready: true,
    suppressed: false,
    openRequest: 0,
    mobile: true,
    backend: 'tmux',
    sessions: [shell],
    readOnly: false,
    devices: false,
    areas: { chat: true, files: true, tasks: true, panes: true },
    version: '2.13.0',
    keys: {},
    onOpenPane: vi.fn(),
    onOpenTerminal: vi.fn(),
    onStartSession: vi.fn(),
    onOpenSettings: vi.fn(),
    ...over,
  }
}

const saved = () => JSON.parse(localStorage.getItem('termote-settings') ?? '{}')
const welcome = () => screen.queryByTestId('welcome')

describe('WelcomeHost', () => {
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = vi.fn(function (
      this: HTMLDialogElement,
    ) {
      this.setAttribute('open', '')
    })
    HTMLDialogElement.prototype.close = vi.fn()
    devices.list = null
    devices.enabled = []
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    resetInstallPromptForTest()
  })

  it('shows once the sessions are in, and marks it seen at once', () => {
    const { rerender } = render(<WelcomeHost {...props({ ready: false })} />)
    expect(welcome()).toBeNull()
    rerender(<WelcomeHost {...props()} />)
    expect(welcome()).toBeInTheDocument()
    expect(saved().welcomeSeenVersion).toBe(WELCOME_VERSION)
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }))
    expect(welcome()).toBeNull()
  })

  it('stays away on a device that saw it', () => {
    localStorage.setItem(
      'termote-settings',
      JSON.stringify({ welcomeSeenVersion: WELCOME_VERSION }),
    )
    render(<WelcomeHost {...props()} />)
    expect(welcome()).toBeNull()
  })

  it('gives up for this visit when the sessions never come', () => {
    vi.useFakeTimers()
    const { rerender } = render(<WelcomeHost {...props({ ready: false })} />)
    act(() => vi.advanceTimersByTime(WELCOME_READY_MS))
    rerender(<WelcomeHost {...props()} />)
    expect(welcome()).toBeNull()
    expect(saved().welcomeSeenVersion).toBeUndefined()
  })

  it('waits for the next visit when suppressed (a link, a focus window)', () => {
    const { rerender } = render(
      <WelcomeHost {...props({ suppressed: true })} />,
    )
    rerender(<WelcomeHost {...props({ suppressed: false })} />)
    expect(welcome()).toBeNull()
    expect(saved().welcomeSeenVersion).toBeUndefined()
  })

  it('opens again when Settings asks', () => {
    localStorage.setItem(
      'termote-settings',
      JSON.stringify({ welcomeSeenVersion: 1 }),
    )
    const { rerender } = render(<WelcomeHost {...props()} />)
    rerender(<WelcomeHost {...props({ openRequest: 1 })} />)
    expect(welcome()).toBeInTheDocument()
  })

  it('the main button opens the terminal, or the waiting pane', () => {
    const p = props()
    const { unmount } = render(<WelcomeHost {...p} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open the terminal' }))
    expect(p.onOpenTerminal).toHaveBeenCalled()
    expect(welcome()).toBeNull()
    unmount()
    const q = props({ sessions: [blocked], openRequest: 1 })
    render(<WelcomeHost {...q} />)
    fireEvent.click(
      screen.getByRole('button', { name: 'Open the pane that needs you' }),
    )
    expect(q.onOpenPane).toHaveBeenCalledWith({
      sessionId: 's2',
      paneId: 'p1',
      agent: 'claude',
      tab: 'api',
    })
  })

  it('runs each card, closing for all but the install prompt', async () => {
    registerInstallPrompt()
    Object.defineProperty(navigator, 'serviceWorker', {
      value: {},
      configurable: true,
    })
    vi.stubGlobal('Notification', { permission: 'default' })
    const p = props({ sessions: [blocked], openRequest: 1 })
    const { unmount } = render(<WelcomeHost {...p} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(p.onOpenPane).toHaveBeenCalled()
    unmount()

    const q = props({ sessions: [], openRequest: 1 })
    const second = render(<WelcomeHost {...q} />)
    fireEvent.click(screen.getByRole('button', { name: 'New' }))
    expect(q.onStartSession).toHaveBeenCalled()
    second.unmount()

    const r = props({ openRequest: 1 })
    const third = render(<WelcomeHost {...r} />)
    fireEvent.click(screen.getByRole('button', { name: 'Turn on' }))
    expect(r.onOpenSettings).toHaveBeenCalledWith('sessions')
    third.unmount()

    vi.stubGlobal('Notification', { permission: 'granted' })
    localStorage.setItem(
      'termote-settings',
      JSON.stringify({ notifyAgents: true }),
    )
    window.dispatchEvent(
      Object.assign(new Event('beforeinstallprompt'), { prompt: vi.fn() }),
    )
    devices.list = []
    const s = props({ mobile: false, devices: true, openRequest: 1 })
    render(<WelcomeHost {...s} />)
    expect(devices.enabled).toContain(true)
    expect(screen.getByText('On', { selector: 'dd' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(install.prompt).toHaveBeenCalled()
    expect(welcome()).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Pair' }))
    expect(s.onOpenSettings).toHaveBeenCalledWith('devices')
    delete (navigator as { serviceWorker?: unknown }).serviceWorker
  })

  it('switches the language and starts the tour', () => {
    const onTour = vi.fn()
    render(<WelcomeHost {...props({ onTour })} />)
    fireEvent.click(screen.getByRole('radio', { name: 'VI' }))
    expect(saved().language).toBe('vi')
    fireEvent.click(
      screen.getByRole('button', { name: 'Take the 1-minute tour' }),
    )
    expect(onTour).toHaveBeenCalled()
    expect(welcome()).toBeNull()
  })
})
