import { describe, expect, it } from 'vitest'
import {
  dirOf,
  imageLink,
  pasteToken,
  placeholder,
  replacePlaceholder,
} from './markdown-image-paste'

describe('dirOf', () => {
  it('is the directory under the root, "." at the root', () => {
    expect(dirOf('README.md')).toBe('.')
    expect(dirOf('docs/guide/a.md')).toBe('docs/guide')
  })
})

describe('imageLink', () => {
  it('links from the file to the image, beside it or in its assets', () => {
    expect(imageLink('README.md', 'pasted-1.png')).toBe(
      '![pasted-1](pasted-1.png)',
    )
    expect(imageLink('docs/a.md', 'docs/assets/pasted-1.png')).toBe(
      '![pasted-1](assets/pasted-1.png)',
    )
    expect(imageLink('docs/deep/x/a.md', 'docs/deep/x/p.gif')).toBe(
      '![p](p.gif)',
    )
  })

  it('goes up from another directory', () => {
    expect(imageLink('docs/a/b.md', 'img/p.png')).toBe('![p](../../img/p.png)')
    expect(imageLink('docs/a/b.md', 'docs/c/p.png')).toBe('![p](../c/p.png)')
  })

  it('encodes what would break the link, and keeps the text whole', () => {
    expect(imageLink('a.md', 'my pics/x (1).png')).toBe(
      '![x (1)](my%20pics/x%20%281%29.png)',
    )
    expect(imageLink('a.md', 'a]b.webp')).toBe('![ab](a%5Db.webp)')
    expect(imageLink('a.md', '.hidden')).toBe('![.hidden](.hidden)')
  })
})

describe('placeholder', () => {
  it('makes a token without crypto.randomUUID (plain HTTP has none)', () => {
    const uuid = crypto.randomUUID
    Object.defineProperty(crypto, 'randomUUID', {
      value: undefined,
      configurable: true,
    })
    try {
      expect(pasteToken()).toMatch(/^[0-9a-f]{8}$/)
    } finally {
      Object.defineProperty(crypto, 'randomUUID', {
        value: uuid,
        configurable: true,
      })
    }
  })

  it('is an image without a source, one per token', () => {
    const t = pasteToken()
    expect(t).toMatch(/^[0-9a-f]{8}$/)
    expect(pasteToken()).not.toBe(t)
    expect(placeholder('ab12')).toBe('![Uploading ab12…]()')
  })

  it('is replaced where it is, once, or reported missing', () => {
    const text = `a ${placeholder('t1')} b ${placeholder('t2')}`
    expect(replacePlaceholder(text, 't1', '![x](x.png)')).toEqual({
      text: `a ![x](x.png) b ${placeholder('t2')}`,
      found: true,
    })
    expect(replacePlaceholder(text, 't2', '')).toEqual({
      text: `a ${placeholder('t1')} b `,
      found: true,
    })
    expect(replacePlaceholder('undone', 't1', 'x')).toEqual({
      text: 'undone',
      found: false,
    })
  })
})
