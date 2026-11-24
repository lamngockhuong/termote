import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Job } from '../hooks/use-mux-api'
import { renderWithLocale } from '../i18n/test-utils'
import { setCurrentMachineForTest } from '../utils/api-base'
import {
  DEFAULT_PLAN_VIEW,
  effectiveFilter,
  filterJobs,
  JobWorkspaceFilter,
  type PlanView,
  readPlanView,
  usePlanView,
  workspaceFilters,
} from './job-workspace-filter'

const job = (id: string, over: Partial<Job> = {}): Job => ({
  id,
  title: id,
  state: 'todo',
  updated: 'u',
  live: {},
  ...over,
})

const GROUPS = [
  { id: 'w1', name: 'acme-api' },
  { id: 'w2', name: 'web' },
]
const JOBS = [
  job('a', { workspace: 'w2' }),
  job('b'),
  job('c', { workspace: 'gone' }),
  job('d', { workspace: 'w1', state: 'done' }),
  job('e', { workspace: 'w9', workspaceNow: 'w2' }),
]

describe('job workspace filter', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => {
    vi.restoreAllMocks()
    setCurrentMachineForTest('')
  })

  it('offers the workspaces that have jobs, in the groups order, then none', () => {
    expect(workspaceFilters(JOBS, GROUPS)).toEqual([
      'ws:w1',
      'ws:w2',
      'ws:gone',
      'none',
    ])
    expect(workspaceFilters([job('x', { workspace: 'w1' })], GROUPS)).toEqual([
      'ws:w1',
    ])
  })

  it('shows the jobs of one workspace, of none, or all', () => {
    const ids = (f: string) => filterJobs(JOBS, f).map((j) => j.id)
    expect(ids('all')).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(ids('ws:w2')).toEqual(['a', 'e'])
    expect(ids('none')).toEqual(['b'])
  })

  it('falls back to all for a workspace with no job any more', () => {
    expect(effectiveFilter('ws:w2', JOBS, GROUPS)).toBe('ws:w2')
    expect(effectiveFilter('ws:w7', JOBS, GROUPS)).toBe('all')
    expect(effectiveFilter('none', [job('x', { workspace: 'w1' })], [])).toBe(
      'all',
    )
  })

  it('reads the default without a stored view, or with one it cannot read', () => {
    expect(readPlanView()).toEqual(DEFAULT_PLAN_VIEW)
    localStorage.setItem('termote-plan-view:', '{nope')
    expect(readPlanView()).toEqual(DEFAULT_PLAN_VIEW)
    localStorage.setItem('termote-plan-view:', '"text"')
    expect(readPlanView()).toEqual(DEFAULT_PLAN_VIEW)
    localStorage.setItem(
      'termote-plan-view:',
      JSON.stringify({ filter: 'w1', grouped: 'yes' }),
    )
    expect(readPlanView()).toEqual(DEFAULT_PLAN_VIEW)
    localStorage.setItem(
      'termote-plan-view:',
      JSON.stringify({ filter: 'none', grouped: true }),
    )
    expect(readPlanView()).toEqual({ filter: 'none', grouped: true })
  })

  it('remembers the view per machine', () => {
    const { result } = renderHook(() => usePlanView())
    act(() => result.current[1]({ filter: 'ws:w1', grouped: true }))
    expect(result.current[0]).toEqual({ filter: 'ws:w1', grouped: true })
    expect(readPlanView()).toEqual({ filter: 'ws:w1', grouped: true })
    setCurrentMachineForTest('0123456789abcdef')
    expect(readPlanView()).toEqual(DEFAULT_PLAN_VIEW)
    expect(
      localStorage.getItem('termote-plan-view:0123456789abcdef'),
    ).toBeNull()
  })

  it('keeps working without storage', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied')
    })
    const { result } = renderHook(() => usePlanView())
    expect(result.current[0]).toEqual(DEFAULT_PLAN_VIEW)
    act(() => result.current[1]({ filter: 'none', grouped: false }))
    expect(result.current[0]).toEqual({ filter: 'none', grouped: false })
  })

  it('changes the workspace shown and the grouping', () => {
    const onChange = vi.fn()
    const view: PlanView = { filter: 'ws:w1', grouped: false }
    render(
      <JobWorkspaceFilter
        jobs={JOBS}
        groups={GROUPS}
        view={view}
        onChange={onChange}
      />,
    )
    const select = screen.getByRole('combobox', { name: 'Workspace shown' })
    expect(select).toHaveValue('ws:w1')
    expect(
      Array.from(select.querySelectorAll('option')).map((o) => o.textContent),
    ).toEqual(['All workspaces', 'acme-api', 'web', 'gone', 'No workspace'])
    fireEvent.change(select, { target: { value: 'none' } })
    expect(onChange).toHaveBeenCalledWith({ filter: 'none', grouped: false })
    fireEvent.click(screen.getByRole('switch', { name: 'Group by workspace' }))
    expect(onChange).toHaveBeenLastCalledWith({
      filter: 'ws:w1',
      grouped: true,
    })
  })

  it('shows all for a workspace no job is in, and speaks Vietnamese', () => {
    renderWithLocale(
      <JobWorkspaceFilter
        jobs={JOBS}
        groups={GROUPS}
        view={{ filter: 'ws:w7', grouped: false }}
        onChange={vi.fn()}
      />,
      'vi',
    )
    expect(
      screen.getByRole('combobox', { name: 'Workspace đang xem' }),
    ).toHaveValue('all')
    expect(
      screen.getByRole('option', { name: 'Mọi workspace' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('option', { name: 'Không thuộc workspace nào' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('switch', { name: 'Nhóm theo workspace' }),
    ).toBeInTheDocument()
  })
})
