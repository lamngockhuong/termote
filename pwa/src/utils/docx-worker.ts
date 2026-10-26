/// <reference lib="webworker" />
// Converts a .docx in a worker (document-worker-client.ts): mammoth makes
// HTML of it, xmldom parses that HTML, and only allowed elements go back to
// the page, as a tree (docx-sanitize.ts). No HTML reaches the page and no
// DOMParser runs on its thread.
import { DOMParser } from '@xmldom/xmldom'
import mammoth from 'mammoth'
import { serveDocumentRequests } from './document-worker-client'
import { type DocChild, sanitizeTree, type XNode } from './docx-sanitize'
import { checkZip, type ZipGuardCode, ZipGuardError } from './zip-guard'

// Images kept, in decoded bytes; past it each is "[image omitted]"
export const DOCX_MAX_IMAGES = 20 << 20

const IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
])

export type DocxRequest = { type: 'convert'; buf: ArrayBuffer }

export type DocxReply =
  | { type: 'doc'; tree: DocChild[]; truncated: boolean; imagesOmitted: number }
  | { type: 'error'; code: ZipGuardCode | 'failed' }

async function convert(buf: ArrayBuffer): Promise<DocxReply> {
  checkZip(buf)
  let imageBytes = 0
  let imagesOmitted = 0
  // mammoth's browser build reads arrayBuffer, its Node build (tests) buffer;
  // JSZip under both takes an ArrayBuffer
  const input = { arrayBuffer: buf, buffer: buf } as {
    arrayBuffer: ArrayBuffer
  }
  const result = await mammoth.convertToHtml(input, {
    externalFileAccess: false,
    convertImage: mammoth.images.imgElement(async (image) => {
      if (!IMAGE_TYPES.has(image.contentType)) {
        imagesOmitted++
        return { src: '' }
      }
      const data = await image.readAsBase64String()
      const size = Math.floor((data.length * 3) / 4)
      if (imageBytes + size > DOCX_MAX_IMAGES) {
        imagesOmitted++
        return { src: '' }
      }
      imageBytes += size
      return { src: `data:${image.contentType};base64,${data}` }
    }),
  })
  // mammoth escapes text as XML does: its HTML is well-formed XML
  // Quiet: what xmldom cannot parse is left out, never logged
  const doc = new DOMParser({ errorHandler: {} }).parseFromString(
    `<root>${result.value}</root>`,
    'text/xml',
  )
  const { tree, truncated } = sanitizeTree(
    doc.documentElement as unknown as XNode,
  )
  return { type: 'doc', tree, truncated, imagesOmitted }
}

// One request's reply; a file mammoth cannot read is failed, never its error
export async function handleDocx(
  req: DocxRequest,
): Promise<{ reply: DocxReply }> {
  try {
    return { reply: await convert(req.buf) }
  } catch (err) {
    if (err instanceof ZipGuardError)
      return { reply: { type: 'error', code: err.code } }
    return { reply: { type: 'error', code: 'failed' } }
  }
}

serveDocumentRequests(self as never, handleDocx)
