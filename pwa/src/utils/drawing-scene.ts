import {
  exportToSvg,
  getLibraryItemsHash,
  getNonDeletedElements,
  hashElementsVersion,
  loadFromBlob,
  loadLibraryFromBlob,
  serializeAsJSON,
  serializeLibraryAsJSON,
} from '@excalidraw/excalidraw'
import type {
  ExcalidrawElement,
  ExcalidrawTextElement,
} from '@excalidraw/excalidraw/element/types'
import type {
  AppState,
  BinaryFiles,
  ExcalidrawInitialDataState,
  LibraryItems,
} from '@excalidraw/excalidraw/types'
import type { DrawingKind } from './drawing-path'
import {
  type ObsidianDrawing,
  readObsidianDrawing,
  writeObsidianDrawing,
} from './obsidian-drawing'

// What the editor shows, as its onChange gives it
export interface Scene {
  elements: readonly ExcalidrawElement[]
  appState: AppState
  files: BinaryFiles
}

// How Excalidraw writes an SVG with a background (a rectangle over all of
// it) and one in dark mode (its root's inverting filter)
const SVG_BACKGROUND =
  /<rect x="0" y="0" width="[\d.]+" height="[\d.]+" fill="(?!none")/
const SVG_DARK = /filter[:=]\s*"?invert\(93%\)/

// A file read as a drawing
export interface LoadedDrawing {
  initial: ExcalidrawInitialDataState
  // What a change is compared with (sceneHash, libraryHash): the drawing as
  // read, so one undone back to it is no change
  base: string
  // Where the scene is in an Obsidian file's Markdown, written back there
  obsidian?: ObsidianDrawing
}

const TYPES: Record<Exclude<DrawingKind, 'library' | 'obsidian'>, string> = {
  scene: 'application/json',
  svg: 'image/svg+xml',
  png: 'image/png',
}

// The drawing in source: the file's text, or a PNG's bytes. Throws when it
// holds none.
export async function loadDrawing(
  kind: DrawingKind,
  source: string | Blob,
): Promise<LoadedDrawing> {
  if (kind === 'library') {
    const items = await loadLibraryFromBlob(
      new Blob([source], { type: TYPES.scene }),
    )
    return {
      // The library open beside an empty canvas
      initial: {
        elements: [],
        libraryItems: items,
        appState: { openSidebar: { name: 'default', tab: 'library' } },
      },
      base: libraryHash(items),
    }
  }
  let obsidian: ObsidianDrawing | undefined
  let blob: Blob
  if (kind === 'obsidian') {
    obsidian = readObsidianDrawing(source as string)
    if (!obsidian) throw new Error('no drawing in the Markdown')
    blob = new Blob([obsidian.json], { type: TYPES.scene })
  } else blob = new Blob([source], { type: TYPES[kind] })
  const data = await loadFromBlob(blob, null, null)
  return {
    initial: {
      elements: data.elements,
      appState: data.appState,
      files: data.files,
    },
    base: sceneHash(data.elements, data.appState),
    obsidian,
  }
}

// A scene's elements (each one's version) and background: what a save
// writes that the user changes. An image added comes with its element.
export function sceneHash(
  elements: readonly ExcalidrawElement[],
  appState: Partial<AppState>,
): string {
  return `${hashElementsVersion(elements)}:${appState.viewBackgroundColor}`
}

export function libraryHash(items: LibraryItems): string {
  return String(getLibraryItemsHash(items))
}

// The text of a file of kind holding scene: source is the text it was read
// from (an Obsidian file's Markdown keeps all but the scene and its texts)
export async function serializeDrawing(
  kind: Exclude<DrawingKind, 'library' | 'png'>,
  scene: Scene,
  source: string,
  obsidian?: ObsidianDrawing,
): Promise<string> {
  if (kind === 'svg') {
    // The scene inside, so it opens again as a drawing, with the background
    // and dark mode the SVG had (the scene does not keep them). Its fonts
    // are named, not inlined: inlining subsets them with WebAssembly, which
    // the page's policy does not run.
    const svg = await exportToSvg({
      elements: getNonDeletedElements(scene.elements),
      appState: {
        ...scene.appState,
        exportEmbedScene: true,
        exportBackground: SVG_BACKGROUND.test(source),
        exportWithDarkMode: SVG_DARK.test(source),
      },
      files: scene.files,
      skipInliningFonts: true,
    })
    return svg.outerHTML
  }
  const json = keepSource(
    serializeAsJSON(scene.elements, scene.appState, scene.files, 'local'),
    obsidian ? obsidian.json : source,
  )
  if (kind === 'obsidian')
    return writeObsidianDrawing(
      source,
      obsidian as ObsidianDrawing,
      json,
      textsOf(scene.elements),
    )
  return json
}

// A library's text: source is the one it was read from
export function serializeLibrary(items: LibraryItems, source: string): string {
  return keepSource(serializeLibraryAsJSON(items), source)
}

// json written as from where the file was read: Excalidraw writes the
// page's origin (a host of the user's) as its source otherwise, and every
// save of a file made elsewhere would change it
function keepSource(json: string, from: string): string {
  let source: unknown
  try {
    source = (JSON.parse(from) as { source?: unknown }).source
  } catch {
    return json
  }
  if (typeof source !== 'string') return json
  return JSON.stringify({ ...JSON.parse(json), source }, null, 2)
}

// The text elements left, for an Obsidian file's Text Elements section
function textsOf(elements: readonly ExcalidrawElement[]) {
  return elements
    .filter(
      (e): e is ExcalidrawTextElement => e.type === 'text' && !e.isDeleted,
    )
    .map((e) => ({ id: e.id, text: e.originalText }))
}
