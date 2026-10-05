import { describe, expect, it } from 'vitest'
import { isImagePath, isSvgPath } from './image-path'

describe('image paths', () => {
  it.each(['a.png', 'dir/b.JPG', 'c.jpeg', 'd.gif', 'e.WebP'])(
    '%s is an image',
    (p) => {
      expect(isImagePath(p)).toBe(true)
      expect(isSvgPath(p)).toBe(false)
    },
  )

  it.each(['a.svg', 'a.png.txt', 'png', 'a.bmp', 'a.avif'])(
    '%s is not',
    (p) => {
      expect(isImagePath(p)).toBe(false)
    },
  )

  it('tells an SVG by its name', () => {
    expect(isSvgPath('icons/Logo.SVG')).toBe(true)
    expect(isSvgPath('a.svgz')).toBe(false)
  })
})
