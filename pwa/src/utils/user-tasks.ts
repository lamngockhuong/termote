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
): UserTaskProblem | null {
  const n = trimName(name)
  const c = trimName(command)
  const length = [...n].length
  if (length === 0) return { field: 'name', message: 'Name the task' }
  if (length > MAX_USER_TASK_NAME)
    return {
      field: 'name',
      message: `The name is longer than ${MAX_USER_TASK_NAME} characters`,
    }
  const inName = hiddenChars(n, false)
  if (inName.length > 0)
    return {
      field: 'name',
      message: `The name contains hidden characters (${inName[0].codePoint})`,
    }
  if (c === '') return { field: 'command', message: 'Enter the command' }
  if (/[\r\n]/.test(c))
    return { field: 'command', message: 'The command must be one line' }
  if (encoder.encode(c).length > MAX_USER_TASK_COMMAND)
    return {
      field: 'command',
      message: `The command is larger than ${MAX_USER_TASK_COMMAND} bytes`,
    }
  const inCommand = hiddenChars(c, false)
  if (inCommand.length > 0)
    return {
      field: 'command',
      message: `The command contains hidden characters (${inCommand[0].codePoint})`,
    }
  return null
}

// A refused save or delete, told as the server's code means it
export function userTaskErrorText(err: unknown): string {
  const e = err as { code?: string; message?: string } | null
  switch (e?.code) {
    case 'name_taken':
      return 'A task with this name exists'
    case 'too_many':
      return `Up to ${MAX_USER_TASKS} tasks`
    case 'invalid_task':
      return `Not saved: ${e.message}`
    case 'conflict':
      return 'Changed on another device'
    case 'not_found':
      return 'Deleted on another device'
    case 'newer_format':
      return 'Saved by a newer Termote; update it to change tasks'
    case 'view_only':
      return 'This device is view only'
    case 'tasks_unavailable':
      return 'Tasks are not available on this server'
    case 'busy':
      return 'The tasks are being changed elsewhere; try again'
    case 'too_large':
      return 'Too large to save'
    default:
      return 'Could not save the tasks'
  }
}
