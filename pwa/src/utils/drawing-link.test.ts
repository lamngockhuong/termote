import { describe, expect, it } from 'vitest'
import { drawingLink } from './drawing-link'

const FROM = 'notes/Drawing.excalidraw.md'

describe('drawingLink', () => {
  it('opens a wiki link as the note beside the drawing', () => {
    expect(drawingLink('[[Note A]]', FROM)).toEqual({
      kind: 'path',
      path: 'notes/Note A.md',
      anchor: undefined,
    })
    expect(drawingLink(' ![[Note A#Part two|shown]] ', FROM)).toEqual({
      kind: 'path',
      path: 'notes/Note A.md',
      anchor: 'Part two',
    })
    // A name with its extension, in a folder, with a % kept as written
    expect(drawingLink('[[sub/plan.excalidraw]]', FROM)).toEqual({
      kind: 'path',
      path: 'notes/sub/plan.excalidraw',
      anchor: undefined,
    })
    expect(drawingLink('[[100% done]]', FROM)).toMatchObject({
      path: 'notes/100% done.md',
    })
  })

  it('follows no wiki link without a name, nor one out of the root', () => {
    expect(drawingLink('[[#Heading]]', FROM)).toEqual({ kind: 'none' })
    expect(drawingLink('[[../../secret]]', FROM)).toEqual({ kind: 'none' })
  })

  it('reads any other link as a Markdown link', () => {
    expect(drawingLink('https://example.com/a', FROM)).toMatchObject({
      kind: 'external',
    })
    expect(drawingLink('other.md#x', FROM)).toEqual({
      kind: 'path',
      path: 'notes/other.md',
      anchor: 'x',
    })
    expect(drawingLink('javascript:alert(1)', FROM)).toEqual({ kind: 'none' })
  })
})
