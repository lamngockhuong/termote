import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatImageViewer } from './chat-image-viewer'
import { ChatMessage } from './chat-message'

const withImage = (image?: string) => (
  <ChatMessage
    entry={{
      id: 'u',
      role: 'user',
      parts: [
        { kind: 'text', text: '[Image #1] look' },
        { kind: 'image', image },
      ],
    }}
  />
)

describe('ChatImageViewer', () => {
  beforeEach(() => {
    // An open dialog is what makes its content reachable by role
    HTMLDialogElement.prototype.showModal = vi.fn(function (
      this: HTMLDialogElement,
    ) {
      this.setAttribute('open', '')
    })
    HTMLDialogElement.prototype.close = vi.fn()
  })

  it('opens an image of the transcript from its chip', () => {
    render(
      <ChatImageViewer paneId="%3">{withImage('ref.sig')}</ChatImageViewer>,
    )
    fireEvent.click(screen.getByRole('button', { name: '[image]' }))
    const url = '/api/mux/panes/%253/agent/image?src=ref.sig'
    expect(screen.getByRole('img', { name: 'Image' })).toHaveAttribute(
      'src',
      url,
    )
    expect(
      screen.getByRole('link', { name: 'Open in new tab' }),
    ).toHaveAttribute('href', url)
    expect(screen.getByRole('link', { name: 'Download' })).toHaveAttribute(
      'download',
    )
  })

  it('closes on its close button', async () => {
    render(
      <ChatImageViewer paneId="p1">{withImage('ref.sig')}</ChatImageViewer>,
    )
    fireEvent.click(screen.getByRole('button', { name: '[image]' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() =>
      expect(screen.queryByRole('img', { name: 'Image' })).toBeNull(),
    )
  })

  it('says so when the image does not load', () => {
    render(
      <ChatImageViewer paneId="p1">{withImage('ref.sig')}</ChatImageViewer>,
    )
    fireEvent.click(screen.getByRole('button', { name: '[image]' }))
    fireEvent.error(screen.getByRole('img', { name: 'Image' }))
    expect(screen.getByText(/could not be loaded/)).toBeInTheDocument()
    expect(screen.queryByRole('img', { name: 'Image' })).toBeNull()
  })

  it('keeps the chip plain without a reference or a pane', () => {
    const { unmount } = render(
      <ChatImageViewer paneId="p1">{withImage()}</ChatImageViewer>,
    )
    expect(screen.queryByRole('button', { name: '[image]' })).toBeNull()
    expect(screen.getByText('[image]')).toBeInTheDocument()
    unmount()
    render(<ChatImageViewer paneId="">{withImage('ref.sig')}</ChatImageViewer>)
    expect(screen.queryByRole('button', { name: '[image]' })).toBeNull()
  })
})
