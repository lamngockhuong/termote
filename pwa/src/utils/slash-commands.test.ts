import { describe, expect, it } from 'vitest'
import {
  BUILTIN_COMMANDS,
  CLAUDE_BUILTIN_COMMANDS,
  commandOf,
  filterSlashCommands,
  mergeSlashCommands,
  type SlashCommand,
  slashQuery,
} from './slash-commands'

const cmd = (
  name: string,
  description = '',
  source: SlashCommand['source'] = 'project',
): SlashCommand => ({ name, description, source })

describe('slash commands', () => {
  it('lists /exit first among the Claude Code built-ins, confirmed', () => {
    expect(BUILTIN_COMMANDS.claude).toBe(CLAUDE_BUILTIN_COMMANDS)
    expect(CLAUDE_BUILTIN_COMMANDS[0]).toMatchObject({
      name: 'exit',
      confirm: true,
      source: 'builtin',
    })
    const rest = CLAUDE_BUILTIN_COMMANDS.slice(1).map((c) => c.name)
    expect(rest).toEqual([...rest].sort())
    expect(new Set(rest).size).toBe(rest.length)
    for (const name of ['model', 'config', 'permissions', 'resume', 'mcp']) {
      expect(
        CLAUDE_BUILTIN_COMMANDS.find((c) => c.name === name)?.terminal,
      ).toBe(true)
    }
    expect(
      CLAUDE_BUILTIN_COMMANDS.find((c) => c.name === 'compact')?.terminal,
    ).toBeUndefined()
  })

  it('merges keeping the first of a name', () => {
    const merged = mergeSlashCommands(
      [cmd('help', 'built', 'builtin')],
      [cmd('deploy', 'project'), cmd('help', 'project help')],
      [cmd('deploy', 'user', 'user'), cmd('mine', '', 'user')],
    )
    expect(merged.map((c) => `${c.source}:${c.name}`)).toEqual([
      'builtin:help',
      'project:deploy',
      'user:mine',
    ])
  })

  it('filters by prefix first, then substring of name or description', () => {
    const list = [
      cmd('review', 'Review a PR'),
      cmd('security-review', 'Look for vulnerabilities'),
      cmd('rewind', 'Go back'),
      cmd('compact', 'Free up context; review later'),
      cmd('exit'),
    ]
    expect(filterSlashCommands(list, '').length).toBe(5)
    expect(filterSlashCommands(list, 'RE').map((c) => c.name)).toEqual([
      'review',
      'rewind',
      'security-review',
      'compact',
    ])
    expect(filterSlashCommands(list, 'zzz')).toEqual([])
    expect(filterSlashCommands([{ name: 'x', source: 'user' }], 'y')).toEqual(
      [],
    )
  })

  it('reads the query only while the message is a bare command name', () => {
    expect(slashQuery('/')).toBe('')
    expect(slashQuery('/rev')).toBe('rev')
    expect(slashQuery('/a:b')).toBe('a:b')
    expect(slashQuery('/review ')).toBeNull()
    expect(slashQuery('/review\n')).toBeNull()
    expect(slashQuery(' /review')).toBeNull()
    expect(slashQuery('hello')).toBeNull()
    expect(slashQuery('')).toBeNull()
  })

  it('finds the command a message runs, /quit as /exit', () => {
    const list = CLAUDE_BUILTIN_COMMANDS
    expect(commandOf('/exit', list)?.name).toBe('exit')
    expect(commandOf('  /quit', list)?.name).toBe('exit')
    expect(commandOf('/model sonnet', list)?.name).toBe('model')
    expect(commandOf('/nope', list)).toBeUndefined()
    expect(commandOf('exit', list)).toBeUndefined()
  })
})
