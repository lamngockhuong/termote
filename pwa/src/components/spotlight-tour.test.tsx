import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderWithLocale } from '../i18n/test-utils'
import { DESKTOP_STEPS, MOBILE_STEPS } from '../utils/tour-steps'
import { SpotlightTour } from './spotlight-tour'

function anchor(
  name: string,
  rect = { top: 100, left: 20, width: 80, height: 40 },
) {
  const el = document.createElement('div')
  el.dataset.tour = name
  el.getBoundingClientRect = vi.fn(() => rect as DOMRect)
  document.body.append(el)
  return el
}

const keys = { commands: 'Ctrl+Shift+P', files: 'Ctrl+P' }
const bubble = () => screen.getByRole('dialog')

describe('SpotlightTour', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('ends at once when no step has its element on screen', () => {
    const onClose = vi.fn()
    render(<SpotlightTour steps={MOBILE_STEPS} onClose={onClose} keys={keys} />)
    expect(onClose).toHaveBeenCalled()
    expect(screen.queryByTestId('tour')).toBeNull()
  })

  it('walks the steps on screen, the others left out', () => {
    anchor('session-chip')
    anchor('terminal', { top: 60, left: 0, width: 390, height: 700 })
    const onClose = vi.fn()
    render(<SpotlightTour steps={MOBILE_STEPS} onClose={onClose} keys={keys} />)
    expect(bubble()).toHaveAccessibleName('Sessions and windows')
    expect(bubble()).toHaveFocus()
    expect(screen.getByText('1 / 2')).toBeInTheDocument()
    expect(screen.getByText('Step 1 of 2')).toHaveAttribute(
      'aria-live',
      'polite',
    )
    expect(screen.getByTestId('tour-spotlight')).toHaveStyle({
      top: '96px',
      left: '16px',
      width: '88px',
      height: '48px',
    })
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(bubble()).toHaveAccessibleName('Gestures on the terminal')
    expect(screen.getByText('Swipe left')).toBeInTheDocument()
    expect(screen.getByText('Ctrl+C')).toBeInTheDocument()
    // The last step has no Skip
    expect(screen.queryByRole('button', { name: 'Skip tour' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(bubble()).toHaveAccessibleName('Sessions and windows')
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('goes by the keys: → and Enter on, ← back, Esc out', () => {
    for (const a of ['session-chip', 'view-menu', 'keyboard-toolbar']) anchor(a)
    const onClose = vi.fn()
    render(<SpotlightTour steps={MOBILE_STEPS} onClose={onClose} keys={keys} />)
    fireEvent.keyDown(bubble(), { key: 'ArrowRight' })
    expect(bubble()).toHaveAccessibleName('One pane, five views')
    expect(
      screen.getByText("browse and edit the pane's folder."),
    ).toBeInTheDocument()
    fireEvent.keyDown(bubble(), { key: 'Enter' })
    expect(bubble()).toHaveAccessibleName('Keys your phone lacks')
    expect(screen.getByText('Esc', { selector: 'kbd' })).toBeInTheDocument()
    fireEvent.keyDown(bubble(), { key: 'ArrowLeft' })
    fireEvent.keyDown(bubble(), { key: 'ArrowLeft' })
    fireEvent.keyDown(bubble(), { key: 'ArrowLeft' })
    expect(bubble()).toHaveAccessibleName('Sessions and windows')
    // Enter on a button is the button's own
    fireEvent.keyDown(screen.getByRole('button', { name: 'Next' }), {
      key: 'Enter',
    })
    expect(bubble()).toHaveAccessibleName('Sessions and windows')
    // Other keys are left alone
    expect(fireEvent.keyDown(bubble(), { key: 'a' })).toBe(true)
    fireEvent.keyDown(bubble(), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('keeps every key from the app, but leaves the browser its own', () => {
    anchor('session-chip')
    anchor('view-menu')
    const outside = document.createElement('input')
    document.body.append(outside)
    const seen = vi.fn()
    document.addEventListener('keydown', seen)
    render(<SpotlightTour steps={MOBILE_STEPS} onClose={vi.fn()} keys={keys} />)
    // Typed while focus is elsewhere: neither the app nor the browser
    expect(fireEvent.keyDown(outside, { key: 'a' })).toBe(false)
    // A shortcut never reaches the app; Alt+← still goes back
    expect(
      fireEvent.keyDown(outside, { key: 'P', ctrlKey: true, shiftKey: true }),
    ).toBe(true)
    expect(
      fireEvent.keyDown(bubble(), { key: 'ArrowLeft', altKey: true }),
    ).toBe(true)
    expect(seen).not.toHaveBeenCalled()
    expect(bubble()).toHaveAccessibleName('Sessions and windows')
    // Two quick presses: two steps (the second is the last)
    fireEvent.keyDown(bubble(), { key: 'ArrowRight' })
    expect(bubble()).toHaveAccessibleName('One pane, five views')
    document.removeEventListener('keydown', seen)
  })

  it('goes two steps on two quick presses', () => {
    for (const a of ['session-chip', 'view-menu', 'keyboard-toolbar']) anchor(a)
    render(<SpotlightTour steps={MOBILE_STEPS} onClose={vi.fn()} keys={keys} />)
    const press = new KeyboardEvent('keydown', {
      key: 'ArrowRight',
      bubbles: true,
    })
    const again = new KeyboardEvent('keydown', {
      key: 'ArrowRight',
      bubbles: true,
    })
    act(() => {
      bubble().dispatchEvent(press)
      bubble().dispatchEvent(again)
    })
    expect(bubble()).toHaveAccessibleName('Keys your phone lacks')
  })

  it('keeps Tab within the bubble', () => {
    for (const a of ['session-chip', 'view-menu', 'terminal']) anchor(a)
    render(<SpotlightTour steps={MOBILE_STEPS} onClose={vi.fn()} keys={keys} />)
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    // Skip tour, Back, Next
    const [skip, back, done] = screen.getAllByRole('button')
    bubble().focus()
    fireEvent.keyDown(bubble(), { key: 'Tab' })
    expect(skip).toHaveFocus()
    fireEvent.keyDown(skip, { key: 'Tab' })
    expect(back).toHaveFocus()
    fireEvent.keyDown(back, { key: 'Tab', shiftKey: true })
    expect(skip).toHaveFocus()
    fireEvent.keyDown(skip, { key: 'Tab', shiftKey: true })
    expect(done).toHaveFocus()
    fireEvent.keyDown(done, { key: 'Tab' })
    expect(skip).toHaveFocus()
    bubble().focus()
    fireEvent.keyDown(bubble(), { key: 'Tab', shiftKey: true })
    expect(done).toHaveFocus()
  })

  it('takes focus back from the page', () => {
    anchor('session-chip')
    const outside = document.createElement('button')
    document.body.append(outside)
    const { unmount } = render(
      <SpotlightTour steps={MOBILE_STEPS} onClose={vi.fn()} keys={keys} />,
    )
    outside.focus()
    expect(bubble()).toHaveFocus()
    screen.getByRole('button', { name: 'Done' }).focus()
    expect(screen.getByRole('button', { name: 'Done' })).toHaveFocus()
    unmount()
    outside.focus()
    expect(outside).toHaveFocus()
  })

  it('Skip ends it; a tap on the dimmed page does not', () => {
    anchor('session-chip')
    anchor('view-menu')
    const onClose = vi.fn()
    render(<SpotlightTour steps={MOBILE_STEPS} onClose={onClose} keys={keys} />)
    fireEvent.click(screen.getByTestId('tour'))
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Skip tour' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('desktop: the panel views, the panes and the keys', () => {
    for (const a of ['view-switcher', 'pane-strip', 'palette']) anchor(a)
    render(
      <SpotlightTour
        steps={DESKTOP_STEPS}
        onClose={vi.fn()}
        keys={{ commands: 'Ctrl+Shift+P' }}
      />,
    )
    expect(bubble()).toHaveAccessibleName('Views and the side panel')
    expect(bubble()).toHaveTextContent(
      'Files and Changes open beside the terminal',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(bubble()).toHaveAccessibleName('Windows and panes')
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(bubble()).toHaveAccessibleName('Everything, by name')
    expect(
      screen.getByText('Ctrl+Shift+P', { selector: 'kbd' }),
    ).toBeInTheDocument()
    // No key for Go to file: no row
    expect(screen.queryByText('Go to file')).toBeNull()
  })

  it('points its arrow at what it lights, and sits in the middle once that is gone', async () => {
    const chip = anchor('session-chip')
    anchor('view-menu')
    render(<SpotlightTour steps={MOBILE_STEPS} onClose={vi.fn()} keys={keys} />)
    expect(bubble()).toHaveAttribute('data-side', 'bottom')
    expect(screen.getByTestId('tour-arrow')).toBeInTheDocument()
    chip.getBoundingClientRect = vi.fn(
      () => ({ top: 0, left: 0, width: 0, height: 0 }) as DOMRect,
    )
    await waitFor(() =>
      expect(screen.queryByTestId('tour-spotlight')).toBeNull(),
    )
    expect(bubble()).toHaveAttribute('data-side', 'none')
    expect(screen.queryByTestId('tour-arrow')).toBeNull()
  })

  it('draws the arrow on each side', () => {
    const vw = window.innerWidth
    const vh = window.innerHeight
    // At the bottom: above it. Full height at the left: right of it; at the
    // right: left of it.
    anchor('session-chip', { top: vh - 50, left: 20, width: 80, height: 40 })
    anchor('view-menu', { top: 0, left: 0, width: 200, height: vh })
    anchor('keyboard-toolbar', {
      top: 0,
      left: vw - 200,
      width: 200,
      height: vh,
    })
    render(
      <SpotlightTour
        steps={MOBILE_STEPS.map((s) => ({ ...s, placement: 'top' as const }))}
        onClose={vi.fn()}
        keys={keys}
      />,
    )
    expect(bubble()).toHaveAttribute('data-side', 'top')
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(bubble()).toHaveAttribute('data-side', 'right')
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(bubble()).toHaveAttribute('data-side', 'left')
  })

  it('speaks Vietnamese', () => {
    anchor('session-chip')
    anchor('view-menu')
    renderWithLocale(
      <SpotlightTour steps={MOBILE_STEPS} onClose={vi.fn()} keys={keys} />,
      'vi',
    )
    expect(bubble()).toHaveAccessibleName('Phiên và cửa sổ')
    expect(screen.getByText('Bước 1/2')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Tiếp' })).toBeInTheDocument()
  })
})
