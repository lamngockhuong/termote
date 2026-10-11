// Checks of a file path typed in the New file and Rename boxes, caught
// before sending; the server checks the name again.

// The path as a whole: something to send
export function nameProblem(path: string): string | undefined {
  if (!path) return 'Enter a file name'
  if (path.endsWith('/')) return 'Enter a file name after the last /'
  if (path.split('/').includes('..')) return "A path can't go up with .."
}

// A save's and a rename's temporary files: names the server never takes
const TEMP_NAME = /^\.termote-(edit|rename)-[0-9a-f]{16}$/

// Whether the server takes name as the name of a new file (its
// validNamePart): at most 255 bytes, not ending in a dot or a space, no
// control character, not a temporary file's name. Characters only a Windows
// host refuses are left to the server.
export function fileNameProblem(name: string): string | undefined {
  if (!name) return 'Enter a file name'
  if (new TextEncoder().encode(name).length > 255)
    return 'This name is too long'
  if (name.endsWith('.') || name.endsWith(' '))
    return "A name can't end with a dot or a space"
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the characters refused
  if (/[\u0000-\u001f\u007f-\u009f]/.test(name))
    return "A name can't hold control characters"
  if (TEMP_NAME.test(name)) return "This name can't be used"
}

// Where the base name of path starts and ends without its extension: what a
// Rename box selects first. A name with no extension, or only a leading
// dot (.env), is selected whole.
export function baseNameSelection(path: string): [number, number] {
  const start = path.lastIndexOf('/') + 1
  const dot = path.lastIndexOf('.')
  return [start, dot > start ? dot : path.length]
}
