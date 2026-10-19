import { describe, expect, it } from 'vitest'
import type { Session, SessionGroup, SessionPane } from '../types/session'
import { matchesPaneQuery, matchesQuery, searchTerms } from './session-search'

describe('searchTerms', () => {
  it('splits on whitespace, lower case', () => {
    expect(searchTerms('  API  Claude ')).toEqual(['api', 'claude'])
  })

  it('drops diacritics, đ included', () => {
    expect(searchTerms('Tiếng Đức')).toEqual(['tieng', 'duc'])
  })

  it('folds I to i whatever the locale', () => {
    expect(searchTerms('INSTALL')).toEqual(['install'])
  })

  it('has no term for an empty or blank query', () => {
    expect(searchTerms('')).toEqual([])
    expect(searchTerms('   ')).toEqual([])
  })
})

describe('matchesQuery', () => {
  const session: Session = {
    id: '1',
    name: 'Backend API',
    icon: '💻',
    description: 'Tiếng Việt notes',
    agentName: 'claude',
    commands: ['vim', 'node'],
    panes: [
      { id: 'p1', label: 'logs', hasAgent: false, command: 'tail' },
      { id: 'p2', label: 'agent', hasAgent: true, agentName: 'codex' },
    ],
  }
  const group: SessionGroup = {
    id: 'g',
    name: 'Shop',
    worktree: { linked: true, branch: 'feat/cart' },
  }
  const has = (q: string, g?: SessionGroup) =>
    matchesQuery(session, searchTerms(q), g)

  it('matches everything with no term', () => {
    expect(has('')).toBe(true)
  })

  it('matches the name, any case', () => {
    expect(has('backend')).toBe(true)
    expect(has('API')).toBe(true)
  })

  it('matches the description without diacritics', () => {
    expect(has('tieng viet')).toBe(true)
  })

  it('matches the group name and branch', () => {
    expect(has('shop', group)).toBe(true)
    expect(has('cart', group)).toBe(true)
    expect(has('shop')).toBe(false)
  })

  it('matches agents, processes and pane labels', () => {
    expect(has('claude')).toBe(true)
    expect(has('vim')).toBe(true)
    expect(has('tail')).toBe(true)
    expect(has('logs')).toBe(true)
    expect(has('codex')).toBe(true)
  })

  it('needs every term to match a field', () => {
    expect(has('api vim')).toBe(true)
    expect(has('api python')).toBe(false)
  })

  it('reads a bare session', () => {
    const bare: Session = { id: '2', name: 'Shell', icon: '', description: '' }
    expect(matchesQuery(bare, ['shell'])).toBe(true)
    expect(matchesQuery(bare, ['vim'])).toBe(false)
  })
})

describe('matchesPaneQuery', () => {
  const session: Session = {
    id: '1',
    name: 'Docs',
    icon: '',
    description: 'not searched here',
  }
  const pane: SessionPane = {
    id: 'p',
    label: 'writer',
    hasAgent: true,
    agentName: 'claude',
    command: 'node',
  }
  const has = (q: string, groupName?: string) =>
    matchesPaneQuery(session, pane, searchTerms(q), groupName)

  it('matches the tab, group, pane label, agent and process', () => {
    expect(has('docs')).toBe(true)
    expect(has('site', 'Site')).toBe(true)
    expect(has('writer')).toBe(true)
    expect(has('claude')).toBe(true)
    expect(has('node')).toBe(true)
  })

  it('does not match the description', () => {
    expect(has('searched')).toBe(false)
  })
})
