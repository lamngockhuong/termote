import { describe, expect, it } from 'vitest'
import {
  applyPick,
  BUILTIN_COMMANDS,
  CLAUDE_BUILTIN_COMMANDS,
  CODEX_BUILTIN_COMMANDS,
  COMMAND_ALIASES,
  type CommandQuery,
  CUSTOM_TRIGGER,
  closeTrailingSkill,
  commandOf,
  commandQuery,
  filterSlashCommands,
  mergeSlashCommands,
  type SlashCommand,
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

  it('lists /exit first among the Codex built-ins, /logout confirmed too', () => {
    expect(BUILTIN_COMMANDS.codex).toBe(CODEX_BUILTIN_COMMANDS)
    expect(CODEX_BUILTIN_COMMANDS[0]).toMatchObject({
      name: 'exit',
      confirm: true,
      source: 'builtin',
    })
    const rest = CODEX_BUILTIN_COMMANDS.slice(1).map((c) => c.name)
    expect(rest).toEqual([...rest].sort())
    expect(new Set(rest).size).toBe(rest.length)
    const find = (name: string) =>
      CODEX_BUILTIN_COMMANDS.find((c) => c.name === name)
    expect(find('logout')?.confirm).toBe(true)
    for (const name of ['model', 'new', 'resume', 'status', 'diff', 'btw']) {
      expect(find(name)?.terminal).toBe(true)
    }
    for (const name of ['review', 'goal', 'compact', 'init', 'cd']) {
      expect(find(name)?.terminal).toBeUndefined()
      expect(find(name)?.confirm).toBeUndefined()
    }
    // Aliases, and commands Termote leaves out
    for (const name of ['quit', 'cwd', 'clean', 'pet', 'mention', 'rollout']) {
      expect(find(name)).toBeUndefined()
    }
  })

  it('types custom commands after "/" for Claude Code, "$" for Codex', () => {
    expect(CUSTOM_TRIGGER).toEqual({ claude: '/', codex: '$' })
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

  it('keeps a "$" skill named like a "/" built-in', () => {
    const merged = mergeSlashCommands(
      [cmd('review', '', 'builtin')],
      [
        { ...cmd('review'), trigger: '$' },
        { ...cmd('review'), trigger: '$' },
      ],
    )
    expect(merged.map((c) => `${c.trigger ?? '/'}${c.name}`)).toEqual([
      '/review',
      '$review',
    ])
  })

  it('reads "/" only while the message is a bare command name', () => {
    const slash = (text: string) => commandQuery(text, text.length, true)
    expect(slash('/')).toEqual({ trigger: '/', query: '', start: 0, end: 1 })
    expect(slash('/rev')?.query).toBe('rev')
    expect(slash('/a:b')?.query).toBe('a:b')
    // The caret does not matter for "/"
    expect(commandQuery('/rev', 1, false)).toEqual({
      trigger: '/',
      query: 'rev',
      start: 0,
      end: 4,
    })
    expect(commandQuery('/rev', null, false)?.query).toBe('rev')
    expect(slash('/review ')).toBeNull()
    expect(slash('/review\n')).toBeNull()
    expect(slash(' /review')).toBeNull()
    expect(slash('hello')).toBeNull()
    expect(slash('')).toBeNull()
  })

  it('reads the "$" word the caret ends, anywhere in the message', () => {
    expect(commandQuery('$', 1, true)).toEqual({
      trigger: '$',
      query: '',
      start: 0,
      end: 1,
    })
    expect(commandQuery('use $sk', 7, true)).toEqual({
      trigger: '$',
      query: 'sk',
      start: 4,
      end: 7,
    })
    // The caret inside the word: the whole word is replaced
    expect(commandQuery('use $skill now', 7, true)).toEqual({
      trigger: '$',
      query: 'sk',
      start: 4,
      end: 10,
    })
    expect(commandQuery('a\n$x:y', 6, true)?.query).toBe('x:y')
    // Not the start of a word, a second "$", after a space, no caret
    expect(commandQuery('a$b', 3, true)).toBeNull()
    expect(commandQuery('$$', 2, true)).toBeNull()
    expect(commandQuery('$a$', 3, true)).toBeNull()
    expect(commandQuery('$skill ', 7, true)).toBeNull()
    expect(commandQuery('$skill', null, true)).toBeNull()
    expect(commandQuery('$skill', 6, false)).toBeNull()
    expect(commandQuery('hello', 5, true)).toBeNull()
  })

  it('puts a pick in place of the word typed, a space and the caret after it', () => {
    const skill: SlashCommand = {
      name: 'skill-a',
      source: 'user',
      trigger: '$',
    }
    const at = (text: string, caret: number) =>
      applyPick(text, commandQuery(text, caret, true) as CommandQuery, skill)
    expect(at('$sk', 3)).toEqual({ text: '$skill-a ', caret: 9 })
    expect(at('xem $sk', 7)).toEqual({ text: 'xem $skill-a ', caret: 13 })
    // A space after the word is kept, not doubled
    expect(at('xem $sk ngay', 7)).toEqual({
      text: 'xem $skill-a ngay',
      caret: 13,
    })
    // Never past a line break
    expect(at('$skxx\nmore', 3)).toEqual({ text: '$skill-a\nmore', caret: 8 })
    expect(
      applyPick(
        '/rev',
        commandQuery('/rev', 4, false) as CommandQuery,
        cmd('review', '', 'builtin'),
      ),
    ).toEqual({ text: '/review ', caret: 8 })
  })

  it('adds a space after a "$name" that ends the message', () => {
    expect(closeTrailingSkill('$deploy')).toBe('$deploy ')
    expect(closeTrailingSkill('use $ak:debug')).toBe('use $ak:debug ')
    expect(closeTrailingSkill('use\n$deploy')).toBe('use\n$deploy ')
    for (const text of [
      '$deploy ',
      'use $deploy now',
      'a$b',
      '$',
      '$$',
      'cost 5$',
      '',
    ]) {
      expect(closeTrailingSkill(text)).toBe(text)
    }
  })

  it('finds the "/" command a message runs, aliases per agent', () => {
    const list = CLAUDE_BUILTIN_COMMANDS
    const claude = COMMAND_ALIASES.claude
    expect(commandOf('/exit', list)?.name).toBe('exit')
    expect(commandOf('  /quit', list, claude)?.name).toBe('exit')
    expect(commandOf('/quit', list)).toBeUndefined()
    expect(commandOf('/model sonnet', list)?.name).toBe('model')
    expect(commandOf('/nope', list)).toBeUndefined()
    expect(commandOf('exit', list)).toBeUndefined()
    // An inherited property is no alias
    expect(commandOf('/constructor', list, claude)).toBeUndefined()

    const codex = COMMAND_ALIASES.codex
    const of = (text: string) =>
      commandOf(text, CODEX_BUILTIN_COMMANDS, codex)?.name
    expect(of('/quit')).toBe('exit')
    expect(of('/cwd')).toBe('pwd')
    expect(of('/clean')).toBe('stop')
    expect(of('/pet')).toBe('pets')
    // Claude Code's aliases are not Codex's, and the other way round
    expect(commandOf('/cwd', CODEX_BUILTIN_COMMANDS, claude)).toBeUndefined()
    expect(commandOf('/clean', list, codex)).toBeUndefined()
    // A "$" skill is never run as a "/" command
    expect(
      commandOf('/exit', [{ ...cmd('exit'), trigger: '$', confirm: true }]),
    ).toBeUndefined()
  })
})
