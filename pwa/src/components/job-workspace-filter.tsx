import { useCallback, useId, useState } from 'react'
import type { Job } from '../hooks/use-mux-api'
import { useT } from '../i18n/i18n-context'
import type { SessionGroup } from '../types/session'
import { currentMachine } from '../utils/api-base'
import { jobsByWorkspace, jobWorkspace, workspaceName } from '../utils/jobs'
import { Switch } from './ui/switch'

// Which jobs the Plan shows: every workspace's ('all'), those of none
// ('none'), or those of one ('ws:<group id>', prefixed so no group id can
// pass for the other two); grouped splits each column by workspace.
export interface PlanView {
  filter: string
  grouped: boolean
}

export const DEFAULT_PLAN_VIEW: PlanView = { filter: 'all', grouped: false }

// A convenience of this browser only, one per machine open in it
const VIEW_KEY = 'termote-plan-view'
const viewKey = () => `${VIEW_KEY}:${currentMachine()}`

export function readPlanView(): PlanView {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(viewKey()) ?? 'null')
    if (!raw || typeof raw !== 'object') return DEFAULT_PLAN_VIEW
    const { filter, grouped } = raw as Record<string, unknown>
    return {
      filter:
        filter === 'none' ||
        (typeof filter === 'string' && filter.startsWith('ws:'))
          ? filter
          : 'all',
      grouped: grouped === true,
    }
  } catch {
    return DEFAULT_PLAN_VIEW
  }
}

function writePlanView(view: PlanView) {
  try {
    localStorage.setItem(viewKey(), JSON.stringify(view))
  } catch {
    // Storage unavailable: the default next time
  }
}

// The Plan's view, remembered per browser and machine
export function usePlanView(): [PlanView, (view: PlanView) => void] {
  const [view, setView] = useState(readPlanView)
  const change = useCallback((next: PlanView) => {
    setView(next)
    writePlanView(next)
  }, [])
  return [view, change]
}

// The filters jobs offers: every workspace one of them belongs to, in the
// groups' order, then 'none' when one belongs to none
export function workspaceFilters(
  jobs: readonly Job[],
  groups: readonly SessionGroup[],
): string[] {
  return jobsByWorkspace(
    jobs,
    groups.map((g) => g.id),
  ).map((w) => (w.workspace ? `ws:${w.workspace}` : 'none'))
}

// filter as it applies to jobs: one they no longer offer (its workspace has
// no job any more) is all
export function effectiveFilter(
  filter: string,
  jobs: readonly Job[],
  groups: readonly SessionGroup[],
): string {
  return workspaceFilters(jobs, groups).includes(filter) ? filter : 'all'
}

// The jobs filter shows
export function filterJobs(jobs: readonly Job[], filter: string): Job[] {
  if (filter === 'all') return [...jobs]
  const ws = filter === 'none' ? '' : filter.slice(3)
  return jobs.filter((j) => jobWorkspace(j) === ws)
}

interface Props {
  // Every job, finished ones too: the workspaces offered are theirs
  jobs: readonly Job[]
  groups: readonly SessionGroup[]
  view: PlanView
  onChange: (view: PlanView) => void
}

// Above the Plan's columns: the workspace whose jobs are shown, and whether
// the columns are split by workspace. Only how this browser shows the
// plan: a view-only device has it too.
export function JobWorkspaceFilter({ jobs, groups, view, onChange }: Props) {
  const { t } = useT()
  const ids = useId()
  const filters = workspaceFilters(jobs, groups)
  const filter = filters.includes(view.filter) ? view.filter : 'all'
  const label = (f: string) =>
    f === 'none' ? t('jobs.filter.none') : workspaceName(f.slice(3), groups)

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <label htmlFor={`${ids}-ws`} className="sr-only">
        {t('jobs.filter.label')}
      </label>
      <select
        id={`${ids}-ws`}
        value={filter}
        onChange={(e) => onChange({ ...view, filter: e.target.value })}
        className="h-8 max-w-60 min-w-0 rounded-control border border-border bg-bg px-2 text-[13px] text-fg outline-none focus:border-accent pointer-coarse:h-touch"
      >
        <option value="all">{t('jobs.filter.all')}</option>
        {filters.map((f) => (
          <option key={f} value={f}>
            {label(f)}
          </option>
        ))}
      </select>
      <span className="flex items-center gap-2">
        <Switch
          checked={view.grouped}
          onChange={(grouped) => onChange({ ...view, grouped })}
          labelledBy={`${ids}-group`}
        />
        <span id={`${ids}-group`} className="text-[13px] text-fg-muted">
          {t('jobs.filter.group')}
        </span>
      </span>
    </div>
  )
}
