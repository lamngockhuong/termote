import { parseSolo } from './deep-link'

// A focus window (a link with solo=1, opened by "Open in new window") shows
// only its target and keeps nothing on the device: the tabs, the selection,
// the pane views and the drafts stay as the main window left them. Read once
// when the page loads, so a later hashchange never turns it on or off.
let focus = parseSolo(window.location.hash)

export function isFocusWindow(): boolean {
  return focus
}

// For tests: as if the page had loaded with (or without) solo=1
export function setFocusWindowForTest(on: boolean) {
  focus = on
}
