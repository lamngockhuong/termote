import { RequestError } from '../hooks/use-mux-api'
import type { MessageKey } from '../i18n/messages/en'
import type { Translate } from '../i18n/translate'
import { visibleUnsafe } from './unsafe-chars'

// Why a restoreFile failed, as one toast: what Files' Undo, Changes' Undo and
// the Trash sheet all tell the user.
export interface RestoreFailure {
  message: string
  variant: 'info' | 'warning' | 'danger'
  // The pane's root moved: the caller follows it (rootChanged)
  root?: string
  // Nothing in the trash under that id any more (restored or removed
  // elsewhere): the caller drops it from what it shows
  gone?: boolean
}

// name: the entry's name as shown (visibleUnsafe already). path: shown when a
// file now exists there and the server did not say where; without it the
// name is.
export function restoreFailure(
  err: unknown,
  name: string,
  path: string | undefined,
  t: Translate<MessageKey>,
): RestoreFailure {
  const e = err instanceof RequestError ? err : undefined
  if (e?.status === 409 && e.root)
    return {
      message: t('files.restore.rootChanged', { name }),
      variant: 'warning',
      root: e.root,
    }
  switch (e?.code) {
    case 'exists': {
      const at = path === undefined ? name : visibleUnsafe(e.path ?? path)
      return {
        message: t('files.restore.exists', { path: at }),
        variant: 'warning',
      }
    }
    case 'changed':
      return {
        message: t('files.restore.changed', { name }),
        variant: 'warning',
      }
    case 'not_in_trash':
      return {
        message: t('files.restore.gone', { name }),
        variant: 'info',
        gone: true,
      }
    case 'cross_device':
      return {
        message: t('files.restore.crossDevice', { name }),
        variant: 'warning',
      }
    case 'not_allowed':
      return {
        message: t('files.restore.notAllowed', { name }),
        variant: 'warning',
      }
    case 'sensitive':
      return {
        message: t('files.restore.sensitive', { name }),
        variant: 'warning',
      }
    case 'busy':
      return {
        message: t('files.refused.busy'),
        variant: 'warning',
      }
  }
  return { message: t('files.restore.failed', { name }), variant: 'danger' }
}
