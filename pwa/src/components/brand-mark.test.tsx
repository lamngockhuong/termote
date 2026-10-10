import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import source from '../../../assets/branding/termote/logo/symbol-knockout.svg?raw'
import { BrandMark } from './brand-mark'

describe('BrandMark', () => {
  it('is hidden from screen readers and takes the text colour', () => {
    render(<BrandMark className="size-5" />)
    const svg = screen.getByTestId('brand-mark')
    expect(svg).toHaveAttribute('aria-hidden', 'true')
    expect(svg).toHaveClass('size-5')
    const path = svg.querySelector('path')
    expect(path).toHaveAttribute('fill', 'currentColor')
    // The prompt eyes are cut out of the face, not painted over it
    expect(path).toHaveAttribute('fill-rule', 'evenodd')
  })

  it('draws the brand source, not a redraw of it', () => {
    render(<BrandMark />)
    const d = screen.getByTestId('brand-mark').querySelector('path')
    expect(d?.getAttribute('d')).toBe(source.match(/ d="([^"]+)"/)?.[1])
  })
})
