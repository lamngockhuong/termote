import type { NotifyOptions } from '../app-views'
import {
  checkFileDownload,
  fetchFileDownload,
  fileDownloadUrl,
  RequestError,
} from '../hooks/use-mux-api'
import { isIos, isStandalone } from './notify-permission'
import { UNSAFE_CHARS, visibleUnsafe } from './unsafe-chars'

// How long a blob: URL stays alive after its link was clicked: the browser
// reads it by then, and revoking it at once can cancel the save.
export const BLOB_REVOKE_MS = 60_000

// What a refused download tells the user, by the server's code.
export function downloadErrorMessage(err: unknown, name: string): string {
  if (!(err instanceof RequestError)) return `Could not download ${name}`
  if (err.status === 409 && err.root) return "The pane's directory changed"
  if (err.status === 404) return `${name} is gone`
  switch (err.code) {
    case 'sensitive':
      return `${name} may contain secrets; not downloaded`
    case 'not_allowed':
      return `${name} can't be downloaded from here`
    case 'symlink':
      return 'A link on that path; not downloaded'
    case 'not_file':
      return `${name} is not a regular file; not downloaded`
    case 'too_large':
      return `${name} is larger than 100 MiB, too large to download`
    case 'busy':
      return 'Too many files at once; try again'
    case 'view_only':
      return 'This device is view only'
    case 'changed':
      return `${name} changed; try again`
    default:
      return `Could not download ${name}`
  }
}

// The iOS app added to the Home Screen: a link with download does nothing
// there, so the file goes through the share sheet.
export function isIosStandalone(
  nav: Navigator & { standalone?: boolean } = navigator,
): boolean {
  return isIos(nav) && isStandalone(nav)
}

function clickLink(href: string, name: string) {
  const a = document.createElement('a')
  a.href = href
  a.download = name
  a.style.display = 'none'
  document.body.append(a)
  a.click()
  a.remove()
}

export interface DownloadDeps {
  iosStandalone: boolean
  fetchBlob: (url: string) => Promise<Blob>
  nav: Pick<Navigator, 'share' | 'canShare'>
  // Told once the bytes are being read (iOS only, where nothing else shows)
  onFetching?: () => void
  // The tap's activation ran out while the bytes were read, so the sheet
  // was refused: share() is to be called from a new tap
  onShareBlocked?: (share: () => void) => void
}

// The share sheet with file, its closing ignored. Another refusal is thrown.
async function shareFile(
  nav: DownloadDeps['nav'],
  file: File,
): Promise<'shared' | 'blocked'> {
  try {
    await nav.share({ files: [file] })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError')
      return 'shared'
    if (err instanceof DOMException && err.name === 'NotAllowedError')
      return 'blocked'
    throw err
  }
  return 'shared'
}

// Hands the file at url to the browser. A link with download everywhere but
// the iOS home-screen app: same-origin, so the cookie goes with it and the
// browser shows its own progress. There, the bytes are read first and go to
// the share sheet ("Save to Files"); when the tap's activation ran out (iOS
// keeps it about 5 s), from a new tap. A blob: link only when the sheet takes
// no file.
export async function startDownload(
  url: string,
  name: string,
  deps: DownloadDeps,
): Promise<void> {
  if (!deps.iosStandalone) {
    clickLink(url, name)
    return
  }
  deps.onFetching?.()
  const blob = await deps.fetchBlob(url)
  const file = new File([blob], name, { type: 'application/octet-stream' })
  if (deps.nav.canShare?.({ files: [file] })) {
    if ((await shareFile(deps.nav, file)) === 'blocked')
      // Another refusal from the new tap is the sheet's own to show
      deps.onShareBlocked?.(
        () => void shareFile(deps.nav, file).catch(() => {}),
      )
    return
  }
  const href = URL.createObjectURL(file)
  clickLink(href, name)
  setTimeout(() => URL.revokeObjectURL(href), BLOB_REVOKE_MS)
}

export interface DownloadTarget {
  paneId: string
  root?: string
  path: string
  reveal: boolean
}

// Checks the download first (every refusal gets a message: the browser
// would only say "Failed"), then starts it. In the iOS home-screen app the
// read of the bytes tells a refusal itself (same codes), and skipping the
// check keeps more of the tap's activation for the share sheet.
// onRootChanged: a 409 naming the pane's root now.
export async function downloadFile(
  t: DownloadTarget,
  notify: (message: string, options?: NotifyOptions) => void,
  onRootChanged?: (root: string) => void,
  deps: Partial<DownloadDeps> = {},
): Promise<void> {
  const base = t.path.slice(t.path.lastIndexOf('/') + 1)
  const shown = visibleUnsafe(base)
  // The name the file is saved as, cleaned as the server's
  // Content-Disposition is (downloadName): a bidi mark could make one name
  // pose as another in the share sheet or the downloads list.
  const saveAs = base.replace(UNSAFE_CHARS, '') || 'download'

  const opts = { root: t.root, reveal: t.reveal }
  const iosStandalone = deps.iosStandalone ?? isIosStandalone()
  try {
    if (!iosStandalone) await checkFileDownload(t.paneId, t.path, opts)
    await startDownload(fileDownloadUrl(t.paneId, t.path, opts), saveAs, {
      iosStandalone,
      fetchBlob: deps.fetchBlob ?? fetchFileDownload,
      nav: deps.nav ?? navigator,
      onFetching: () => notify(`Downloading ${shown}`),
      onShareBlocked: (share) =>
        notify(`${shown} is ready`, {
          action: { label: 'Save', onClick: share },
          duration: 15_000,
        }),
    })
  } catch (err) {
    if (err instanceof RequestError && err.status === 409 && err.root)
      onRootChanged?.(err.root)
    notify(downloadErrorMessage(err, shown), { variant: 'danger' })
  }
}
