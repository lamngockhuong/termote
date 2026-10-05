import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ImageState } from '../hooks/use-image-blob'
import { RequestError } from '../hooks/use-mux-api'
import { ImagePreview, imageErrorText } from './image-preview'

const refused = (status: number, code: string): ImageState => ({
  status: 'error',
  error: new RequestError(status, code, code),
})
const ready = (
  url = 'blob:u1',
  stale = false,
  type = 'image/png',
): ImageState => ({
  status: 'ready',
  url,
  size: 2048,
  type,
  stale,
})

// jsdom decodes nothing: the size the browser would report
function loadAs(img: HTMLElement, width: number, height: number) {
  Object.defineProperty(img, 'naturalWidth', { value: width })
  Object.defineProperty(img, 'naturalHeight', { value: height })
  fireEvent.load(img)
}

describe('ImagePreview', () => {
  it('shows the image over a checkerboard, with its sizes once decoded', () => {
    render(<ImagePreview state={ready()} alt="a.png" label="After · Index" />)
    const img = screen.getByRole('img', { name: 'a.png' })
    expect(img).toHaveAttribute('src', 'blob:u1')
    expect(img).toHaveAttribute('decoding', 'async')
    expect(img).toHaveAttribute('aria-busy', 'false')
    expect(screen.getByText('After · Index')).toBeInTheDocument()
    expect(screen.getByText('2.0 KiB')).toBeInTheDocument()
    loadAs(img, 640, 480)
    expect(screen.getByText('640×480 · 2.0 KiB')).toBeInTheDocument()
  })

  it('dims an earlier image while the next one loads, and forgets its size', () => {
    const { rerender } = render(<ImagePreview state={ready()} alt="a.png" />)
    loadAs(screen.getByRole('img'), 1, 2)
    rerender(<ImagePreview state={ready('blob:u1', true)} alt="a.png" />)
    expect(screen.getByRole('img')).toHaveClass('opacity-60')
    expect(screen.getByRole('img')).toHaveAttribute('aria-busy', 'true')
    rerender(<ImagePreview state={ready('blob:u2')} alt="a.png" />)
    expect(screen.queryByText(/1×2/)).toBeNull()
    expect(screen.getByRole('img')).not.toHaveClass('opacity-60')
  })

  it('gives an SVG no pixel size, which each browser picks differently', () => {
    render(
      <ImagePreview
        state={ready('blob:u1', false, 'image/svg+xml')}
        alt="logo.svg"
      />,
    )
    loadAs(screen.getByRole('img'), 240, 150)
    expect(screen.getByText('2.0 KiB')).toBeInTheDocument()
    expect(screen.queryByText(/240×150/)).toBeNull()
  })

  it('says so when the browser cannot decode it', () => {
    render(<ImagePreview state={ready()} alt="a.png" />)
    fireEvent.error(screen.getByRole('img'))
    expect(
      screen.getByText('The image could not be decoded'),
    ).toBeInTheDocument()
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('shows loading, and what a side without a version is', () => {
    const { rerender } = render(
      <ImagePreview state={{ status: 'loading' }} alt="a" />,
    )
    expect(screen.getByText('Loading…')).toBeInTheDocument()
    rerender(
      <ImagePreview state={{ status: 'idle' }} alt="a" missing="Added" />,
    )
    expect(screen.getByText('Added')).toBeInTheDocument()
  })

  it.each([
    [413, 'too_large', 'Larger than 10 MiB'],
    [413, 'too_many_pixels', 'Too many pixels to show (over 40 megapixels)'],
    [
      415,
      'not_image',
      'Not previewable (not a PNG, JPEG, GIF, WebP or SVG image)',
    ],
    [415, 'lfs_pointer', 'Stored in Git LFS: only the pointer is in git'],
    [403, 'sensitive', 'This file may contain secrets'],
    [403, '', "This file can't be shown"],
    [404, '', 'File not found'],
    [501, '', 'Not supported by this backend'],
    [500, '', 'Could not load the image'],
  ])('a %i %s says %s', (status, code, text) => {
    render(<ImagePreview state={refused(status, code)} alt="a" />)
    expect(screen.getByText(text)).toBeInTheDocument()
  })

  it('offers a retry when the server was busy', () => {
    const onRetry = vi.fn()
    const { rerender } = render(
      <ImagePreview state={refused(429, 'busy')} alt="a" onRetry={onRetry} />,
    )
    expect(screen.getByText('Busy, try again')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalled()
    rerender(<ImagePreview state={refused(429, 'busy')} alt="a" />)
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    rerender(
      <ImagePreview
        state={refused(413, 'too_large')}
        alt="a"
        onRetry={onRetry}
      />,
    )
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  })
})

describe('imageErrorText', () => {
  it('says what is missing for no_version, when the caller knows', () => {
    const none = new RequestError(404, 'no_version', 'no such version')
    expect(imageErrorText(none, 'Deleted')).toBe('Deleted')
    expect(imageErrorText(none)).toBe('File not found')
    expect(imageErrorText(new TypeError('offline'))).toBe(
      'Could not load the image',
    )
  })
})
