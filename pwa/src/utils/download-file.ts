import type { NotifyOptions } from '../app-views'
import {
  checkFileDownload,
  fetchFileDownload,
  fileDownloadUrl,
  RequestError,
} from '../hooks/use-mux-api'
import type { MessageKey } from '../i18n/messages/en'
import type { Translate } from '../i18n/translate'
import { isIos, isStandalone } from './notify-permission'
import { UNSAFE_CHARS, visibleUnsafe } from './unsafe-chars'

// How long a blob: URL stays alive after its link was clicked: the browser
// reads it by then, and revoking it at once can cancel the save.
export const BLOB_REVOKE_MS = 60_000

// What a refused download tells the user, by the server's code.
export function downloadErrorMessage(
  err: unknown,
  name: string,
  t: Translate<MessageKey>,
): string {
  if (!(err instanceof RequestError))
    return t('files.downloadError.failed', { name })
  if (err.status === 409 && err.root) return t('files.rootChanged')
  if (err.status === 404) return t('files.downloadError.gone', { name })
  switch (err.code) {
    case 'sensitive':
      return t('files.downloadError.sensitive', { name })
    case 'not_allowed':
      return t('files.downloadError.notAllowed', { name })
    case 'symlink':
      return t('files.downloadError.symlink')
    case 'not_file':
      return t('files.downloadError.notFile', { name })
    case 'too_large':
      return t('files.downloadError.tooLarge', { name })
    case 'busy':
      return t('files.downloadError.busy')
    case 'view_only':
      return t('files.downloadError.viewOnly')
    case 'changed':
      return t('files.downloadError.changed', { name })
    default:
      return t('files.downloadError.failed', { name })
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
export async function shareFile(
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
  // The Place the file is under
  place?: string
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
  file: DownloadTarget,
  notify: (message: string, options?: NotifyOptions) => void,
  t: Translate<MessageKey>,
  onRootChanged?: (root: string) => void,
  deps: Partial<DownloadDeps> = {},
): Promise<void> {
  const base = file.path.slice(file.path.lastIndexOf('/') + 1)
  const shown = visibleUnsafe(base)
  // The name the file is saved as, cleaned as the server's
  // Content-Disposition is (downloadName): a bidi mark could make one name
  // pose as another in the share sheet or the downloads list.
  const saveAs = base.replace(UNSAFE_CHARS, '') || 'download'

  const opts = { root: file.root, reveal: file.reveal }
  const iosStandalone = deps.iosStandalone ?? isIosStandalone()
  try {
    const target = { paneId: file.paneId, place: file.place }
    if (!iosStandalone) await checkFileDownload(target, file.path, opts)
    await startDownload(fileDownloadUrl(target, file.path, opts), saveAs, {
      iosStandalone,
      fetchBlob: deps.fetchBlob ?? fetchFileDownload,
      nav: deps.nav ?? navigator,
      onFetching: () => notify(t('files.downloading', { name: shown })),
      onShareBlocked: (share) =>
        notify(t('files.downloadReady', { name: shown }), {
          action: { label: t('files.viewer.save'), onClick: share },
          duration: 15_000,
        }),
    })
  } catch (err) {
    if (err instanceof RequestError && err.status === 409 && err.root)
      onRootChanged?.(err.root)
    notify(downloadErrorMessage(err, shown, t), { variant: 'danger' })
  }
}

// Saves a file the page made (an export): a blob: link, or in the iOS
// home-screen app the share sheet when it takes the file.
export async function saveMadeFile(
  file: File,
  deps: Partial<Pick<DownloadDeps, 'iosStandalone' | 'nav'>> = {},
): Promise<void> {
  const nav = deps.nav ?? navigator
  if (
    (deps.iosStandalone ?? isIosStandalone()) &&
    nav.canShare?.({ files: [file] })
  ) {
    await shareFile(nav, file)
    return
  }
  const href = URL.createObjectURL(file)
  clickLink(href, file.name)
  setTimeout(() => URL.revokeObjectURL(href), BLOB_REVOKE_MS)
}
