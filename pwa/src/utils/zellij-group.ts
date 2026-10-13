// A Zellij group's id, as the server makes it: "z" + the session name's
// UTF-8 bytes in unpadded base64url. A rename changes it, and with it the
// prefix of every tab id, pane id and tab key in that session.
export function zellijGroupId(session: string): string {
  let bin = ''
  for (const b of new TextEncoder().encode(session)) {
    bin += String.fromCharCode(b)
  }
  const b64 = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_')
  return `z${b64.replace(/=+$/, '')}`
}

// The default session ("main"): it cannot be renamed, and closing it makes
// the next snapshot start it again, empty.
export const ZELLIJ_DEFAULT_GROUP_ID = zellijGroupId('main')
