import type { MessageKey } from '../i18n/messages/en'
import type { Translate } from '../i18n/translate'
import { hiddenChars, trimName } from './prompt-templates'

// The server's limits (server/task_store.go)
export const MAX_USER_TASKS = 100
export const MAX_USER_TASK_NAME = 64
export const MAX_USER_TASK_COMMAND = 4096

const encoder = new TextEncoder()

export interface UserTaskProblem {
  field: 'name' | 'command'
  message: string
}

// What keeps a task from being saved, as the server checks it, or null:
// a command is one line, without hidden characters
export function userTaskProblem(
  name: string,
  command: string,
  t: Translate<MessageKey>,
): UserTaskProblem | null {
  const n = trimName(name)
  const c = trimName(command)
  const length = [...n].length
  if (length === 0)
    return { field: 'name', message: t('settings.tasks.nameIt') }
  if (length > MAX_USER_TASK_NAME)
    return {
      field: 'name',
      message: t('settings.nameTooLong', { max: MAX_USER_TASK_NAME }),
    }
  const inName = hiddenChars(n, false)
  if (inName.length > 0)
    return {
      field: 'name',
      message: t('settings.nameHidden', { code: inName[0].codePoint }),
    }
  if (c === '')
    return { field: 'command', message: t('settings.tasks.enterCommand') }
  if (/[\r\n]/.test(c))
    return { field: 'command', message: t('settings.tasks.oneLine') }
  if (encoder.encode(c).length > MAX_USER_TASK_COMMAND)
    return {
      field: 'command',
      message: t('settings.tasks.commandTooLarge', {
        max: MAX_USER_TASK_COMMAND,
      }),
    }
  const inCommand = hiddenChars(c, false)
  if (inCommand.length > 0)
    return {
      field: 'command',
      message: t('settings.tasks.commandHidden', {
        code: inCommand[0].codePoint,
      }),
    }
  return null
}

// A refused save or delete, told as the server's code means it
export function userTaskErrorText(
  err: unknown,
  t: Translate<MessageKey>,
): string {
  const e = err as { code?: string; message?: string } | null
  switch (e?.code) {
    case 'name_taken':
      return t('settings.tasks.nameTaken')
    case 'too_many':
      return t('settings.tasks.tooMany', { max: MAX_USER_TASKS })
    case 'invalid_task':
      return t('settings.notSaved', { message: e.message ?? '' })
    case 'conflict':
      return t('settings.changedElsewhere')
    case 'not_found':
      return t('settings.deletedElsewhere')
    case 'newer_format':
      return t('settings.tasks.newerFormat')
    case 'view_only':
      return t('settings.viewOnly')
    case 'tasks_unavailable':
      return t('settings.tasks.unavailable')
    case 'busy':
      return t('settings.tasks.busy')
    case 'too_large':
      return t('settings.tooLarge')
    default:
      return t('settings.tasks.saveFailed')
  }
}
