import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWithLocale } from '../i18n/test-utils'
import type { WelcomeFacts } from '../utils/welcome'
import { WelcomeSheet } from './welcome-sheet'

const facts = (over: Partial<WelcomeFacts> = {}): WelcomeFacts => ({
  sessions: 2,
  panes: 4,
  waiting: [],
  next: [],
  primary: 'terminal',
  ...over,
})

function props(over: Partial<Parameters<typeof WelcomeSheet>[0]> = {}) {
  return {
    isOpen: true,
    onClose: vi.fn(),
    mobile: true,
    host: 'box:7680',
    version: '2.13.0',
    backend: 'tmux',
    facts: facts(),
    readOnly: false,
    notify: 'off' as const,
    areas: { chat: true, files: true, tasks: true, panes: true },
    keys: { commands: 'Ctrl+Shift+P', files: 'Ctrl+P' },
    onLanguage: vi.fn(),
    onAction: vi.fn(),
    onPrimary: vi.fn(),
    ...over,
  }
}

const value = (label: string) =>
  screen.getByText(label, { selector: 'dt' }).nextElementSibling?.textContent

describe('WelcomeSheet', () => {
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = vi.fn(function (
      this: HTMLDialogElement,
    ) {
      this.setAttribute('open', '')
    })
    HTMLDialogElement.prototype.close = vi.fn()
  })

  it('renders nothing while closed', () => {
    render(<WelcomeSheet {...props({ isOpen: false })} />)
    expect(screen.queryByTestId('welcome')).toBeNull()
  })

  it.each([
    [true, 'translate-y-8'],
    [false, 'scale-95'],
  ])(
    'fades out on close, giving focus back at once (phone %s)',
    (mobile, away) => {
      const real = window.getComputedStyle
      const style = vi
        .spyOn(window, 'getComputedStyle')
        .mockImplementation((el) =>
          el instanceof HTMLDialogElement
            ? ({
                transitionDuration: '150ms',
                transitionDelay: '0s',
              } as CSSStyleDeclaration)
            : real(el),
        )
      const opener = document.createElement('button')
      document.body.append(opener)
      opener.focus()
      const { rerender } = render(<WelcomeSheet {...props({ mobile })} />)
      rerender(<WelcomeSheet {...props({ mobile, isOpen: false })} />)
      const dialog = screen.getByTestId('welcome')
      expect(dialog).toHaveAttribute('data-closing', 'true')
      expect(dialog).toHaveAttribute('inert')
      expect(dialog.className.split(' ')).toContain(away)
      expect((dialog as HTMLDialogElement).close).toHaveBeenCalled()
      expect(document.activeElement).toBe(opener)
      act(() => {
        dialog.dispatchEvent(new Event('transitionend'))
      })
      expect(screen.queryByTestId('welcome')).toBeNull()
      style.mockRestore()
      opener.remove()
    },
  )

  it('a phone: a sheet with the setup, the areas and the gestures', () => {
    render(<WelcomeSheet {...props()} />)
    const dialog = screen.getByRole('dialog', {
      name: 'Your terminal, from this phone.',
    })
    expect(dialog).toHaveAttribute('data-layout', 'sheet')
    expect(dialog).toHaveTextContent(
      'Termote 2.13.0 on box:7680, running tmux. Everything you type goes to the same sessions',
    )
    expect(value('Backend')).toBe('tmux')
    expect(value('Sessions')).toBe('2 sessions · 4 panes')
    expect(value('This device')).toBe('Can type')
    expect(value('Notifications')).toBe('Off')
    expect(screen.queryByText('Sign-in')).toBeNull()
    expect(screen.queryByText('Waiting for you')).toBeNull()
    for (const area of ['Terminal', 'Chat', 'Files', 'Tasks', 'Gestures'])
      expect(screen.getByText(area, { selector: 'b' })).toBeInTheDocument()
    expect(screen.queryByText('Panes', { selector: 'b' })).toBeNull()
    expect(screen.queryByText('Keys worth knowing')).toBeNull()
    expect(
      screen.getByRole('button', { name: 'Open the terminal' }),
    ).toBeInTheDocument()
    // No tour to take yet
    expect(
      screen.queryByRole('button', { name: 'Take the 1-minute tour' }),
    ).toBeNull()
  })

  it('a desktop: a dialog with sign-in, panes and keys', () => {
    render(
      <WelcomeSheet
        {...props({
          mobile: false,
          signIn: true,
          backend: 'herdr',
          notify: 'on',
        })}
      />,
    )
    const dialog = screen.getByRole('dialog', {
      name: 'Your terminal, in any browser.',
    })
    expect(dialog).toHaveAttribute('data-layout', 'dialog')
    expect(dialog).toHaveTextContent('running Herdr.')
    expect(dialog).not.toHaveTextContent('Everything you type')
    expect(value('Sign-in')).toBe('On')
    expect(value('Notifications')).toBe('On')
    expect(value('Command palette')).toBe('Ctrl+Shift+P')
    expect(value('Go to file')).toBe('Ctrl+P')
    expect(screen.getByText('Panes', { selector: 'b' })).toBeInTheDocument()
    expect(screen.queryByText('Terminal', { selector: 'b' })).toBeNull()
    expect(screen.queryByText('Gestures', { selector: 'b' })).toBeNull()
  })

  it('a desktop without keys or sign-in leaves them out', () => {
    render(
      <WelcomeSheet
        {...props({
          mobile: false,
          signIn: false,
          keys: {},
          backend: 'other',
          areas: { chat: false, files: false, tasks: false, panes: false },
        })}
      />,
    )
    expect(value('Sign-in')).toBe('Off')
    expect(value('Backend')).toBe('other')
    expect(screen.queryByText('Keys worth knowing')).toBeNull()
    expect(screen.queryByText('Chat', { selector: 'b' })).toBeNull()
  })

  it('a view-only device: what it can watch, and no typing', () => {
    render(
      <WelcomeSheet
        {...props({
          readOnly: true,
          notify: 'unsupported',
          facts: facts({ sessions: 0 }),
        })}
      />,
    )
    expect(screen.getByRole('dialog')).toHaveTextContent(
      'This device can watch every session there but cannot type.',
    )
    expect(value('This device')).toBe('View only')
    expect(value('Sessions')).toBe('None yet')
    expect(screen.queryByText('Notifications')).toBeNull()
    expect(screen.queryByText('Files', { selector: 'b' })).toBeNull()
    expect(screen.queryByText('Tasks', { selector: 'b' })).toBeNull()
    expect(screen.getByText(/watch the live pane/)).toBeInTheDocument()
    expect(
      screen.getByText(/read an agent's whole session/),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/need a device with full access/),
    ).toBeInTheDocument()
  })

  it('an agent waiting: counted, a card that opens it, and the main button', () => {
    const agent = { sessionId: 's', paneId: 'p', agent: 'claude', tab: 'api' }
    const p = props({
      facts: facts({
        waiting: [agent, { ...agent, paneId: 'q' }],
        next: [{ kind: 'waiting', agent }, { kind: 'notify' }],
        primary: 'waiting',
      }),
    })
    render(<WelcomeSheet {...p} />)
    expect(value('Waiting for you')).toBe('2 agents')
    const card = screen.getByText('claude in api is waiting').closest('li')!
    fireEvent.click(within(card).getByRole('button', { name: 'Open' }))
    expect(p.onAction).toHaveBeenCalledWith({ kind: 'waiting', agent })
    fireEvent.click(screen.getByRole('button', { name: 'Turn on' }))
    expect(p.onAction).toHaveBeenCalledWith({ kind: 'notify' })
    fireEvent.click(
      screen.getByRole('button', { name: 'Open the pane that needs you' }),
    )
    expect(p.onPrimary).toHaveBeenCalled()
  })

  it('shows every kind of card', () => {
    const p = props({
      facts: facts({
        next: [
          { kind: 'start' },
          { kind: 'install', how: 'prompt' },
          { kind: 'install', how: 'ios' },
          { kind: 'pair' },
        ],
      }),
    })
    render(<WelcomeSheet {...p} />)
    fireEvent.click(screen.getByRole('button', { name: 'New' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    fireEvent.click(screen.getByRole('button', { name: 'Pair' }))
    expect(p.onAction).toHaveBeenCalledTimes(3)
    // iPhone Safari: where to tap, no button
    expect(
      screen.getByText('In Safari, tap Share, then Add to Home Screen.'),
    ).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Add' })).toHaveLength(1)
  })

  it('switches the language, takes the tour and closes', () => {
    const onTour = vi.fn()
    const p = props({ onTour })
    render(<WelcomeSheet {...p} />)
    fireEvent.click(screen.getByRole('radio', { name: 'VI' }))
    expect(p.onLanguage).toHaveBeenCalledWith('vi')
    fireEvent.click(
      screen.getByRole('button', { name: 'Take the 1-minute tour' }),
    )
    expect(onTour).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }))
    expect(p.onClose).toHaveBeenCalledTimes(1)
  })

  it('closes from ✕ on desktop, from Esc and from the scrim, not from a press inside', () => {
    const p = props({ mobile: false, onTour: vi.fn() })
    render(<WelcomeSheet {...p} />)
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    const dialog = screen.getByRole('dialog')
    fireEvent(dialog, new Event('cancel', { cancelable: true }))
    fireEvent.pointerDown(dialog)
    fireEvent.click(dialog)
    fireEvent.pointerDown(screen.getByText('Your setup'))
    fireEvent.click(dialog)
    expect(p.onClose).toHaveBeenCalledTimes(3)
  })

  it('speaks Vietnamese', () => {
    renderWithLocale(
      <WelcomeSheet
        {...props({ facts: facts({ next: [{ kind: 'start' }] }) })}
      />,
      'vi',
    )
    expect(
      screen.getByRole('dialog', {
        name: 'Terminal của bạn, ngay trên điện thoại.',
      }),
    ).toBeInTheDocument()
    expect(value('Phiên')).toBe('2 phiên · 4 pane')
    expect(screen.getByText('Tạo phiên đầu tiên')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'VI' })).toBeChecked()
    expect(screen.getByRole('button', { name: 'Bỏ qua' })).toBeInTheDocument()
  })
})
