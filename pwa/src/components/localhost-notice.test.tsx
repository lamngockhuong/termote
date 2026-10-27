import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as loopback from '../utils/loopback-address'
import { LocalhostNotice } from './localhost-notice'

describe('LocalhostNotice', () => {
  afterEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  // jsdom serves the tests from http://localhost:3000
  it('warns a localhost page and opens it at 127.0.0.1', () => {
    const assign = vi.fn()
    vi.spyOn(window, 'location', 'get').mockReturnValue({
      ...window.location,
      hostname: 'localhost',
      href: 'http://localhost:7682/#/s/w1/w1:p2',
      assign,
    })
    render(<LocalhostNotice />)
    expect(screen.getByRole('status')).toHaveTextContent(
      'Opened through localhost',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Open 127.0.0.1' }))
    expect(assign).toHaveBeenCalledWith('http://127.0.0.1:7682/#/s/w1/w1:p2')
  })

  it('hides for good once dismissed', () => {
    const { unmount } = render(<LocalhostNotice />)
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('status')).toBeNull()
    expect(loopback.localhostNoticeDismissed()).toBe(true)
    unmount()
    render(<LocalhostNotice />)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('shows nothing at 127.0.0.1', () => {
    vi.spyOn(loopback, 'loopbackAddress').mockReturnValue(null)
    render(<LocalhostNotice />)
    expect(screen.queryByRole('status')).toBeNull()
  })
})
