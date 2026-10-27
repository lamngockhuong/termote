// The names the Files view gives a text file's encoding.
import type { FileEncoding } from '../hooks/use-mux-api'

// In the order the encoding menu lists them
export const ENCODINGS: readonly FileEncoding[] = [
  'utf-8',
  'utf-16le',
  'utf-16be',
  'shift_jis',
  'euc-jp',
]

const NAMES: Record<FileEncoding, string> = {
  'utf-8': 'UTF-8',
  'utf-16le': 'UTF-16 LE',
  'utf-16be': 'UTF-16 BE',
  shift_jis: 'Shift-JIS',
  'euc-jp': 'EUC-JP',
}

// "UTF-8", "UTF-16 LE with BOM", "Shift-JIS"
export function encodingLabel(enc: FileEncoding, bom = false): string {
  return bom ? `${NAMES[enc]} with BOM` : NAMES[enc]
}

export function isFileEncoding(v: unknown): v is FileEncoding {
  return typeof v === 'string' && Object.hasOwn(NAMES, v)
}
