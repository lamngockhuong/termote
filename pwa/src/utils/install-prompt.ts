import { isIos, isStandalone } from './notify-permission'
import type { InstallOffer } from './welcome'

// Chromium's install prompt: fired once the page qualifies, held until a
// click asks for it
interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

let deferred: InstallPromptEvent | null = null
const listeners = new Set<() => void>()

function changed() {
  for (const fn of listeners) fn()
}

// Called once before the first render: the event may fire before any
// component listens
export function registerInstallPrompt(win: Window = window) {
  win.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault()
    deferred = e as InstallPromptEvent
    changed()
  })
  win.addEventListener('appinstalled', () => {
    deferred = null
    changed()
  })
}

export function onInstallOfferChange(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

// How this browser can add the app now: none once it runs installed
export function installOffer(): InstallOffer {
  if (isStandalone()) return null
  if (deferred) return 'prompt'
  return isIos() ? 'ios' : null
}

// Shows the browser's install prompt; resolves to whether it was accepted.
// The event serves once.
export async function promptInstall(): Promise<boolean> {
  const e = deferred
  if (!e) return false
  deferred = null
  changed()
  await e.prompt()
  return (await e.userChoice).outcome === 'accepted'
}

export function resetInstallPromptForTest() {
  deferred = null
  listeners.clear()
}
