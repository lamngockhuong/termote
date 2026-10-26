import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import {
  checkZip,
  ZIP_MAX_ENTRIES,
  ZIP_MAX_ENTRY,
  ZipGuardError,
} from './zip-guard'

interface Entry {
  name: string
  data?: string
  // Declared sizes, when they differ from the data's
  usz?: number
  csz?: number
  flags?: number
}

// A zip of stored entries, laid out by hand so a test can bend any field:
// the bytes, and where each local and central header starts
function makeZip(entries: Entry[], comment = '') {
  const enc = new TextEncoder()
  const parts: number[] = []
  const u16 = (n: number) => parts.push(n & 0xff, (n >> 8) & 0xff)
  const u32 = (n: number) => {
    u16(n & 0xffff)
    u16(n >>> 16)
  }
  const raw = (b: Uint8Array) => parts.push(...b)
  const locals: number[] = []
  for (const e of entries) {
    const name = enc.encode(e.name)
    const data = enc.encode(e.data ?? '')
    locals.push(parts.length)
    u32(0x04034b50)
    u16(20)
    u16(e.flags ?? 0)
    u16(0) // stored
    u32(0) // time, date
    u32(0) // crc
    u32(e.csz ?? data.length)
    u32(e.usz ?? data.length)
    u16(name.length)
    u16(0)
    raw(name)
    raw(data)
  }
  const cdOffset = parts.length
  const centrals: number[] = []
  entries.forEach((e, i) => {
    const name = enc.encode(e.name)
    const size = enc.encode(e.data ?? '').length
    centrals.push(parts.length)
    u32(0x02014b50)
    u16(20)
    u16(20)
    u16(e.flags ?? 0)
    u16(0)
    u32(0)
    u32(0)
    u32(e.csz ?? size)
    u32(e.usz ?? size)
    u16(name.length)
    u16(0)
    u16(0)
    u16(0)
    u16(0)
    u32(0)
    u32(locals[i])
    raw(name)
  })
  const cdSize = parts.length - cdOffset
  const eocd = parts.length
  u32(0x06054b50)
  u16(0)
  u16(0)
  u16(entries.length)
  u16(entries.length)
  u32(cdSize)
  u32(cdOffset)
  const c = enc.encode(comment)
  u16(c.length)
  raw(c)
  const bytes = new Uint8Array(parts)
  return { bytes, view: new DataView(bytes.buffer), locals, centrals, eocd }
}

const one = (e: Partial<Entry> = {}) =>
  makeZip([{ name: 'word/document.xml', data: '<w:document/>', ...e }])

function code(buf: ArrayBuffer | Uint8Array) {
  try {
    checkZip(buf instanceof Uint8Array ? (buf.buffer as ArrayBuffer) : buf)
    return 'ok'
  } catch (e) {
    expect(e).toBeInstanceOf(ZipGuardError)
    return `${(e as ZipGuardError).code}: ${(e as Error).message}`
  }
}

describe('checkZip', () => {
  it('takes a well-formed zip, and one SheetJS writes', () => {
    expect(code(one().bytes)).toBe('ok')
    expect(
      code(makeZip([{ name: 'a' }, { name: 'b', data: 'x' }], 'note').bytes),
    ).toBe('ok')
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[1, 2]]), 'S')
    expect(code(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }))).toBe('ok')
  })

  it('finds the end record behind a long comment', () => {
    expect(code(makeZip([{ name: 'a' }], 'c'.repeat(0xffff)).bytes)).toBe('ok')
  })

  it.each([
    ['empty', new Uint8Array(0)],
    ['short', new Uint8Array(10)],
    ['no end record', new Uint8Array(100)],
  ])('refuses %s', (_, b) => {
    expect(code(b)).toMatch(/^corrupt: no end/)
  })

  it('refuses ZIP64', () => {
    const z = one()
    z.view.setUint16(z.eocd + 8, 0xffff, true)
    z.view.setUint16(z.eocd + 10, 0xffff, true)
    expect(code(z.bytes)).toBe('corrupt: ZIP64')
    const s = one()
    s.view.setUint32(s.eocd + 12, 0xffffffff, true)
    expect(code(s.bytes)).toBe('corrupt: ZIP64')
    const o = one()
    o.view.setUint32(o.eocd + 16, 0xffffffff, true)
    expect(code(o.bytes)).toBe('corrupt: ZIP64')
    const e = one({ usz: 0xffffffff })
    expect(code(e.bytes)).toBe('corrupt: ZIP64')
    // A ZIP64 end locator right before the end record
    const l = makeZip([{ name: 'a'.repeat(20) }])
    l.view.setUint32(l.eocd - 20, 0x07064b50, true)
    expect(code(l.bytes)).toBe('corrupt: ZIP64')
  })

  it('refuses a split archive', () => {
    const z = one()
    z.view.setUint16(z.eocd + 8, 0, true)
    expect(code(z.bytes)).toBe('corrupt: split archive')
  })

  it('refuses too many entries', () => {
    const z = one()
    z.view.setUint16(z.eocd + 8, ZIP_MAX_ENTRIES + 1, true)
    z.view.setUint16(z.eocd + 10, ZIP_MAX_ENTRIES + 1, true)
    expect(code(z.bytes)).toBe(`too_big: ${ZIP_MAX_ENTRIES + 1} entries`)
  })

  it('refuses a central directory out of range', () => {
    const z = one()
    z.view.setUint32(z.eocd + 12, 1000, true)
    expect(code(z.bytes)).toBe('corrupt: central directory out of range')
  })

  it('refuses a bad central entry', () => {
    const z = one()
    z.view.setUint32(z.centrals[0], 0, true)
    expect(code(z.bytes)).toBe('corrupt: bad central directory entry')
    // Fewer bytes than the count of entries needs
    const n = one()
    n.view.setUint16(n.eocd + 8, 2, true)
    n.view.setUint16(n.eocd + 10, 2, true)
    expect(code(n.bytes)).toBe('corrupt: bad central directory entry')
    // A name longer than the directory
    const l = one()
    l.view.setUint16(l.centrals[0] + 28, 500, true)
    expect(code(l.bytes)).toBe('corrupt: bad central directory entry')
  })

  it('refuses a data descriptor', () => {
    expect(code(one({ flags: 8 }).bytes)).toBe('corrupt: data descriptor')
  })

  it('refuses an entry that declares no size but holds data', () => {
    expect(code(one({ usz: 0 }).bytes)).toBe(
      'corrupt: word/document.xml: no uncompressed size',
    )
  })

  it('refuses a name twice', () => {
    expect(code(makeZip([{ name: 'a' }, { name: 'a' }]).bytes)).toBe(
      'corrupt: a: twice',
    )
  })

  it('refuses declared sizes over the limits', () => {
    expect(code(one({ usz: ZIP_MAX_ENTRY + 1 }).bytes)).toBe(
      `too_big: word/document.xml: ${ZIP_MAX_ENTRY + 1} bytes`,
    )
    const z = makeZip([
      { name: 'a', usz: ZIP_MAX_ENTRY },
      { name: 'b', usz: ZIP_MAX_ENTRY },
      { name: 'c', usz: 1 },
    ])
    expect(code(z.bytes)).toBe(`too_big: ${2 * ZIP_MAX_ENTRY + 1} bytes in all`)
  })

  it('refuses a local header that is not one', () => {
    const z = one()
    z.view.setUint32(z.locals[0], 0, true)
    expect(code(z.bytes)).toBe('corrupt: bad local header')
    const o = one()
    o.view.setUint32(o.centrals[0] + 42, o.centrals[0], true)
    expect(code(o.bytes)).toBe('corrupt: bad local header')
  })

  it.each([
    ['flags', 6, 16, 8],
    ['method', 8, 16, 8],
    ['compressed size', 18, 32, 1],
    ['size', 22, 32, 1],
    ['name length', 26, 16, 1],
  ])('refuses a local header whose %s differs', (_, off, bits, value) => {
    const z = one()
    if (bits === 16) z.view.setUint16(z.locals[0] + off, value, true)
    else z.view.setUint32(z.locals[0] + off, value, true)
    expect(code(z.bytes)).toBe(
      'corrupt: local header differs from the central directory',
    )
  })

  it('refuses a local header whose name differs', () => {
    const z = one()
    z.bytes[z.locals[0] + 30] = 'x'.charCodeAt(0)
    expect(code(z.bytes)).toBe(
      'corrupt: local header differs from the central directory',
    )
  })

  it('refuses entry data that runs into the central directory', () => {
    const z = one()
    // Both headers agree, on a size the file does not hold
    z.view.setUint32(z.locals[0] + 18, 5000, true)
    z.view.setUint32(z.centrals[0] + 20, 5000, true)
    expect(code(z.bytes)).toBe('corrupt: entry data out of range')
  })
})
