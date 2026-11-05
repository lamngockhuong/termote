import { UNSAFE_CHARS } from './unsafe-chars'

// The compact sidebar's avatar of a workspace: its name's first letter on a
// colour of its own, the same colour every time for the same name.

// Written out whole so Tailwind finds each class (index.css, --tm-avatar-N)
const AVATAR_TONES = [
  'bg-avatar-1',
  'bg-avatar-2',
  'bg-avatar-3',
  'bg-avatar-4',
  'bg-avatar-5',
  'bg-avatar-6',
  'bg-avatar-7',
  'bg-avatar-8',
] as const

// The first character a reader sees in name, in capitals: one grapheme, so
// an emoji or a letter with its combining marks stays whole; '?' when the
// name holds nothing visible.
export function avatarLetter(name: string): string {
  const shown = name.replace(UNSAFE_CHARS, '').replace(/\s/gu, '')
  if (!shown) return '?'
  const first =
    typeof Intl.Segmenter === 'function'
      ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
          .segment(shown)
          [Symbol.iterator]()
          .next().value!.segment
      : Array.from(shown)[0]
  return first.toLocaleUpperCase()
}

// FNV-1a over the name's UTF-16 units: stable across reloads and devices
function hash(name: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

// The background class of name's avatar
export function avatarTone(name: string): (typeof AVATAR_TONES)[number] {
  return AVATAR_TONES[hash(name) % AVATAR_TONES.length]
}
