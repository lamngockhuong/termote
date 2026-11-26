import { crc32, deflateSync } from 'node:zlib'
// CommonJS: Node gives it as the default export only
import LZString from 'lz-string'

// Excalidraw files of each kind Files shows as a drawing, written as
// Excalidraw and Obsidian's Excalidraw plugin write them: a rectangle and
// a text element (in Excalifont, so its font is fetched).

const base = {
  angle: 0,
  strokeColor: '#1e1e1e',
  backgroundColor: 'transparent',
  fillStyle: 'solid',
  strokeWidth: 2,
  strokeStyle: 'solid',
  roughness: 1,
  opacity: 100,
  groupIds: [],
  frameId: null,
  roundness: null,
  boundElements: null,
  updated: 1,
  link: null,
  locked: false,
  isDeleted: false,
}

export const RECT = {
  ...base,
  id: 'rect1',
  type: 'rectangle',
  x: 100,
  y: 100,
  width: 200,
  height: 120,
  seed: 1,
  version: 2,
  versionNonce: 11,
  index: 'a0',
}

export const TEXT = {
  ...base,
  id: 'text1',
  type: 'text',
  x: 120,
  y: 260,
  width: 160,
  height: 25,
  seed: 2,
  version: 2,
  versionNonce: 22,
  index: 'a1',
  text: 'Hello drawing',
  originalText: 'Hello drawing',
  fontSize: 20,
  fontFamily: 5,
  textAlign: 'left',
  verticalAlign: 'top',
  containerId: null,
  autoResize: true,
  lineHeight: 1.25,
}

export function sceneJson(elements: object[] = [RECT, TEXT]): string {
  return JSON.stringify(
    {
      type: 'excalidraw',
      version: 2,
      source: 'https://excalidraw.com',
      elements,
      appState: { viewBackgroundColor: '#ffffff', gridSize: null },
      files: {},
    },
    null,
    2,
  )
}

// A library of one item: the rectangle
export function libraryJson(): string {
  return JSON.stringify(
    {
      type: 'excalidrawlib',
      version: 2,
      source: 'https://excalidraw.com',
      libraryItems: [
        { id: 'item1', status: 'unpublished', created: 1, name: 'Box', elements: [RECT] },
      ],
    },
    null,
    2,
  )
}

// The scene as Excalidraw embeds it: deflated, as a byte string, in JSON
function encoded(json: string): string {
  return JSON.stringify({
    version: '1',
    encoding: 'bstring',
    compressed: true,
    encoded: deflateSync(Buffer.from(json, 'utf8')).toString('latin1'),
  })
}

// An SVG of the drawing with the scene inside (payload version 2: Base64 of
// that byte string)
export function svgWithScene(): string {
  const payload = Buffer.from(encoded(sceneJson()), 'latin1').toString('base64')
  return `<svg version="1.1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300" width="400" height="300"><!-- svg-source:excalidraw --><metadata><!-- payload-type:application/vnd.excalidraw+json --><!-- payload-version:2 --><!-- payload-start -->${payload}<!-- payload-end --></metadata><rect x="0" y="0" width="400" height="300" fill="#ffffff"/><rect x="100" y="100" width="200" height="120" fill="none" stroke="#1e1e1e"/></svg>\n`
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

// A 1x1 white PNG with the scene in a tEXt chunk, before IEND
export function pngWithScene(): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(1, 0)
  ihdr.writeUInt32BE(1, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // RGB
  const pixels = deflateSync(Buffer.from([0, 255, 255, 255]))
  const text = Buffer.concat([
    Buffer.from('application/vnd.excalidraw+json\0', 'latin1'),
    Buffer.from(encoded(sceneJson()), 'latin1'),
  ])
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', ihdr),
    chunk('IDAT', pixels),
    chunk('tEXt', text),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// Obsidian's Markdown: the texts listed, the scene compressed in lines
export function obsidianMarkdown(): string {
  const c = LZString.compressToBase64(sceneJson())
  const lines: string[] = []
  for (let i = 0; i < c.length; i += 256) lines.push(c.slice(i, i + 256))
  return [
    '---',
    '',
    'excalidraw-plugin: parsed',
    'tags: [excalidraw]',
    '',
    '---',
    '==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠== You can decompress Drawing data with the command palette: \'Decompress current Excalidraw file\'. For more info check in plugin settings under \'Saving\'',
    '',
    '# Excalidraw Data',
    '',
    '## Text Elements',
    // As written, with a link: the scene holds it as shown
    'Hello [[drawing]] ^text1',
    '',
    '%%',
    '## Drawing',
    '```compressed-json',
    lines.map((l) => `${l}\n\n`).join('') + '```',
    '%%',
    '',
  ].join('\n')
}
