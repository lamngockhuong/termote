import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { type APIRequestContext, expect } from '@playwright/test'

// What the OpenCode specs share: the server's tmux, and a pane running the
// stand-in TUI (tests/fixtures/fake-opencode-tui.sh) under an executable
// named opencode, on a session given with --session, as termote reads it.
export const socket = process.env.TMUX_SOCKET
export const tmuxSession = process.env.TMUX_SESSION || 'main'
// The XDG_STATE_HOME of the server under test, where it looks for the
// service's service.json
export const stateDir = process.env.TERMOTE_E2E_STATE
export const skipReason =
  'needs TMUX_SOCKET and TERMOTE_E2E_STATE of the server under test (Linux, tmux)'
export const unsupported =
  !socket ||
  !stateDir ||
  process.platform !== 'linux' ||
  process.env.TERMOTE_E2E_ZELLIJ === '1'

const tui = path.resolve(import.meta.dirname, '../../tests/fixtures/fake-opencode-tui.sh')

export const tmux = (...args: string[]) =>
  execFileSync('tmux', ['-S', socket as string, ...args], { encoding: 'utf-8' })

// The executable named opencode (a copy of bash) under dir/bin, and a shim
// dir/shims/opencode that runs the stand-in through it, for a shell's PATH
export function installOpencode(dir: string): { exe: string; shims: string } {
  const bin = path.join(dir, 'bin')
  mkdirSync(bin, { recursive: true })
  const exe = path.join(bin, 'opencode')
  const bash = execFileSync('bash', ['-c', 'command -v bash'], { encoding: 'utf-8' }).trim()
  copyFileSync(bash, exe)
  chmodSync(exe, 0o755)
  const shims = path.join(dir, 'shims')
  mkdirSync(shims, { recursive: true })
  writeFileSync(
    path.join(shims, 'opencode'),
    `#!/bin/sh\nexec ${JSON.stringify(exe)} ${JSON.stringify(tui)} "$@"\n`,
  )
  chmodSync(path.join(shims, 'opencode'), 0o755)
  return { exe, shims }
}

// A window of the server's tmux running the stand-in on session id, in cwd
export function openPane(exe: string, name: string, cwd: string, id: string): string {
  return tmux(
    'new-window', '-d', '-P', '-F', '#{window_id}', '-t', `${tmuxSession}:`,
    '-n', name, '-c', cwd, exe, tui, '--session', id,
  ).trim()
}

export function killWindows(ids: string[]) {
  for (const id of ids) {
    try {
      tmux('kill-window', '-t', id)
    } catch {
      // Already gone
    }
  }
}

interface SnapshotPane {
  agent?: { name?: string; status?: string }
}
interface Snapshot {
  groups: { tabs: { name: string; panes: SnapshotPane[] }[] }[]
}

// Waits until the server reports the agent of window name: a service it
// checked before (a spec earlier, with another pid) is kept for 30 s
export async function waitForAgent(api: APIRequestContext, name: string, status: string) {
  await expect
    .poll(
      async () => {
        const s = (await (await api.get('/api/mux/snapshot')).json()) as Snapshot
        const tab = s.groups.flatMap((g) => g.tabs).find((t) => t.name === name)
        return tab?.panes[0]?.agent?.status
      },
      { timeout: 45_000 },
    )
    .toBe(status)
}
