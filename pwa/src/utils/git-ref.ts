// Branch names the server accepts (validBranchName in
// server/mux_worktrees.go): what `git check-ref-format --branch` accepts,
// less every Unicode control, format (bidi, zero-width) and space character,
// so a name cannot show as another one in a confirmation. Checked here so a
// mistyped name is pointed out before anything is sent.

export const MAX_BRANCH_BYTES = 255

// Control, format, surrogate and white space characters, and the ASCII
// characters git refuses in a ref.
const REFUSED = /[\p{Cc}\p{Cf}\p{Cs}\p{White_Space}~^:?*[\\]/u

const bytes = (s: string) => new TextEncoder().encode(s).length

export function validBranchName(s: string): boolean {
  if (
    s === '' ||
    bytes(s) > MAX_BRANCH_BYTES ||
    s === '@' ||
    s === 'HEAD' ||
    s.startsWith('-') ||
    s.startsWith('/') ||
    s.endsWith('/') ||
    s.endsWith('.') ||
    s.includes('..') ||
    s.includes('@{') ||
    s.includes('//') ||
    REFUSED.test(s)
  ) {
    return false
  }
  return s.split('/').every((c) => !c.startsWith('.') && !c.endsWith('.lock'))
}
