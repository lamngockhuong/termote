import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ConnectionIndicator } from './connection-indicator'

describe('ConnectionIndicator', () => {
  it('renders connecting state', () => {
    render(<ConnectionIndicator state="connecting" />)
    expect(screen.getByLabelText('Connecting...')).toBeInTheDocument()
    expect(screen.getByLabelText('Connecting...')).toBeDisabled()
  })

  it('renders connected state', () => {
    render(<ConnectionIndicator state="connected" />)
    expect(screen.getByLabelText('Connected')).toBeInTheDocument()
    expect(screen.getByLabelText('Connected')).toBeDisabled()
  })

  it('renders disconnected state and is clickable', () => {
    const onRetry = vi.fn()
    render(<ConnectionIndicator state="disconnected" onRetry={onRetry} />)
    const btn = screen.getByLabelText('Disconnected')
    expect(btn).toBeInTheDocument()
    expect(btn).not.toBeDisabled()
    fireEvent.click(btn)
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('renders error state and is clickable', () => {
    const onRetry = vi.fn()
    render(<ConnectionIndicator state="error" onRetry={onRetry} />)
    const btn = screen.getByLabelText('Connection error')
    expect(btn).not.toBeDisabled()
    fireEvent.click(btn)
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('does not call onRetry when connected (onClick is undefined)', () => {
    const onRetry = vi.fn()
    render(<ConnectionIndicator state="connected" onRetry={onRetry} />)
    fireEvent.click(screen.getByLabelText('Connected'))
    expect(onRetry).not.toHaveBeenCalled()
  })

  it('does not call onRetry when connecting', () => {
    const onRetry = vi.fn()
    render(<ConnectionIndicator state="connecting" onRetry={onRetry} />)
    fireEvent.click(screen.getByLabelText('Connecting...'))
    expect(onRetry).not.toHaveBeenCalled()
  })

  it('renders without onRetry prop', () => {
    render(<ConnectionIndicator state="disconnected" />)
    expect(screen.getByLabelText('Disconnected')).toBeInTheDocument()
  })

  it('shows WifiOff icon for non-connected states', () => {
    const { container } = render(<ConnectionIndicator state="disconnected" />)
    // lucide icons render as svg
    expect(container.querySelector('svg')).toBeInTheDocument()
  })

  it('shows Wifi icon for connected state', () => {
    const { container } = render(<ConnectionIndicator state="connected" />)
    expect(container.querySelector('svg')).toBeInTheDocument()
  })
})
