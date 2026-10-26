import { useSyncExternalStore } from 'react'
import { onSignedOutElsewhere, onSignedOutHere } from '../utils/files-persist'
import {
  createUserTask,
  deleteUserTask,
  fetchUserTasks,
  type UserTask,
  updateUserTask,
} from './use-mux-api'

// The server's user tasks, one copy for Settings. It belongs to one server:
// another instance on the same origin, tasks turned off, or a sign-out
// drops it (as the prompt templates). The Tasks view reads them with each
// pane's listing.

export interface UserTasksState {
  tasks: UserTask[]
  // A newer Termote saved them: nothing can change them here
  readOnly: boolean
  loaded: boolean
  loading: boolean
  error: boolean
}

const initial: UserTasksState = {
  tasks: [],
  readOnly: false,
  loaded: false,
  loading: false,
  error: false,
}

let state = initial
let server: string | null = null
let enabled = false
// Bumped whenever the copy is dropped: a read begun before never lands
let generation = 0
let readSeq = 0
const listeners = new Set<() => void>()

function set(next: Partial<UserTasksState>) {
  state = { ...state, ...next }
  for (const fn of listeners) fn()
}

function drop() {
  generation++
  set(initial)
}

// The server a snapshot came from (its instanceId) and whether it has user
// tasks (caps.userTasks): another one drops what was read.
export function setUserTasksServer(instanceId: string | null, on: boolean) {
  if (instanceId === server && on === enabled) return
  server = instanceId
  enabled = on
  drop()
}

// Reads the tasks; only the latest read lands.
export function refreshUserTasks(): Promise<void> {
  if (!enabled) return Promise.resolve()
  const gen = generation
  const id = ++readSeq
  const latest = () => gen === generation && id === readSeq
  set({ loading: true })
  return fetchUserTasks().then(
    (list) => {
      if (latest()) set({ ...list, loaded: true, loading: false, error: false })
    },
    () => {
      if (latest()) set({ loading: false, error: true })
    },
  )
}

// The writes throw RequestError for their callers to explain; each reads
// the list again after, for what other devices changed
async function afterWrite<T>(write: Promise<T>): Promise<T> {
  const gen = generation
  const done = await write
  if (gen === generation) void refreshUserTasks()
  return done
}

export const createTask = (t: { name: string; command: string }) =>
  afterWrite(createUserTask(t))

export const updateTask = (
  id: string,
  t: { name: string; command: string; updated: string },
) => afterWrite(updateUserTask(id, t))

export const removeTask = (t: UserTask) =>
  afterWrite(deleteUserTask(t.id, t.updated))

const subscribe = (fn: () => void) => {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export function useUserTasks() {
  const s = useSyncExternalStore(subscribe, () => state)
  return {
    ...s,
    refresh: refreshUserTasks,
    create: createTask,
    update: updateTask,
    remove: removeTask,
  }
}

// What one user saved is not for the next one on this browser
function forget() {
  server = null
  enabled = false
  drop()
}
onSignedOutHere(forget)
onSignedOutElsewhere(forget)

// For tests: as if the app had just loaded
export function resetUserTasks() {
  forget()
  onSignedOutHere(forget)
  onSignedOutElsewhere(forget)
}
