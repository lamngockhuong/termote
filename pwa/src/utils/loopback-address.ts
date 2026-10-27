// termote listens on 127.0.0.1 only, never on ::1 (another user of the host
// could hold that port). A page opened through "localhost" makes the browser
// try ::1 first on every new connection: refused at once on most hosts, but
// on Windows with WSL's mirrored network the attempt hangs until the browser
// falls back to 127.0.0.1, about 300 ms for each terminal stream opened.

const DISMISS_KEY = 'termote-localhost-notice'

// The same page at 127.0.0.1 when it was opened through localhost, else null.
export function loopbackAddress(
  loc: Pick<Location, 'hostname' | 'href'> = window.location,
): string | null {
  if (loc.hostname.toLowerCase() !== 'localhost') return null
  const url = new URL(loc.href)
  url.hostname = '127.0.0.1'
  return url.href
}

export function localhostNoticeDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === 'dismissed'
  } catch {
    return false
  }
}

export function dismissLocalhostNotice() {
  try {
    localStorage.setItem(DISMISS_KEY, 'dismissed')
  } catch {
    // Storage unavailable: the notice comes back on the next load.
  }
}
