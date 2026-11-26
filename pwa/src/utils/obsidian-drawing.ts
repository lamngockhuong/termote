import { compressToBase64, decompressFromBase64 } from 'lz-string'

// The Markdown of Obsidian's Excalidraw plugin (.excalidraw.md): the scene
// is the JSON in the fenced block under the last "Drawing" heading, as is
// (```json) or LZ-string compressed to Base64 (```compressed-json) and cut
// into lines. The "Text Elements" section before it lists each text
// element's text as written, links included ("[[Note]]", "![[Note#a]]"),
// with its id; the scene holds the text shown, and the plugin reads the
// section back over it. A save writes both: a text left as it was keeps
// its line of the section.

export interface ObsidianDrawing {
  // The scene's JSON
  json: string
  // Where the fenced block's body is in the Markdown (end: its closing fence)
  start: number
  end: number
  compressed: boolean
  // Where the Drawing heading starts: the Text Elements section is before it
  heading: number
  // Each text element's line of the section (by id), and its text in the
  // scene as read
  raw: Record<string, string>
  shown: Record<string, string>
}

// One text element, as the editor holds it
export interface ObsidianText {
  id: string
  text: string
}

// The plugin writes the compressed scene in lines of this many characters
const CHUNK = 256

const HEADING = /^#{1,2} Drawing[ \t]*$/gm
const OPEN = /^```(compressed-json|json)[ \t]*\n/m
const CLOSE = /^```[ \t]*$/m
const TEXTS = /^#{1,2} Text Elements[ \t]*$/gm
// What ends the Text Elements section: the comment fence (%%) the plugin
// hides the rest in, or the plugin's next section. A text's own line may
// start with "#".
const SECTION_END =
  /^(%%[ \t]*|#{1,2} (Element Links|Embedded Files|Drawing)[ \t]*)$/m
// One text of the section: its text (any lines), " ^id", an empty line
const ENTRY = /([\s\S]*?) \^([\w-]+)\n\n/g

const lastOf = (re: RegExp, s: string) => [...s.matchAll(re)].at(-1)

// The scene in md, or undefined when it holds none that can be read
export function readObsidianDrawing(md: string): ObsidianDrawing | undefined {
  const heading = lastOf(HEADING, md)
  if (!heading) return undefined
  const after = md.slice(heading.index)
  const open = OPEN.exec(after)
  if (!open) return undefined
  const start = heading.index + open.index + open[0].length
  const close = CLOSE.exec(md.slice(start))
  if (!close) return undefined
  const end = start + close.index
  const body = md.slice(start, end)
  const compressed = open[1] === 'compressed-json'
  const json = compressed
    ? decompressFromBase64(body.replace(/\s+/g, ''))
    : body.trim()
  if (!json) return undefined
  const raw: Record<string, string> = {}
  const section = sectionOf(md, heading.index)
  if (section)
    for (const m of md.slice(section.from, section.to).matchAll(ENTRY))
      raw[m[2]] = m[1].replace(/^\n+/, '')
  return {
    json,
    start,
    end,
    compressed,
    heading: heading.index,
    raw,
    shown: shownTexts(json),
  }
}

// Where the Text Elements section's lines are, between its heading's line
// and its end (the Drawing heading at the latest)
function sectionOf(md: string, heading: number) {
  const m = lastOf(TEXTS, md.slice(0, heading))
  if (!m) return undefined
  const from = m.index + m[0].length + 1
  // The Drawing heading, in md, ends it at the latest
  const end = SECTION_END.exec(md.slice(from)) as RegExpExecArray
  return { from, to: from + end.index }
}

// Each text element's text in the scene json, by id
function shownTexts(json: string): Record<string, string> {
  const out: Record<string, string> = {}
  try {
    const els = (JSON.parse(json) as { elements?: unknown }).elements
    if (!Array.isArray(els)) return out
    for (const e of els as {
      type?: unknown
      id?: unknown
      originalText?: unknown
    }[])
      if (e?.type === 'text' && typeof e.id === 'string')
        out[e.id] = String(e.originalText ?? '')
  } catch {
    // Excalidraw says the scene cannot be read
  }
  return out
}

// md with the scene json written where drawing was read from, compressed
// if it was, and the Text Elements section (when there is one) listing
// texts: one left as it was keeps its line as read
export function writeObsidianDrawing(
  md: string,
  drawing: ObsidianDrawing,
  json: string,
  texts: ObsidianText[],
): string {
  const body = drawing.compressed
    ? chunks(compressToBase64(json))
        .map((c) => `${c}\n\n`)
        .join('')
    : `${json}\n`
  const head = md.slice(0, drawing.start)
  const after = md.slice(drawing.end)
  const section = sectionOf(head, drawing.heading)
  if (!section) return head + body + after
  const list = texts
    .map((t) => {
      const kept =
        drawing.shown[t.id] === t.text ? drawing.raw[t.id] : undefined
      return `${kept ?? t.text} ^${t.id}\n\n`
    })
    .join('')
  return `${head.slice(0, section.from)}${list}${head.slice(section.to)}${body}${after}`
}

function chunks(s: string): string[] {
  const out: string[] = []
  for (let i = 0; i < s.length; i += CHUNK) out.push(s.slice(i, i + CHUNK))
  return out
}
