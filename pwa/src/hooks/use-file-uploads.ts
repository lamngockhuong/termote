import { useSyncExternalStore } from 'react'
import type { NotifyOptions } from '../app-views'
import { tFor } from '../i18n/i18n-context'
import type { MessageKey } from '../i18n/messages/en'
import type { Translate } from '../i18n/translate'
import { visibleUnsafe } from '../utils/unsafe-chars'
import {
  checkUpload,
  type FileUploadReason,
  fileUploadErrorMessage,
  type UploadAt,
  type UploadResult,
  uploadFile,
} from '../utils/upload-file'
import { filesRootMoved, filesUploaded } from './use-files'
import { type FilesTarget, fetchFilesTree, signInUrl } from './use-mux-api'

// Another device's upload holds the server's one slot: tried again this
// often, a little longer than the server takes to drop a stalled one (2 min)
export const UPLOAD_BUSY_RETRY_MS = 3000
export const UPLOAD_BUSY_WAIT_MS = 150_000

// What the status row under the Files header shows
export interface UploadStatus {
  name: string
  // 1-based, of total
  index: number
  total: number
  percent: number
  // Another upload holds the server's slot
  waiting: boolean
  // False once every byte went: the file is saved whatever Cancel does
  canCancel: boolean
}

// The ask before writing where secrets may be: the file, its folder and
// the root it is under (the view shown may be another pane's by then)
export interface UploadAsk {
  name: string
  dir: string
  root: string
}

export interface UploadsState {
  status?: UploadStatus
  asking?: UploadAsk
}

type Notify = (message: string, options?: NotifyOptions) => void

// Where files go: dir ("." for the root) under root, read through target
export interface UploadTo {
  target: FilesTarget
  root: string
  dir: string
}

// A file saved: the view showing that root focuses its row
export interface UploadedFile {
  paneId: string
  place?: string
  root: string
  path: string
}

// The files of one start: the sensitive ask is answered once for them all
interface Batch {
  reveal: boolean
  declined: boolean
  announce: boolean
}

interface Job extends UploadTo {
  file: File
  batch: Batch
}

// The outcome of one file: skipped when the user said no to the ask
type Outcome = UploadResult | { ok: false; reason: 'skipped' }

// What one run did, told once at its end: a toast replaces the one before,
// so one per file would hide all but the last
interface Tally {
  // Files taken from the queue so far
  done: number
  // Files of the run, set at its end
  total: number
  saved: { name: string; path: string; announce: boolean }[]
  failed: { name: string; reason: FileUploadReason }[]
  folders: number
  canceled: boolean
  // The sign-in page opens: nothing to tell
  silent: boolean
}

// The queue lives here, not in a view: switching views (Terminal on a phone)
// never stops an upload, and each file keeps the pane, place and root it was
// started for, whatever the view shows later.
let state: UploadsState = {}
const listeners = new Set<() => void>()
let queue: Job[] = []
let running = false
let abort: AbortController | undefined
let answer: ((yes: boolean) => void) | undefined
// The latest view's toasts: the App's, which outlive any view (set by
// every start, before its run)
let notify!: Notify
// The words of the run's notices: the app's language when it was queued
let translate: Translate<MessageKey> = tFor('en')
// Folders a drop held, told with the run's result
let foldersSkipped = 0
// Files queued since the run began: its total, those a Cancel or a moved
// root dropped included
let queued = 0
const uploadedListeners = new Set<(f: UploadedFile) => void>()
// Bumped by a reset: a run from before it ends without a word
let generation = 0

function set(patch: Partial<UploadsState>) {
  state = { ...state, ...patch }
  for (const fn of listeners) fn()
}

function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1)
const dirOf = (path: string) =>
  path.slice(0, Math.max(0, path.lastIndexOf('/')))

// Resolves true after ms, false at once when signal aborts
function wait(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const stop = () => {
      clearTimeout(t)
      resolve(false)
    }
    const t = setTimeout(() => {
      signal.removeEventListener('abort', stop)
      resolve(true)
    }, ms)
    signal.addEventListener('abort', stop, { once: true })
  })
}

const ask = (job: Job) =>
  new Promise<boolean>((resolve) => {
    answer = resolve
    set({ asking: { name: job.file.name, dir: job.dir, root: job.root } })
  })

// The user's answer to the ask (no open ask: nothing happens)
export function confirmUpload(yes: boolean) {
  const a = answer
  answer = undefined
  set({ asking: undefined })
  a?.(yes)
}

// Whether a file of this name and size is at path now: an answer lost after
// every byte went
async function landed(job: Job, path: string): Promise<boolean> {
  try {
    const tree = await fetchFilesTree(job.target, dirOf(path), job.root)
    return tree.entries.some(
      (e) => e.name === baseName(path) && e.size === job.file.size,
    )
  } catch {
    return false
  }
}

// One file to the end: the check, the ask, the bytes, the wait for a busy
// slot, and what a lost answer means
async function one(
  job: Job,
  show: (patch: Partial<UploadStatus>) => void,
  signal: AbortSignal,
): Promise<Outcome> {
  let busySince: number | undefined
  // Another upload held the slot last time: wait, then try again, unless
  // past UPLOAD_BUSY_WAIT_MS or canceled
  let busy = false
  for (;;) {
    if (busy) {
      busySince ??= Date.now()
      if (Date.now() - busySince >= UPLOAD_BUSY_WAIT_MS)
        return { ok: false, reason: 'upload_busy' }
      show({ waiting: true, percent: 0 })
      if (!(await wait(UPLOAD_BUSY_RETRY_MS, signal)))
        return { ok: false, reason: 'aborted' }
      show({ waiting: false })
      busy = false
    }
    const at: UploadAt = {
      root: job.root,
      dir: job.dir,
      name: job.file.name,
      reveal: job.batch.reveal,
    }
    const check = await checkUpload(job.target, at, job.file, signal)
    if (signal.aborted) return { ok: false, reason: 'aborted' }
    if (!check.ok && check.reason === 'upload_busy') {
      busy = true
      continue
    }
    if (!check.ok && check.reason === 'sensitive') {
      if (job.batch.declined) return { ok: false, reason: 'skipped' }
      const yes = await ask(job)
      if (!yes) {
        job.batch.declined = true
        return { ok: false, reason: signal.aborted ? 'aborted' : 'skipped' }
      }
      job.batch.reveal = true
      continue
    }
    if (!check.ok) return check
    let sent = false
    const res = await uploadFile(job.target, at, job.file, {
      signal,
      onProgress: (part) => show({ percent: Math.round(part * 100) }),
      onSent: () => {
        sent = true
        show({ percent: 100, canCancel: false })
      },
    })
    if (res.ok) return res
    if (res.reason === 'upload_busy') {
      busy = true
      continue
    }
    // Every byte went and the answer was lost: saved if the name the check
    // gave holds a file of this size now
    if (sent && (res.reason === 'network' || res.reason === 'aborted'))
      return (await landed(job, check.path))
        ? { ok: true, path: check.path }
        : { ok: false, reason: 'unsure' }
    // Lost on the way: a refusal written before a large body was read
    // reaches the browser as a reset connection, so the check says why
    if (res.reason === 'network') {
      const again = await checkUpload(job.target, at, job.file, signal)
      if (!again.ok && again.reason === 'upload_busy') {
        busy = true
        continue
      }
      return again.ok ? res : again
    }
    return res
  }
}

// What a run is told at its end: a refusal before any success, the folder
// when the tree was hidden (a file open), a new name when it changed
function summary(
  tally: Tally,
  t: Translate<MessageKey>,
): {
  text: string
  variant?: NotifyOptions['variant']
} {
  const folders = tally.folders ? ` ${t('files.upload.folders')}.` : ''
  const ok = tally.saved.length
  if (tally.canceled) {
    return {
      text: `${ok ? t('files.uploaded.canceledAfter', { ok, total: tally.total }) : t('files.uploaded.canceled')}.${folders}`,
    }
  }
  if (tally.failed.length) {
    const [first] = tally.failed
    const of =
      tally.total > 1
        ? `${t('files.uploaded.of', { ok, total: tally.total })} `
        : ''
    const more =
      tally.failed.length > 1
        ? ` ${t('files.uploaded.more', { count: tally.failed.length - 1 })}`
        : ''
    return {
      text: `${of}${visibleUnsafe(first.name)}: ${fileUploadErrorMessage(first.reason, t)}${more}${folders}`,
      variant: 'danger',
    }
  }
  // Every file skipped at the ask: only the folders, if any, to tell
  if (ok === 0) return { text: folders.trim(), variant: 'warning' }
  const [s] = tally.saved
  const dir = dirOf(s.path)
  if (ok > 1)
    return {
      text: `${
        !s.announce
          ? t('files.uploaded.many', { count: ok })
          : dir
            ? t('files.uploaded.manyTo', { count: ok, dir: visibleUnsafe(dir) })
            : t('files.uploaded.manyToTop', { count: ok })
      }.${folders}`,
      variant: 'success',
    }
  const text = s.announce
    ? t('files.uploaded.savedTo', { path: visibleUnsafe(s.path) })
    : baseName(s.path) !== s.name
      ? t('files.uploaded.savedAs', { name: visibleUnsafe(baseName(s.path)) })
      : t('files.uploaded.one', { name: visibleUnsafe(s.name) })
  return { text: folders ? `${text}.${folders}` : text, variant: 'success' }
}

async function run() {
  const gen = generation
  running = true
  try {
    await runQueue(gen)
  } catch (err) {
    // A bug past this point must not leave the queue stuck as running
    console.error('uploads:', err)
  } finally {
    // A run from before a reset leaves the new state alone
    if (gen === generation) {
      abort = undefined
      running = false
      set({ status: undefined })
    }
  }
  // Files added after a Cancel are a run of their own
  if (gen === generation && queue.length > 0) void run()
}

async function runQueue(gen: number) {
  const ctrl = new AbortController()
  abort = ctrl
  const tally: Tally = {
    done: 0,
    total: 0,
    saved: [],
    failed: [],
    folders: 0,
    canceled: false,
    silent: false,
  }
  // Every job left, refused for reason: told with the run's result
  const refuseRest = (reason: FileUploadReason, which = (_: Job) => true) => {
    for (const j of queue.filter(which))
      tally.failed.push({ name: j.file.name, reason })
    queue = queue.filter((j) => !which(j))
  }
  while (queue.length > 0 && !tally.canceled && !tally.silent) {
    const job = queue.shift() as Job
    tally.done++
    tally.folders += foldersSkipped
    foldersSkipped = 0
    let current: UploadStatus = {
      name: job.file.name,
      index: tally.done,
      total: tally.done + queue.length,
      percent: 0,
      waiting: false,
      canCancel: true,
    }
    const show = (patch: Partial<UploadStatus>) => {
      current = { ...current, ...patch }
      set({ status: current })
    }
    show({})
    const res = await one(job, show, ctrl.signal)
    if (gen !== generation) return
    if (res.ok) {
      tally.saved.push({
        name: job.file.name,
        path: res.path,
        announce: job.batch.announce,
      })
      const { paneId, place } = job.target
      await filesUploaded(paneId, place, job.root, res.path)
      const done = { paneId, place, root: job.root, path: res.path }
      for (const fn of uploadedListeners) fn(done)
      continue
    }
    switch (res.reason) {
      case 'skipped':
        break
      case 'aborted':
        tally.canceled = true
        break
      case 'unauthorized':
        queue = []
        tally.silent = true
        window.location.assign(signInUrl())
        break
      case 'root_changed':
        // The rest of that root would go to a folder the user no longer sees
        tally.failed.push({ name: job.file.name, reason: res.reason })
        refuseRest(res.reason, (j) => j.root === job.root)
        filesRootMoved(job.target.paneId, job.target.place, res.root as string)
        break
      case 'upload_busy':
        // Waited long enough: the next files would wait as long again
        tally.failed.push({ name: job.file.name, reason: res.reason })
        refuseRest(res.reason)
        break
      default:
        tally.failed.push({ name: job.file.name, reason: res.reason })
    }
  }
  // Files queued after a Cancel are the next run's
  tally.total = queued - queue.length
  queued = queue.length
  const { text, variant } = summary(tally, translate)
  if (!tally.silent && text) notify(text, variant && { variant })
}

// Queues files for to; folders: those a drop held, told with the result.
// announce: the tree is hidden (a file is open), so the result names the
// folder.
export function startUploads(
  files: File[],
  to: UploadTo,
  opts: {
    notify: Notify
    t: Translate<MessageKey>
    announce?: boolean
    folders?: number
  },
) {
  notify = opts.notify
  translate = opts.t
  if (files.length === 0) return
  foldersSkipped += opts.folders ?? 0
  const batch: Batch = {
    reveal: false,
    declined: false,
    announce: !!opts.announce,
  }
  queue.push(...files.map((file) => ({ ...to, file, batch })))
  queued += files.length
  if (!running) void run()
}

// Stops the file being sent (until every byte went) and drops those queued
// so far; files added afterwards still go
export function cancelUploads() {
  queue = []
  abort?.abort()
  // Cancel while the ask is open: the file is not sent
  if (answer) confirmUpload(false)
}

export function onFileUploaded(fn: (f: UploadedFile) => void): () => void {
  uploadedListeners.add(fn)
  return () => {
    uploadedListeners.delete(fn)
  }
}

export function useFileUploads(): UploadsState {
  return useSyncExternalStore(subscribe, () => state)
}

// Tests only: nothing running, nothing queued
export function resetFileUploads() {
  generation++
  queue = []
  abort?.abort()
  answer?.(false)
  answer = undefined
  running = false
  foldersSkipped = 0
  queued = 0
  state = {}
  uploadedListeners.clear()
}
