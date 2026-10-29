// Checks of a file path typed in the New file and Rename boxes, caught
// before sending; the server checks the name again.
import type { MessageKey } from '../i18n/messages/en'
import type { Translate } from '../i18n/translate'

// The path as a whole: something to send
export function nameProblem(
  path: string,
  t: Translate<MessageKey>,
): string | undefined {
  if (!path) return t('files.name.empty')
  if (path.endsWith('/')) return t('files.name.afterSlash')
  if (path.split('/').includes('..')) return t('files.name.goesUp')
}

// A save's, a rename's and an upload's temporary files: names the server never takes
const TEMP_NAME = /^\.termote-(edit|rename|upload)-[0-9a-f]{16}$/

// Whether the server takes name as the name of a new file (its
// validNamePart): at most 255 bytes, not ending in a dot or a space, no
// control character, not a temporary file's name. Characters only a Windows
// host refuses are left to the server. The message's key, as callers use it
// as a yes or no.
export function fileNameProblem(name: string): MessageKey | undefined {
  if (!name) return 'files.name.empty'
  if (new TextEncoder().encode(name).length > 255) return 'files.name.tooLong'
  if (name.endsWith('.') || name.endsWith(' ')) return 'files.name.trailingDot'
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the characters refused
  if (/[\u0000-\u001f\u007f-\u009f]/.test(name)) return 'files.name.control'
  if (TEMP_NAME.test(name)) return 'files.refused.invalidName'
}

// Where the base name of path starts and ends without its extension: what a
// Rename box selects first. A name with no extension, or only a leading
// dot (.env), is selected whole.
export function baseNameSelection(path: string): [number, number] {
  const start = path.lastIndexOf('/') + 1
  const dot = path.lastIndexOf('.')
  return [start, dot > start ? dot : path.length]
}
