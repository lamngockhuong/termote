import { fetchHealth, MUX_API_VERSION } from '../hooks/use-mux-api'

// Server apiVersion this tab already reloaded for, so a server that really
// runs another version does not cause a reload loop.
export const API_RELOAD_KEY = 'termote-api-reload'

// Longest wait for a new service worker to take control before reloading.
export const SW_ACTIVATE_TIMEOUT_MS = 5000

// Resolves when a new service worker controls the page, or after the timeout.
function waitForController(sw: ServiceWorkerContainer): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      sw.removeEventListener('controllerchange', done)
      resolve()
    }
    const timer = setTimeout(done, SW_ACTIVATE_TIMEOUT_MS)
    sw.addEventListener('controllerchange', done)
  })
}

/**
 * Compares the server's /api/mux version with this bundle's. On a mismatch
 * the service worker is asked for the new bundle and the page reloads once
 * it is active, once per server version. Returns whether a reload was
 * started.
 */
export async function checkApiVersion(
  reload: () => void = () => window.location.reload(),
): Promise<boolean> {
  let server: number | undefined
  try {
    server = (await fetchHealth()).apiVersion
  } catch {
    return false
  }
  if (server === undefined || server === MUX_API_VERSION) return false

  try {
    if (sessionStorage.getItem(API_RELOAD_KEY) === String(server)) return false
    sessionStorage.setItem(API_RELOAD_KEY, String(server))
  } catch {
    // Storage unavailable: still reload, the server stays authoritative.
  }
  try {
    const sw = navigator.serviceWorker
    const reg = await sw?.getRegistration()
    if (reg) {
      await reg.update()
      // update() resolves once the new worker is fetched, not active;
      // reloading before it takes over would load the cached old bundle.
      if (reg.installing || reg.waiting) await waitForController(sw)
    }
  } catch {
    // No service worker (dev, private mode): a plain reload is enough.
  }
  reload()
  return true
}
