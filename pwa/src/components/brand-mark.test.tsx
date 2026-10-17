import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import source from '../../../assets/branding/termote/logo/symbol-knockout.svg?raw'
import { BrandMark } from './brand-mark'

const SOURCE_D = source.match(/ d="([^"]+)"/)?.[1]

// The source path cut at each Z: face, left eye, right eye, beak
const [FACE, EYE_LEFT, EYE_RIGHT, BEAK] = (SOURCE_D ?? '')
  .split('Z')
  .filter(Boolean)
  .map((part) => `${part}Z`)

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
    const svg = screen.getByTestId('brand-mark')
    expect(svg.querySelector('path')?.getAttribute('d')).toBe(SOURCE_D)
    // A still mark has nothing to animate
    expect(svg.querySelector('mask')).toBeNull()
  })

  it.each(['idle', 'hover'] as const)(
    '%s: cuts the source eyes out through a mask',
    (blink) => {
      render(<BrandMark className="size-12" blink={blink} />)
      const svg = screen.getByTestId('brand-mark')
      expect(svg).toHaveClass('size-12', `owl-blink-${blink}`)
      expect(svg).toHaveAttribute('aria-hidden', 'true')

      const mask = svg.querySelector('mask')
      const eyes = mask?.querySelector('path.owl-eyes')
      expect(eyes).toHaveAttribute('d', EYE_LEFT + EYE_RIGHT)
      // Black in the mask is a hole; the rest of the face is kept
      expect(eyes).toHaveAttribute('fill', '#000')
      expect(mask?.querySelector('rect')).toHaveAttribute('fill', '#fff')

      const face = svg.querySelector(':scope > path')
      expect(face).toHaveAttribute('fill', 'currentColor')
      expect(face).toHaveAttribute('fill-rule', 'evenodd')
      expect(face).toHaveAttribute('d', FACE + BEAK)
      expect(face).toHaveAttribute('mask', `url(#${mask?.id})`)
    },
  )

  it('gives each blinking mark its own mask', () => {
    render(
      <>
        <BrandMark blink="idle" />
        <BrandMark blink="hover" />
      </>,
    )
    const ids = screen
      .getAllByTestId('brand-mark')
      .map((svg) => svg.querySelector('mask')?.id)
    expect(new Set(ids).size).toBe(2)
  })

  it('blinks without a class name of its own', () => {
    render(<BrandMark blink="hover" />)
    expect(screen.getByTestId('brand-mark').getAttribute('class')).toBe(
      'owl-blink-hover',
    )
  })
})
