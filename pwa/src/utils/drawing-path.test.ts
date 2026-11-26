import { describe, expect, it } from 'vitest'
import { drawingKindOf } from './drawing-path'

describe('drawingKindOf', () => {
  it('names the kind of each Excalidraw file, whatever the case', () => {
    expect(drawingKindOf('a/plan.excalidraw')).toBe('scene')
    expect(drawingKindOf('shapes.excalidrawlib')).toBe('library')
    expect(drawingKindOf('flow.excalidraw.svg')).toBe('svg')
    expect(drawingKindOf('flow.Excalidraw.PNG')).toBe('png')
    expect(drawingKindOf('notes/Drawing 1.excalidraw.md')).toBe('obsidian')
  })

  it('leaves other files alone', () => {
    expect(drawingKindOf('flow.svg')).toBeUndefined()
    expect(drawingKindOf('notes.md')).toBeUndefined()
    expect(drawingKindOf('a.excalidraw.json')).toBeUndefined()
    expect(drawingKindOf('excalidraw/readme.txt')).toBeUndefined()
  })
})
