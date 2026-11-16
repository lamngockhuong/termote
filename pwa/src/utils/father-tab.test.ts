import { describe, expect, it } from 'vitest'
import type { Session } from '../types/session'
import {
  fatherTabMoveIndex,
  fatherTabNewName,
  fatherTabsOf,
  joinFatherTab,
  pickFatherTabSession,
  splitFatherTab,
} from './father-tab'

const tab = (id: string, name: string, extra: Partial<Session> = {}) =>
  ({ id, name, icon: '', description: '', ...extra }) as Session

describe('splitFatherTab', () => {
  it('splits at the first slash', () => {
    expect(splitFatherTab('review/PR 1')).toEqual({
      father: 'review',
      label: 'PR 1',
    })
    expect(splitFatherTab('review/feat/x')).toEqual({
      father: 'review',
      label: 'feat/x',
    })
  })

  it('trims both parts', () => {
    expect(splitFatherTab('review / PR 1')).toEqual({
      father: 'review',
      label: 'PR 1',
    })
  })

  it('leaves a name without a slash alone', () => {
    expect(splitFatherTab('Shell')).toEqual({ label: 'Shell' })
  })

  it('leaves a name with an empty part alone', () => {
    expect(splitFatherTab('/tmp')).toEqual({ label: '/tmp' })
    expect(splitFatherTab('logs/')).toEqual({ label: 'logs/' })
    expect(splitFatherTab(' / ')).toEqual({ label: ' / ' })
  })

  it('leaves a path alone', () => {
    expect(splitFatherTab('~/notes')).toEqual({ label: '~/notes' })
    expect(splitFatherTab('./run')).toEqual({ label: './run' })
    expect(splitFatherTab('../up')).toEqual({ label: '../up' })
  })
})

describe('joinFatherTab', () => {
  it('puts the FatherTab before the name', () => {
    expect(joinFatherTab('review', 'PR 1')).toBe('review/PR 1')
  })

  it('keeps the name without one', () => {
    expect(joinFatherTab(undefined, 'PR 1')).toBe('PR 1')
  })
})

describe('fatherTabsOf', () => {
  it('is empty when no tab is in a FatherTab', () => {
    expect(fatherTabsOf([])).toEqual([])
    expect(fatherTabsOf([tab('1', 'Shell'), tab('2', 'Code')])).toEqual([])
  })

  it('gathers tabs where the first of each is', () => {
    const tabs = [
      tab('1', 'review/PR 1'),
      tab('2', 'Shell'),
      tab('3', 'coding/api'),
      tab('4', 'review/PR 2'),
    ]
    const fathers = fatherTabsOf(tabs)
    expect(fathers.map((f) => f.name)).toEqual(['review', undefined, 'coding'])
    expect(fathers.map((f) => f.sessions.map((s) => s.id))).toEqual([
      ['1', '4'],
      ['2'],
      ['3'],
    ])
  })

  it('has no entry for tabs outside when every tab is in one', () => {
    expect(fatherTabsOf([tab('1', 'review/PR 1')]).map((f) => f.name)).toEqual([
      'review',
    ])
  })

  it('shows the heaviest agent status of its tabs', () => {
    const fathers = fatherTabsOf([
      tab('1', 'review/PR 1', { agentStatus: 'working' }),
      tab('2', 'review/PR 2', { agentStatus: 'blocked' }),
      tab('3', 'coding/api'),
    ])
    expect(fathers.map((f) => f.agentStatus)).toEqual(['blocked', undefined])
  })
})

describe('pickFatherTabSession', () => {
  const [father] = fatherTabsOf([
    tab('1', 'review/PR 1'),
    tab('2', 'review/PR 2'),
  ])

  it('opens the tab last shown in it', () => {
    expect(pickFatherTabSession(father, '2')).toBe('2')
  })

  it('opens its first tab otherwise', () => {
    expect(pickFatherTabSession(father)).toBe('1')
    expect(pickFatherTabSession(father, 'gone')).toBe('1')
  })
})

describe('fatherTabMoveIndex', () => {
  it('is the place of the tab now there, among all tabs', () => {
    const all = [
      tab('1', 'review/PR 1'),
      tab('2', 'Shell'),
      tab('3', 'review/PR 2'),
      tab('4', 'review/PR 3'),
    ]
    const shown = [all[0], all[2], all[3]]
    expect(fatherTabMoveIndex(all, shown, 0)).toBe(0)
    expect(fatherTabMoveIndex(all, shown, 1)).toBe(2)
    expect(fatherTabMoveIndex(all, shown, 2)).toBe(3)
  })
})

describe('fatherTabNewName', () => {
  it('puts a new tab in the FatherTab of the tab on screen', () => {
    expect(fatherTabNewName('review/PR 1', 'PR 2')).toBe('review/PR 2')
  })

  it('keeps the name when the tab on screen is in none', () => {
    expect(fatherTabNewName('Shell', 'PR 2')).toBe('PR 2')
  })

  it('keeps a name that says its own FatherTab', () => {
    expect(fatherTabNewName('review/PR 1', 'coding/api')).toBe('coding/api')
  })
})
