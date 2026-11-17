// "Open in new window" (desktop): a link of this app with solo=1 opens in a
// window of its own. An installed app opens a new app window, a browser a
// new tab; popup (Shift+Click) asks the browser for a sized window instead.
// The new window keeps its opener: it is this app's own page, which "Open in
// main window" hands the target back to.

import { machineURL } from './api-base'

export const POPUP_FEATURES = 'popup,width=1100,height=800'

// What a window opens on, from where the pointer was: Shift asks for a popup
export interface OpenWindowEvent {
  shiftKey: boolean
}

// Opens hash (#/s/…?solo=1 or #/overview?solo=1) in a new window: false when
// the browser blocked it.
export function openInWindow(hash: string, popup = false): boolean {
  const { origin, pathname, search } = window.location
  const url = `${origin}${pathname}${search}${hash}`
  return !!window.open(url, '_blank', popup ? POPUP_FEATURES : undefined)
}

// Opens the app on machine id ('' for this server) in a new window, so the
// machine open here stays on screen: false when the browser blocked it.
export function openMachineInWindow(id: string, popup = false): boolean {
  const url = `${window.location.origin}${machineURL(id)}`
  return !!window.open(url, '_blank', popup ? POPUP_FEATURES : undefined)
}
