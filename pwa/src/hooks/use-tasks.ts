import { useCallback, useEffect, useRef, useState } from 'react'
import {
  fetchTaskRun,
  fetchTasks,
  type PaneTasks,
  RequestError,
  runTask,
  type TaskKind,
  type TaskRun,
  type TaskRunStart,
  type TaskRunState,
} from './use-mux-api'

// A run's state polled this often while the Tasks view is open and the
// page shown (the server checks a run at most every 2 s, whoever asks)
export const TASK_POLL_MS = 2000

// unknown: the server forgot the run (it restarted)
export type TaskRunView = Omit<TaskRun, 'state'> & {
  state: TaskRunState | 'unknown'
}

// One task as the view lists it
export interface TaskItem {
  // kind:name, user:id: the key of its runs
  key: string
  kind: TaskKind
  name: string
  // A user task's id
  id?: string
  // What runs: the script's or the user task's command, the make line
  command: string
  // What the user knows it as ("pnpm run test", "make build", a name)
  label: string
  hooks?: string[]
  truncated?: boolean
}

// A group of other tool's tasks: id is its tool
export interface ToolItems {
  id: string
  title: string
  items: TaskItem[]
}

// The kinds that are no tool's
const BASE_KINDS = new Set(['script', 'make', 'user'])

// The tab a run opens: task:<name>, or task:<tool>:<name> for a tool's task
// (two tools may both have a test)
export const taskTabName = (item: TaskItem) =>
  BASE_KINDS.has(item.kind)
    ? `task:${item.name}`
    : `task:${item.kind}:${item.name}`

// The tasks of a listing, in groups: scripts, make targets, each other
// tool's, the user's
export function taskItems(t: PaneTasks): {
  scripts: TaskItem[]
  make: TaskItem[]
  tools: ToolItems[]
  user: TaskItem[]
} {
  return {
    scripts: t.scripts.map((s) => ({
      key: `script:${s.name}`,
      kind: 'script',
      name: s.name,
      command: s.command,
      label: `${t.packageManager} run ${s.name}`,
      hooks: s.hooks,
      truncated: s.truncated,
    })),
    make: t.makeTargets.map((m) => ({
      key: `make:${m.name}`,
      kind: 'make',
      name: m.name,
      command: `make ${m.name}`,
      label: `make ${m.name}`,
    })),
    tools: t.toolGroups.map((g) => ({
      id: g.tool,
      title: `${g.label} (${g.file})`,
      items: g.tasks.map((task) => ({
        key: `${g.tool}:${task.name}`,
        kind: g.tool,
        name: task.name,
        command: task.detail ?? task.command,
        label: task.command,
        hooks: task.hooks,
        truncated: task.truncated,
      })),
    })),
    user: t.userTasks.map((u) => ({
      key: `user:${u.id}`,
      kind: 'user',
      name: u.name,
      id: u.id,
      command: u.command,
      label: u.name,
    })),
  }
}

const finished = (s: TaskRunView['state']) => s !== 'running'

// The pane's tasks, its runs and Run. A root the server reports changed is
// read again. Runs still running are polled while the page is shown; the
// list's runs (every device sees the same) seed them.
export function useTasks(paneId: string | undefined) {
  const [data, setData] = useState<PaneTasks | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [loading, setLoading] = useState(false)
  const [runs, setRuns] = useState<Record<string, TaskRunView>>({})
  const rootRef = useRef<string | undefined>(undefined)
  const seq = useRef(0)
  const paneRef = useRef(paneId)
  paneRef.current = paneId

  const load = useCallback(async () => {
    if (!paneId) return
    const id = ++seq.current
    setLoading(true)
    try {
      let next: PaneTasks
      try {
        next = await fetchTasks(paneId, rootRef.current)
      } catch (err) {
        if (!(err instanceof RequestError && err.status === 409)) throw err
        // Another root: read it whole
        next = await fetchTasks(paneId)
      }
      if (id !== seq.current) return
      rootRef.current = next.root
      setData(next)
      setError(null)
      // A run this page saw end stays ended; one it started that the list
      // does not know yet (read before the run), or one the server forgot
      // (unknown), stays too
      setRuns((old) => {
        const out: Record<string, TaskRunView> = {}
        for (const [k, r] of Object.entries(next.runs)) {
          const mine = old[k]
          out[k] = mine?.runId === r.runId && finished(mine.state) ? mine : r
        }
        for (const [k, r] of Object.entries(old))
          if (!out[k] && (r.state === 'unknown' || r.state === 'running'))
            out[k] = r
        return out
      })
    } catch (err) {
      if (id === seq.current) setError(err)
    } finally {
      if (id === seq.current) setLoading(false)
    }
  }, [paneId])

  // Another pane: nothing of the last one stays
  useEffect(() => {
    seq.current++
    rootRef.current = undefined
    setData(null)
    setError(null)
    setRuns({})
    void load()
  }, [load])

  const run = useCallback(
    async (item: TaskItem, newTab = false): Promise<TaskRunStart> => {
      if (!paneId || !data) throw new Error('no tasks read')
      try {
        const pane = paneRef.current
        const start = await runTask(paneId, {
          kind: item.kind,
          ...(item.kind === 'user' ? { id: item.id } : { name: item.name }),
          root: data.root,
          newTab,
        })
        // Not into another pane's runs, when the user moved on meanwhile
        if (paneRef.current === pane)
          setRuns((old) => ({
            ...old,
            [item.key]: { ...start, state: 'running' },
          }))
        return start
      } catch (err) {
        // The pane's root changed (409 with the new one): list it
        if (err instanceof RequestError && err.status === 409 && err.root)
          void load()
        throw err
      }
    },
    [paneId, data, load],
  )

  // Polls the runs still running while the page is shown
  const runsRef = useRef(runs)
  runsRef.current = runs
  const pending = Object.values(runs).some((r) => r.state === 'running')
  useEffect(() => {
    if (!pending) return
    let alive = true
    // A slow server: the next tick waits for this one
    let busy = false
    const tick = async () => {
      if (busy || document.visibilityState !== 'visible') return
      busy = true
      try {
        await poll()
      } finally {
        busy = false
      }
    }
    const poll = async () => {
      for (const [key, r] of Object.entries(runsRef.current)) {
        if (r.state !== 'running') continue
        let next: TaskRunView['state']
        let code: number | undefined
        try {
          const s = await fetchTaskRun(r.runId)
          next = s.state
          code = s.code
        } catch (err) {
          if (!(err instanceof RequestError && err.code === 'run_not_found'))
            continue
          next = 'unknown'
        }
        if (!alive || next === 'running') continue
        setRuns((old) =>
          old[key]?.runId === r.runId
            ? { ...old, [key]: { ...old[key], state: next, code } }
            : old,
        )
      }
    }
    const timer = setInterval(() => void tick(), TASK_POLL_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [pending])

  return { data, error, loading, runs, reload: load, run }
}
