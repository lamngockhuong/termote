// The machine the app works on: this server (none), or one it reaches over
// SSH, named by its id in the page's ?machine= (GET /api/mux/machines). Every
// pane, files and stream request goes to that machine's /api/mux, which
// this server forwards: /api/machines/<id>/mux. Switching machine loads the
// page again, so every hook reads from the new one from the start.
//
// What belongs to this server stays local whatever machine is open: its
// health and version, signing out, Web Push, devices and sign-ins, and the
// machines list itself (LOCAL_API).

export const LOCAL_API = '/api/mux'

// A machine id as the server gives it: 16 hex digits
const MACHINE_ID = /^[0-9a-f]{16}$/

export function isMachineId(id: unknown): id is string {
  return typeof id === 'string' && MACHINE_ID.test(id)
}

// The machine in a location's search, or '' for this server.
export function machineFromSearch(search: string): string {
  const id = new URLSearchParams(search).get('machine')
  return isMachineId(id) ? id : ''
}

let current = machineFromSearch(window.location.search)

// The machine open in this page, '' for this server.
export function currentMachine(): string {
  return current
}

// The base of the open machine's /api/mux.
export function apiBase(): string {
  return current ? `/api/machines/${current}/mux` : LOCAL_API
}

// Tests set the machine without loading a page.
export function setCurrentMachineForTest(id: string) {
  current = isMachineId(id) ? id : ''
}

// The page's URL on machine id ('' for this server), keeping hash.
export function machineURL(id: string, hash = ''): string {
  return `/${isMachineId(id) ? `?machine=${id}` : ''}${hash}`
}

// Loads the app on machine id ('' for this server), at hash when given.
export function switchMachine(id: string, hash = '') {
  if ((isMachineId(id) ? id : '') === current && !hash) return
  window.location.assign(machineURL(id, hash))
}
