import type { NotifyOptions } from '../app-views'
import { openInWindows, RequestError } from '../hooks/use-mux-api'
import type { MessageKey } from '../i18n/messages/en'
import type { Translate } from '../i18n/translate'
import { fileName } from './file-paths'
import { visibleUnsafe } from './unsafe-chars'

export interface OpenInWindowsTarget {
  paneId: string
  place?: string
  root: string
  // "/"-separated under root; "" is the root itself
  path: string
  reveal: boolean
}

// Why Windows did not open name, from the server's refusal
export function openInWindowsError(
  err: unknown,
  name: string,
  t: Translate<MessageKey>,
): string {
  if (!(err instanceof RequestError))
    return t('files.openWindows.failed', { name })
  if (err.status === 409 && err.root) return t('files.rootChanged')
  if (err.status === 404) return t('files.downloadError.gone', { name })
  switch (err.code) {
    case 'unavailable':
      return t('files.openWindows.unavailable')
    case 'sensitive':
      return t('files.openWindows.sensitive', { name })
    case 'not_allowed':
      return t('files.openWindows.notAllowed', { name })
    case 'symlink':
      return t('files.openWindows.symlink')
    case 'busy':
      return t('files.downloadError.busy')
    case 'view_only':
      return t('files.downloadError.viewOnly')
    default:
      return t('files.openWindows.failed', { name })
  }
}

// Has Windows open the file (or folder) with its default program on the
// machine the server runs on, then says so: the user may be on another
// device and see nothing happen. onRootChanged: a 409 naming the pane's
// root now.
export async function openFileInWindows(
  file: OpenInWindowsTarget,
  notify: (message: string, options?: NotifyOptions) => void,
  t: Translate<MessageKey>,
  onRootChanged?: (root: string) => void,
): Promise<void> {
  const name = visibleUnsafe(fileName(file.path) || file.root)
  try {
    await openInWindows(
      { paneId: file.paneId, place: file.place },
      { root: file.root, path: file.path || '.', reveal: file.reveal },
    )
    notify(t('files.openWindows.done', { name }), { variant: 'success' })
  } catch (err) {
    if (err instanceof RequestError && err.status === 409 && err.root)
      onRootChanged?.(err.root)
    notify(openInWindowsError(err, name, t), { variant: 'danger' })
  }
}
