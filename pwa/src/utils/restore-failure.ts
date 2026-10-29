import { RequestError } from '../hooks/use-mux-api'
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
  path?: string,
): RestoreFailure {
  const e = err instanceof RequestError ? err : undefined
  if (e?.status === 409 && e.root)
    return {
      message: `The pane's directory changed; ${name} was not restored`,
      variant: 'warning',
      root: e.root,
    }
  switch (e?.code) {
    case 'exists': {
      const at = path === undefined ? name : visibleUnsafe(e.path ?? path)
      return {
        message: `A file now exists at ${at}; not restored`,
        variant: 'warning',
      }
    }
    case 'changed':
      return {
        message: `${name} changed since; not restored`,
        variant: 'warning',
      }
    case 'not_in_trash':
      return {
        message: `${name} was already restored or removed`,
        variant: 'info',
        gone: true,
      }
    case 'cross_device':
      return {
        message: `${name} is on another file system than the trash; not restored`,
        variant: 'warning',
      }
    case 'not_allowed':
      return {
        message: `${name} can't be restored to that folder`,
        variant: 'warning',
      }
    case 'sensitive':
      return {
        message: `${name} may contain secrets; not restored`,
        variant: 'warning',
      }
    case 'busy':
      return {
        message: 'Too many writes at once. Try again',
        variant: 'warning',
      }
  }
  return { message: `Could not restore ${name}`, variant: 'danger' }
}
