import { describe, expect, it } from 'vitest'
import { tFor } from '../i18n/i18n-context'
import {
  MAX_USER_TASK_COMMAND,
  MAX_USER_TASK_NAME,
  MAX_USER_TASKS,
  userTaskErrorText,
  userTaskProblem,
} from './user-tasks'

const tEn = tFor('en')

describe('userTaskProblem', () => {
  it('accepts a name and a one-line command', () => {
    expect(userTaskProblem('Build', 'make build', tEn)).toBeNull()
    expect(userTaskProblem('  Build  ', '  make build \t', tEn)).toBeNull()
  })

  it('asks for a name, trimmed as the server trims it', () => {
    expect(userTaskProblem('', 'x', tEn)).toEqual({
      field: 'name',
      message: 'Name the task',
    })
    expect(userTaskProblem(' 　 ', 'x', tEn)?.message).toBe('Name the task')
  })

  it('limits the name in characters, not bytes', () => {
    expect(
      userTaskProblem('😀'.repeat(MAX_USER_TASK_NAME), 'x', tEn),
    ).toBeNull()
    expect(
      userTaskProblem('a'.repeat(MAX_USER_TASK_NAME + 1), 'x', tEn),
    ).toEqual({
      field: 'name',
      message: `The name is longer than ${MAX_USER_TASK_NAME} characters`,
    })
  })

  it('refuses hidden characters in the name, tab included, naming the first', () => {
    expect(userTaskProblem('a‮b​', 'x', tEn)).toEqual({
      field: 'name',
      message: 'The name contains hidden characters (U+202E)',
    })
    expect(userTaskProblem('a\tb', 'x', tEn)?.message).toBe(
      'The name contains hidden characters (U+0009)',
    )
  })

  it('asks for a command', () => {
    expect(userTaskProblem('a', '  ', tEn)).toEqual({
      field: 'command',
      message: 'Enter the command',
    })
  })

  it('keeps the command to one line', () => {
    expect(userTaskProblem('a', 'ls\nrm x', tEn)).toEqual({
      field: 'command',
      message: 'The command must be one line',
    })
    expect(userTaskProblem('a', 'ls\rrm x', tEn)?.message).toBe(
      'The command must be one line',
    )
  })

  it('limits the command in bytes', () => {
    expect(
      userTaskProblem('a', 'x'.repeat(MAX_USER_TASK_COMMAND), tEn),
    ).toBeNull()
    expect(
      userTaskProblem('a', 'x'.repeat(MAX_USER_TASK_COMMAND + 1), tEn),
    ).toEqual({
      field: 'command',
      message: `The command is larger than ${MAX_USER_TASK_COMMAND} bytes`,
    })
    // 2049 two-byte characters: few characters, too many bytes
    expect(
      userTaskProblem('a', 'é'.repeat(MAX_USER_TASK_COMMAND / 2 + 1), tEn)
        ?.field,
    ).toBe('command')
  })

  it('refuses hidden characters in the command', () => {
    expect(userTaskProblem('a', 'ls‮ -l', tEn)).toEqual({
      field: 'command',
      message: 'The command contains hidden characters (U+202E)',
    })
    // A tab inside a command is not allowed either
    expect(userTaskProblem('a', 'ls\t-l', tEn)?.message).toBe(
      'The command contains hidden characters (U+0009)',
    )
  })

  it('reports the name before the command', () => {
    expect(userTaskProblem('', '', tEn)?.field).toBe('name')
  })
})

describe('userTaskErrorText', () => {
  it.each([
    ['name_taken', undefined, 'A task with this name exists'],
    ['too_many', undefined, `Up to ${MAX_USER_TASKS} tasks`],
    ['invalid_task', 'name is empty', 'Not saved: name is empty'],
    // A refusal without its reason never shows "undefined"
    ['invalid_task', undefined, 'Not saved: '],
    ['conflict', undefined, 'Changed on another device'],
    ['not_found', undefined, 'Deleted on another device'],
    [
      'newer_format',
      undefined,
      'Saved by a newer Termote; update it to change tasks',
    ],
    ['view_only', undefined, 'This device is view only'],
    ['tasks_unavailable', undefined, 'Tasks are not available on this server'],
    ['busy', undefined, 'The tasks are being changed elsewhere; try again'],
    ['too_large', undefined, 'Too large to save'],
    ['something_else', undefined, 'Could not save the tasks'],
  ])('%s', (code, message, text) => {
    expect(userTaskErrorText({ code, message }, tEn)).toBe(text)
  })

  it('falls back for what is not a coded error', () => {
    expect(userTaskErrorText(null, tEn)).toBe('Could not save the tasks')
    expect(userTaskErrorText(undefined, tEn)).toBe('Could not save the tasks')
    expect(userTaskErrorText(new Error('x'), tEn)).toBe(
      'Could not save the tasks',
    )
  })
})
