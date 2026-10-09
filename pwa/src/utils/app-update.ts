import { useSyncExternalStore } from 'react'
import {
  fetchHealth,
  type InstallKind,
  MUX_API_VERSION,
} from '../hooks/use-mux-api'
import { APP_INFO } from './app-info'

// Server apiVersion this tab already reloaded for, so a server that really
// runs another version does not cause a reload loop.
export const API_RELOAD_KEY = 'termote-api-reload'

// Server version this tab already reloaded for: a build whose page keeps
// another version (one made by hand) offers the reload once, not forever.
export const VERSION_RELOAD_KEY = 'termote-version-reload'

// Shortest gap between two health reads made because the app was shown again
export const SHOW_CHECK_GAP_MS = 30_000

// Longest wait for each step of a new service worker: installed, then in
// control of the page.
export const SW_ACTIVATE_TIMEOUT_MS = 5000

export interface ServerInfo {
  version: string
  install: InstallKind
}

export interface AppUpdateState {
  // What the server reported at its last health read
  server: ServerInfo | null
  // The server runs another version than this page, or a new service worker
  // waits: a reload brings the new page.
  stale: boolean
  // reloadToNewVersion is waiting for the new worker (up to two timeouts)
  reloading: boolean
}

const INITIAL: AppUpdateState = { server: null, stale: false, reloading: false }
let state = INITIAL
// The two reasons for stale: a health read can clear its own (an update
// rolled back), never the worker's.
let versionStale = false
let workerWaiting = false
let lastCheck = 0
const listeners = new Set<() => void>()

function setState(next: Partial<AppUpdateState>) {
  state = { ...state, ...next }
  for (const l of listeners) l()
}

function setStale() {
  if (state.stale !== (versionStale || workerWaiting)) {
    setState({ stale: versionStale || workerWaiting })
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useAppUpdate(): AppUpdateState {
  return useSyncExternalStore(subscribe, () => state)
}

// Test seam: back to the state of a fresh page.
export function resetAppUpdate() {
  state = INITIAL
  versionStale = false
  workerWaiting = false
  lastCheck = 0
}

function readKey(key: string): string | null {
  try {
    return sessionStorage.getItem(key)
  } catch {
    return null
  }
}

function writeKey(key: string, value: string) {
  try {
    sessionStorage.setItem(key, value)
  } catch {
    // Storage unavailable: the server stays authoritative.
  }
}

// Resolves true on the event, false after the timeout.
function waitEvent(
  target: EventTarget,
  type: string,
  ready: () => boolean,
): Promise<boolean> {
  return new Promise((resolve) => {
    const done = () => {
      if (!ready()) return
      clearTimeout(timer)
      target.removeEventListener(type, done)
      resolve(true)
    }
    const timer = setTimeout(() => {
      target.removeEventListener(type, done)
      resolve(false)
    }, SW_ACTIVATE_TIMEOUT_MS)
    target.addEventListener(type, done)
  })
}

/**
 * Stops the service worker from answering the reload, as Clear cache does
 * (without signing out): the page then comes from the server, and registers
 * the new worker itself. Kept for a worker told to skip waiting that never
 * took control (seen on iOS), which would serve the old page again.
 */
async function dropServiceWorker(reg: ServiceWorkerRegistration) {
  await reg.unregister().catch(() => false)
  try {
    // Should the old worker still answer, it finds nothing and asks the server.
    const names = await caches.keys()
    await Promise.all(
      names
        .filter((n) => n.startsWith('workbox-precache'))
        .map((n) => caches.delete(n)),
    )
  } catch {
    // No Cache API: the unregistered worker no longer answers anyway.
  }
}

/**
 * Loads the page the server now serves: fetches the new service worker,
 * lets it take over once installed (it waits otherwise, so a reload would
 * get the cached old page) and reloads. A worker that does not take over in
 * time is dropped, so the reload still reaches the server.
 */
export async function reloadToNewVersion(
  reload: () => void = () => window.location.reload(),
): Promise<void> {
  if (state.reloading) return
  setState({ reloading: true })
  if (state.server) writeKey(VERSION_RELOAD_KEY, state.server.version)
  try {
    const sw = navigator.serviceWorker
    const reg = await sw?.getRegistration()
    if (reg) {
      // Unreachable server (it may be restarting): a worker found earlier
      // may still wait.
      await reg.update().catch(() => {})
      const worker = reg.installing ?? reg.waiting
      if (worker) {
        const controlled = waitEvent(sw, 'controllerchange', () => true)
        if (worker.state === 'installing') {
          await waitEvent(
            worker,
            'statechange',
            () => worker.state !== 'installing',
          )
        }
        // A worker that failed to install never takes over; the old one
        // keeps the app usable while the server is away.
        if (worker.state !== 'redundant') {
          // Workbox's worker skips waiting on this message.
          worker.postMessage({ type: 'SKIP_WAITING' })
          if (!(await controlled)) await dropServiceWorker(reg)
        }
      }
    }
  } catch {
    // No service worker (dev, private mode): a plain reload is enough.
  }
  reload()
  // Still here after a while: an unsaved edit's "Leave page?" was answered
  // no (reload() only starts the navigation, so not at once).
  setTimeout(() => setState({ reloading: false }), RELOAD_SETTLE_MS)
}

// How long the Reload button stays busy after the reload started
export const RELOAD_SETTLE_MS = 3000

/**
 * A lazy view's chunk failed to load (Vite's vite:preloadError): this page
 * is older than the worker now serving it (another tab let it take over), so
 * its chunks are gone. Reload into the new version; an unsaved Files edit
 * still asks first.
 */
export function onChunkLoadError() {
  markStale()
  reloadToNewVersion()
}

// A new service worker waits (registerSW's onNeedRefresh), or another tab
// let it take over (onNeedReload): this page is still the old one.
export function markStale() {
  workerWaiting = true
  setStale()
}

/**
 * Reads the server's health. Another /api/mux version reloads at once, since
 * this page cannot talk to it; another server version only marks the page
 * stale, so the user reloads when nothing unsaved is lost. Returns whether a
 * reload was started.
 */
export async function checkServerVersion(
  reload?: () => void,
): Promise<boolean> {
  lastCheck = Date.now()
  let health: Awaited<ReturnType<typeof fetchHealth>>
  try {
    health = await fetchHealth()
  } catch {
    return false
  }
  if (health.version) {
    setState({
      server: { version: health.version, install: health.install ?? 'unknown' },
    })
    versionStale =
      health.version !== APP_INFO.version &&
      readKey(VERSION_RELOAD_KEY) !== health.version
    setStale()
  }

  const api = health.apiVersion
  if (api === undefined || api === MUX_API_VERSION) return false
  if (readKey(API_RELOAD_KEY) === String(api)) return false
  writeKey(API_RELOAD_KEY, String(api))
  await reloadToNewVersion(reload)
  return true
}

// The app was shown again: read the health unless it was read just now
// (switching apps on a phone does that often).
export function checkOnShow(): void {
  if (Date.now() - lastCheck < SHOW_CHECK_GAP_MS) return
  checkServerVersion()
}
