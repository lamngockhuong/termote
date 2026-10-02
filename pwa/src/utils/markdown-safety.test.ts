import { describe, expect, it } from 'vitest'
import { htmlAsText, safeUrl } from './markdown-safety'

describe('safeUrl', () => {
  it('accepts http(s) URLs only', () => {
    expect(safeUrl('https://a.example/x')?.host).toBe('a.example')
    expect(safeUrl('http://a.example')).not.toBeNull()
    expect(safeUrl('javascript:alert(1)')).toBeNull()
    expect(safeUrl('not a url')).toBeNull()
    expect(safeUrl(undefined)).toBeNull()
  })
})

describe('htmlAsText', () => {
  it('turns html nodes into text, at any depth', () => {
    const tree = {
      type: 'root',
      children: [
        { type: 'html', value: '<b>' },
        { type: 'paragraph', children: [{ type: 'html', value: '<i>' }] },
      ],
    }
    htmlAsText()(tree)
    expect(tree.children[0].type).toBe('text')
    expect(tree.children[1].children?.[0].type).toBe('text')
  })
})
