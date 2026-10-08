import { describe, expect, it } from 'vitest'
import { buildSessions, type MuxInfo } from '../hooks/use-local-sessions'
import type { MuxPane, MuxSnapshot } from '../hooks/use-mux-api'
import { canStartAgent, paneCommand } from './agent-start'

const caps = (agentStart?: boolean): MuxSnapshot['caps'] => ({
  clientSideSelect: true,
  copyMode: false,
  agentChat: true,
  agentStart,
})

// The tab of a snapshot with these panes, the first one active, as the PWA
// builds it.
function tabOf(panes: MuxPane[], agentStart = true) {
  const snap: MuxSnapshot = {
    apiVersion: 2,
    backend: 'herdr',
    caps: caps(agentStart),
    groups: [
      {
        id: 'w1',
        name: 'work',
        tabs: [{ id: 'w1:t1', name: 'tab', active: true, panes }],
      },
    ],
  }
  const mux: MuxInfo = { backend: snap.backend, caps: snap.caps }
  return { mux, session: buildSessions(snap, {}).sessions[0] }
}

const shellPane = (name: string): MuxPane => ({
  id: 'w1:p1',
  active: true,
  process: { name },
})

describe('canStartAgent', () => {
  it('offers a start on a pane that shows only its shell', () => {
    for (const shell of ['bash', 'zsh', 'pwsh.exe']) {
      const { mux, session } = tabOf([shellPane(shell)])
      expect(paneCommand(session)).toBe(shell)
      expect(canStartAgent(mux, session), shell).toBe(true)
    }
  })

  it('is hidden without caps.agentStart', () => {
    const { session } = tabOf([shellPane('bash')])
    expect(canStartAgent(tabOf([], false).mux, session)).toBe(false)
    expect(
      canStartAgent(
        { backend: 'herdr', caps: { clientSideSelect: true, copyMode: false } },
        session,
      ),
    ).toBe(false)
  })

  it('is hidden on a pane that runs an agent or something else', () => {
    const agent = tabOf([
      { ...shellPane('bash'), agent: { name: 'claude', status: 'idle' } },
    ])
    expect(canStartAgent(agent.mux, agent.session)).toBe(false)
    const vim = tabOf([shellPane('vim')])
    expect(canStartAgent(vim.mux, vim.session)).toBe(false)
    const unknown = tabOf([{ id: 'w1:p1', active: true }])
    expect(canStartAgent(unknown.mux, unknown.session)).toBe(false)
  })

  it('reads the pane the tab streams, not another one', () => {
    const { mux, session } = tabOf([
      { id: 'w1:p1', active: true, process: { name: 'vim' } },
      { id: 'w1:p2', active: false, process: { name: 'bash' } },
    ])
    expect(canStartAgent(mux, session)).toBe(false)
    expect(
      canStartAgent(mux, {
        ...session,
        paneId: 'w1:p2',
      }),
    ).toBe(true)
  })
})
