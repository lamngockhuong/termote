import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalhostNotice } from './localhost-notice'

describe('LocalhostNotice', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('warns a localhost page and opens it at 127.0.0.1', () => {
    const assign = vi.fn()
    vi.stubGlobal('location', {
      hostname: 'localhost',
      href: 'http://localhost:7682/#/s/w1/w1:p2',
      assign,
    })
    render(<LocalhostNotice onDismiss={() => {}} />)
    expect(screen.getByRole('status')).toHaveTextContent(
      'Opened through localhost',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Open 127.0.0.1' }))
    expect(assign).toHaveBeenCalledWith('http://127.0.0.1:7682/#/s/w1/w1:p2')
  })

  it('reports a dismissal', () => {
    const onDismiss = vi.fn()
    render(<LocalhostNotice onDismiss={onDismiss} />)
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(onDismiss).toHaveBeenCalledOnce()
  })

  it('shows nothing at 127.0.0.1', () => {
    vi.stubGlobal('location', {
      hostname: '127.0.0.1',
      href: 'http://127.0.0.1:7682/',
    })
    render(<LocalhostNotice onDismiss={() => {}} />)
    expect(screen.queryByRole('status')).toBeNull()
  })
})
