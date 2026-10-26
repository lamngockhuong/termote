// Checks what an .xlsx or .docx (a zip) declares before a parser inflates
// it, run in the worker that parses it. It checks claims only: an entry can
// still inflate to more than it declares. What really bounds the work is
// the worker's timeout, which terminates it.

// More entries than an Office file of at most 30 MiB holds
export const ZIP_MAX_ENTRIES = 2000
// Declared uncompressed sizes: one entry, and all of them
export const ZIP_MAX_ENTRY = 100 << 20
export const ZIP_MAX_TOTAL = 200 << 20

const EOCD_SIG = 0x06054b50
const EOCD_SIZE = 22
const ZIP64_LOCATOR_SIG = 0x07064b50
const CENTRAL_SIG = 0x02014b50
const CENTRAL_SIZE = 46
const LOCAL_SIG = 0x04034b50
const LOCAL_SIZE = 30
// The data descriptor flag: sizes after the data, zero in the local header
const FLAG_DESCRIPTOR = 1 << 3

// corrupt: malformed, or a zip this guard does not take (ZIP64, a data
// descriptor, a local header that differs from the central one); too_big:
// more entries or declared bytes than the limits
export type ZipGuardCode = 'corrupt' | 'too_big'

export class ZipGuardError extends Error {
  constructor(
    readonly code: ZipGuardCode,
    message: string,
  ) {
    super(message)
  }
}

const corrupt = (why: string) => new ZipGuardError('corrupt', why)

// The end of central directory record: the last one, searched back over a
// comment of at most 64 KiB
function findEocd(v: DataView): number {
  const last = v.byteLength - EOCD_SIZE
  for (let i = last; i >= 0 && i >= last - 0xffff; i--) {
    if (v.getUint32(i, true) === EOCD_SIG) return i
  }
  throw corrupt('no end of central directory')
}

// Throws a ZipGuardError when buf is not a zip this guard lets a parser read
export function checkZip(buf: ArrayBuffer): void {
  const v = new DataView(buf)
  const bytes = new Uint8Array(buf)
  const eocd = findEocd(v)
  const count = v.getUint16(eocd + 10, true)
  const cdSize = v.getUint32(eocd + 12, true)
  const cdOffset = v.getUint32(eocd + 16, true)
  if (
    count === 0xffff ||
    cdSize === 0xffffffff ||
    cdOffset === 0xffffffff ||
    (eocd >= 20 && v.getUint32(eocd - 20, true) === ZIP64_LOCATOR_SIG)
  )
    throw corrupt('ZIP64')
  if (v.getUint16(eocd + 8, true) !== count) throw corrupt('split archive')
  if (count > ZIP_MAX_ENTRIES)
    throw new ZipGuardError('too_big', `${count} entries`)
  if (cdOffset + cdSize > eocd) throw corrupt('central directory out of range')

  const names = new Set<string>()
  let total = 0
  let at = cdOffset
  for (let n = 0; n < count; n++) {
    if (
      at + CENTRAL_SIZE > cdOffset + cdSize ||
      v.getUint32(at, true) !== CENTRAL_SIG
    )
      throw corrupt('bad central directory entry')
    const flags = v.getUint16(at + 8, true)
    const method = v.getUint16(at + 10, true)
    const csz = v.getUint32(at + 20, true)
    const usz = v.getUint32(at + 24, true)
    const nameLen = v.getUint16(at + 28, true)
    const next =
      at +
      CENTRAL_SIZE +
      nameLen +
      v.getUint16(at + 30, true) +
      v.getUint16(at + 32, true)
    const local = v.getUint32(at + 42, true)
    if (next > cdOffset + cdSize) throw corrupt('bad central directory entry')
    const nameBytes = bytes.subarray(
      at + CENTRAL_SIZE,
      at + CENTRAL_SIZE + nameLen,
    )
    const name = new TextDecoder().decode(nameBytes)
    if (csz === 0xffffffff || usz === 0xffffffff || local === 0xffffffff)
      throw corrupt('ZIP64')
    if (flags & FLAG_DESCRIPTOR) throw corrupt('data descriptor')
    if (usz === 0 && csz > 0) throw corrupt(`${name}: no uncompressed size`)
    if (names.has(name)) throw corrupt(`${name}: twice`)
    names.add(name)
    if (usz > ZIP_MAX_ENTRY)
      throw new ZipGuardError('too_big', `${name}: ${usz} bytes`)
    total += usz
    if (total > ZIP_MAX_TOTAL)
      throw new ZipGuardError('too_big', `${total} bytes in all`)
    checkLocal(v, bytes, local, {
      flags,
      method,
      csz,
      usz,
      nameBytes,
      cdOffset,
    })
    at = next
  }
}

// The local header of an entry says what the central directory does: a
// parser that reads it (SheetJS takes the sizes from there) reads the same
function checkLocal(
  v: DataView,
  bytes: Uint8Array,
  at: number,
  c: {
    flags: number
    method: number
    csz: number
    usz: number
    nameBytes: Uint8Array
    cdOffset: number
  },
) {
  if (at + LOCAL_SIZE > c.cdOffset || v.getUint32(at, true) !== LOCAL_SIG)
    throw corrupt('bad local header')
  const nameLen = v.getUint16(at + 26, true)
  const dataAt = at + LOCAL_SIZE + nameLen + v.getUint16(at + 28, true)
  if (
    (v.getUint16(at + 6, true) & FLAG_DESCRIPTOR) !==
      (c.flags & FLAG_DESCRIPTOR) ||
    v.getUint16(at + 8, true) !== c.method ||
    v.getUint32(at + 18, true) !== c.csz ||
    v.getUint32(at + 22, true) !== c.usz ||
    nameLen !== c.nameBytes.length ||
    !bytes
      .subarray(at + LOCAL_SIZE, at + LOCAL_SIZE + nameLen)
      .every((b, i) => b === c.nameBytes[i])
  )
    throw corrupt('local header differs from the central directory')
  if (dataAt + c.csz > c.cdOffset) throw corrupt('entry data out of range')
}
