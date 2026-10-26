import { useSyncExternalStore } from 'react'
import { onSignedOutElsewhere, onSignedOutHere } from '../utils/files-persist'
import {
  createTemplate,
  deleteTemplate,
  fetchTemplates,
  importTemplates,
  type PromptTemplate,
  previewTemplateImport,
  type TemplateImportPreview,
  updateTemplate,
} from './use-mux-api'

// The server's prompt templates, one copy for the whole app (the picker,
// the / list, the palette, Settings). It belongs to one server: another
// instance on the same origin (native, then a container), templates turned
// off, or a sign-out drops it. Each place that shows them reads them again
// as it opens, so a template made on another device shows up there.

export interface TemplatesState {
  templates: PromptTemplate[]
  // A newer Termote saved them: nothing can change them here
  readOnly: boolean
  // Read once since the server was last set
  loaded: boolean
  loading: boolean
  // The last read failed
  error: boolean
}

const initial: TemplatesState = {
  templates: [],
  readOnly: false,
  loaded: false,
  loading: false,
  error: false,
}

let state = initial
// The server the templates are from, and whether it has them
let server: string | null = null
let enabled = false
// Bumped whenever the copy is dropped: a read or write begun before never
// lands
let generation = 0
// The latest read: only its answer lands, so a read begun before a write
// never brings back what the write changed
let readSeq = 0
let reading: Promise<void> | null = null
const listeners = new Set<() => void>()

function set(next: Partial<TemplatesState>) {
  state = { ...state, ...next }
  for (const fn of listeners) fn()
}

function drop() {
  generation++
  reading = null
  set(initial)
}

// By name, as the server orders them: lowercased, then as written
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const byName = (list: PromptTemplate[]) =>
  [...list].sort(
    (a, b) =>
      compare(a.name.toLowerCase(), b.name.toLowerCase()) ||
      compare(a.name, b.name),
  )

// The server a snapshot came from (its instanceId) and whether it has
// templates (caps.templates): another one drops what was read.
export function setTemplatesServer(instanceId: string | null, on: boolean) {
  if (instanceId === server && on === enabled) return
  server = instanceId
  enabled = on
  drop()
}

// Reads the templates. A second call shares the read under way, unless
// fresh: after a write, whose result that read may not have.
export function refreshTemplates(fresh = false): Promise<void> {
  if (!enabled) return Promise.resolve()
  if (reading && !fresh) return reading
  const gen = generation
  const id = ++readSeq
  const latest = () => gen === generation && id === readSeq
  set({ loading: true })
  const read = fetchTemplates()
    .then(
      (list) => {
        if (latest())
          set({ ...list, loaded: true, loading: false, error: false })
      },
      () => {
        if (latest()) set({ loading: false, error: true })
      },
    )
    .finally(() => {
      if (reading === read) reading = null
    })
  reading = read
  return read
}

// Puts a saved template in the copy (replacing its old self), then reads
// them all again for what other devices changed. Nothing when the copy was
// dropped while it was saved (another server, a sign-out).
function saved(gen: number, t: PromptTemplate) {
  if (gen !== generation) return
  set({
    templates: byName([...state.templates.filter((x) => x.id !== t.id), t]),
  })
  void refreshTemplates(true)
}

// The writes throw RequestError for their callers to explain
export async function createPromptTemplate(t: {
  name: string
  text: string
}): Promise<PromptTemplate> {
  const gen = generation
  const made = await createTemplate(t)
  saved(gen, made)
  return made
}

export async function updatePromptTemplate(
  id: string,
  t: { name: string; text: string; updated: string },
): Promise<PromptTemplate> {
  const gen = generation
  const next = await updateTemplate(id, t)
  saved(gen, next)
  return next
}

export async function removePromptTemplate(t: PromptTemplate): Promise<void> {
  const gen = generation
  await deleteTemplate(t.id, t.updated)
  if (gen !== generation) return
  set({ templates: state.templates.filter((x) => x.id !== t.id) })
  void refreshTemplates(true)
}

export function previewPromptTemplateImport(
  list: { name: string; text: string }[],
): Promise<TemplateImportPreview> {
  return previewTemplateImport(list)
}

export async function importPromptTemplates(
  list: { name: string; text: string }[],
  replace: string[],
): Promise<{ added: number; replaced: number }> {
  const done = await importTemplates(list, replace)
  void refreshTemplates(true)
  return done
}

// The template with id, as last read
export const templateById = (id: string) =>
  state.templates.find((t) => t.id === id) ?? null

const subscribe = (fn: () => void) => {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

// One function for every render, so an effect that lists it runs once
const refresh = () => refreshTemplates()

export function usePromptTemplates() {
  const s = useSyncExternalStore(subscribe, () => state)
  return {
    ...s,
    refresh,
    create: createPromptTemplate,
    update: updatePromptTemplate,
    remove: removePromptTemplate,
    previewImport: previewPromptTemplateImport,
    importAll: importPromptTemplates,
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

// For tests: as if the app had just loaded (and listening for sign-out
// again, which resetFilesPersist drops).
export function resetPromptTemplates() {
  forget()
  onSignedOutHere(forget)
  onSignedOutElsewhere(forget)
}
