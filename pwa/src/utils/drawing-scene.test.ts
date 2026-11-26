import { compressToBase64 } from 'lz-string'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  libraryHash,
  loadDrawing,
  type Scene,
  sceneHash,
  serializeDrawing,
  serializeLibrary,
} from './drawing-scene'
import { readObsidianDrawing } from './obsidian-drawing'

// Excalidraw itself needs a canvas jsdom has not: its functions stand in,
// each recording what it was given
const ex = vi.hoisted(() => ({
  loadFromBlob: vi.fn(),
  loadLibraryFromBlob: vi.fn(),
  exportToSvg: vi.fn(),
}))
vi.mock('@excalidraw/excalidraw', () => ({
  loadFromBlob: ex.loadFromBlob,
  loadLibraryFromBlob: ex.loadLibraryFromBlob,
  exportToSvg: ex.exportToSvg,
  getNonDeletedElements: (els: { isDeleted?: boolean }[]) =>
    els.filter((e) => !e.isDeleted),
  hashElementsVersion: (els: { version: number }[]) =>
    els.reduce((h, e) => h * 31 + e.version, 7),
  getLibraryItemsHash: (items: unknown[]) => items.length,
  serializeAsJSON: (els: unknown[], _a: unknown, _f: unknown, type: string) =>
    JSON.stringify({ type, elements: els }),
  serializeLibraryAsJSON: (items: unknown[]) =>
    JSON.stringify({ libraryItems: items }),
}))

const rect = { id: 'r', type: 'rectangle', version: 1 }
const text = {
  id: 't',
  type: 'text',
  version: 1,
  text: 'Hello wrapped',
  originalText: 'Hello',
}
const gone = { ...text, id: 'g', isDeleted: true, originalText: 'Gone' }
const appState = { viewBackgroundColor: '#fff' }

beforeEach(() => {
  ex.loadFromBlob.mockReset()
  ex.loadFromBlob.mockResolvedValue({
    elements: [rect, text],
    appState,
    files: { f: {} },
  })
  ex.loadLibraryFromBlob.mockReset()
  ex.exportToSvg.mockReset()
})

const blobOf = async (n = 0) => {
  const blob = ex.loadFromBlob.mock.calls[n][0] as Blob
  return { type: blob.type, text: await blob.text() }
}

describe('loadDrawing', () => {
  it('reads a scene from its JSON', async () => {
    const d = await loadDrawing('scene', '{"type":"excalidraw"}')
    expect(await blobOf()).toEqual({
      type: 'application/json',
      text: '{"type":"excalidraw"}',
    })
    expect(d.initial).toEqual({
      elements: [rect, text],
      appState,
      files: { f: {} },
    })
    expect(d.base).toBe(sceneHash([rect, text] as never, appState))
    expect(d.obsidian).toBeUndefined()
  })

  it('reads an SVG and a PNG by their type', async () => {
    await loadDrawing('svg', '<svg/>')
    expect(await blobOf(0)).toEqual({ type: 'image/svg+xml', text: '<svg/>' })
    await loadDrawing('png', new Blob(['png']))
    expect((await blobOf(1)).type).toBe('image/png')
  })

  it("reads an Obsidian drawing's scene and where it is", async () => {
    const md = `## Drawing\n\`\`\`compressed-json\n${compressToBase64('{"a":1}')}\n\`\`\`\n`
    const d = await loadDrawing('obsidian', md)
    expect(await blobOf()).toEqual({
      type: 'application/json',
      text: '{"a":1}',
    })
    expect(d.obsidian).toEqual(readObsidianDrawing(md))
  })

  it('refuses Markdown that holds no drawing', async () => {
    await expect(loadDrawing('obsidian', '# Notes')).rejects.toThrow()
    expect(ex.loadFromBlob).not.toHaveBeenCalled()
  })

  it('opens a library beside an empty canvas', async () => {
    ex.loadLibraryFromBlob.mockResolvedValue([{ id: 'i' }])
    const d = await loadDrawing('library', '{"type":"excalidrawlib"}')
    const blob = ex.loadLibraryFromBlob.mock.calls[0][0] as Blob
    expect(await blob.text()).toBe('{"type":"excalidrawlib"}')
    expect(d.initial).toEqual({
      elements: [],
      libraryItems: [{ id: 'i' }],
      appState: { openSidebar: { name: 'default', tab: 'library' } },
    })
    expect(d.base).toBe(libraryHash([{ id: 'i' }] as never))
  })
})

describe('sceneHash', () => {
  it('changes with an element and with the background', () => {
    const els = [rect] as never
    const h = sceneHash(els, appState)
    expect(sceneHash([{ ...rect, version: 2 }] as never, appState)).not.toBe(h)
    expect(sceneHash(els, { viewBackgroundColor: '#000' })).not.toBe(h)
    expect(sceneHash(els, appState)).toBe(h)
  })
})

describe('serializeDrawing', () => {
  const scene = {
    elements: [rect, text, gone],
    appState,
    files: {},
  } as unknown as Scene

  it("writes a scene's JSON", async () => {
    expect(await serializeDrawing('scene', scene, '')).toBe(
      JSON.stringify({ type: 'local', elements: [rect, text, gone] }),
    )
  })

  it('writes an SVG with the scene inside, its fonts named only', async () => {
    ex.exportToSvg.mockResolvedValue({ outerHTML: '<svg>drawn</svg>' })
    expect(await serializeDrawing('svg', scene, '<svg/>')).toBe(
      '<svg>drawn</svg>',
    )
    expect(ex.exportToSvg).toHaveBeenCalledWith({
      elements: [rect, text],
      appState: {
        ...appState,
        exportEmbedScene: true,
        exportBackground: false,
        exportWithDarkMode: false,
      },
      files: {},
      skipInliningFonts: true,
    })
  })

  it('keeps the background and dark mode the SVG had', async () => {
    ex.exportToSvg.mockResolvedValue({ outerHTML: '<svg/>' })
    const svg =
      '<svg filter="invert(93%) hue-rotate(180deg)"><defs/><rect x="0" y="0" width="420.5" height="300" fill="#ffffff"></rect></svg>'
    await serializeDrawing('svg', scene, svg)
    expect(ex.exportToSvg.mock.calls[0][0].appState).toMatchObject({
      exportBackground: true,
      exportWithDarkMode: true,
    })
    // A frame of no colour is no background
    await serializeDrawing(
      'svg',
      scene,
      '<svg><rect x="0" y="0" width="1" height="1" fill="none"></rect></svg>',
    )
    expect(ex.exportToSvg.mock.calls[1][0].appState).toMatchObject({
      exportBackground: false,
    })
  })

  it("keeps the file's own source, never the page's", async () => {
    const from = JSON.stringify({ type: 'excalidraw', source: 'https://a.b' })
    expect(JSON.parse(await serializeDrawing('scene', scene, from))).toEqual({
      type: 'local',
      elements: [rect, text, gone],
      source: 'https://a.b',
    })
    // None of its own, or no JSON: as Excalidraw wrote it
    const none = JSON.stringify({ type: 'excalidraw' })
    expect(await serializeDrawing('scene', scene, none)).toBe(
      JSON.stringify({ type: 'local', elements: [rect, text, gone] }),
    )
  })

  it('writes an Obsidian drawing into its Markdown with the texts left', async () => {
    const md = `## Text Elements\nOld ^x\n\n%%\n## Drawing\n\`\`\`json\n{}\n\`\`\`\n%%\n`
    const out = await serializeDrawing(
      'obsidian',
      scene,
      md,
      readObsidianDrawing(md),
    )
    expect(out).toBe(
      `## Text Elements\nHello ^t\n\n%%\n## Drawing\n\`\`\`json\n${JSON.stringify({ type: 'local', elements: [rect, text, gone] })}\n\`\`\`\n%%\n`,
    )
  })
})

describe('serializeLibrary', () => {
  it("writes the library's JSON with its own source", () => {
    expect(serializeLibrary([{ id: 'i' }] as never, '')).toBe(
      '{"libraryItems":[{"id":"i"}]}',
    )
    expect(
      JSON.parse(serializeLibrary([{ id: 'i' }] as never, '{"source":"x"}')),
    ).toEqual({ libraryItems: [{ id: 'i' }], source: 'x' })
  })
})
