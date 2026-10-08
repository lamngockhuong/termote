import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { NotifyOptions } from '../app-views'
import { agentLabel } from '../chat-agents'
import { TERMINAL_VIEW_ID } from '../view-ids'
import {
  type AgentStartState,
  agentStartState,
  RequestError,
  type StartAgentKind,
  startAgent,
} from './use-mux-api'

// Starting Claude Code or Codex in an idle pane from the Chat view, then
// following the start through the server (GET agent/start) until the agent
// is ready, asks something, or never comes up. One instance lives in App,
// so a start goes on being followed when the user moves to another pane.

// How often a start is read while it runs.
export const START_POLL_MS = 2000
// A start still not over this long after it was sent stops being followed
// (the server says timeout after 35 s; this covers a server that cannot be
// read).
export const START_GIVE_UP_MS = 60_000
// A ready agent the snapshot has not shown this long after it was ready is
// forgotten (it exited before a snapshot saw it).
export const READY_UNSEEN_MS = 30_000

// sending: the POST is on its way; starting: followed until a final state;
// ready: the agent can take a message; failed: refused, with why.
export type StartPhase = 'sending' | 'starting' | 'ready' | 'failed'

export interface StartRecord {
  kind: StartAgentKind
  phase: StartPhase
  // failed: what to tell the user
  error?: string
  // When the start was sent, or when it became ready or failed (Date.now())
  since: number
  // ready: the snapshot has shown the agent in the pane
  seen?: boolean
}

// A start in one pane, as the effects below key on it
interface Keyed {
  id: string
  kind: StartAgentKind
  since: number
}

const keyOf = (
  starts: Record<string, StartRecord>,
  keep: (r: StartRecord) => boolean,
) =>
  JSON.stringify(
    Object.entries(starts)
      .filter(([, r]) => keep(r))
      .map(([id, r]): Keyed => ({ id, kind: r.kind, since: r.since })),
  )

export interface AgentStartControl {
  // Starts made from this page, by pane id
  starts: Readonly<Record<string, StartRecord>>
  start: (paneId: string, kind: StartAgentKind) => void
}

export interface StartAgentOptions {
  // Pane on screen: only that one switches view
  activePaneId?: string
  // Panes the snapshot shows running an agent: a ready start is kept until
  // its agent has shown and gone again
  agentPanes: ReadonlySet<string>
  showView: (id: string) => void
  notify: (message: string, options?: NotifyOptions) => void
}

// What a refused start tells the user.
export function startErrorMessage(
  err: RequestError,
  kind: StartAgentKind,
): string {
  switch (err.code) {
    case 'pane_busy':
      return 'This pane is running something. Start the agent in a pane that shows only its shell.'
    case 'unsupported':
      return kind === 'codex'
        ? 'This server cannot start Codex.'
        : 'This Herdr cannot start agents. Update Herdr to 0.8.2 or later.'
    case 'not_found':
      return 'This pane is gone.'
    case 'start_pending':
      return 'Herdr still holds the last start in this pane for up to 30 seconds. Try again shortly.'
  }
  return 'Could not start the agent.'
}

// A refusal after which the start is followed anyway: another device's
// start is running, or the request failed after Herdr may have typed it.
const followAfter = (err: unknown) =>
  !(err instanceof RequestError) ||
  err.code === 'starting' ||
  err.code === 'start_unknown'

const LOST = 'Could not follow the start. Open the terminal to check.'

export function useStartAgent(opts: StartAgentOptions): AgentStartControl {
  const [starts, setStarts] = useState<Record<string, StartRecord>>({})
  const optsRef = useRef(opts)
  optsRef.current = opts
  const inFlight = useRef(new Set<string>())

  // Sets the pane's record (undefined: drops it).
  const put = useCallback((paneId: string, rec: StartRecord | undefined) => {
    setStarts((prev) => {
      const next = { ...prev }
      if (rec) next[paneId] = rec
      else delete next[paneId]
      return next
    })
  }, [])

  const start = useCallback(
    (paneId: string, kind: StartAgentKind) => {
      const since = Date.now()
      put(paneId, { kind, phase: 'sending', since })
      startAgent(paneId, kind).then(
        () => put(paneId, { kind, phase: 'starting', since }),
        (err) =>
          put(
            paneId,
            followAfter(err)
              ? { kind, phase: 'starting', since }
              : {
                  kind,
                  phase: 'failed',
                  error: startErrorMessage(err, kind),
                  since: Date.now(),
                },
          ),
      )
    },
    [put],
  )

  const onState = useCallback(
    (paneId: string, kind: StartAgentKind, state: AgentStartState) => {
      const { activePaneId, showView, notify } = optsRef.current
      const here = paneId === activePaneId
      const label = agentLabel(kind)
      switch (state) {
        case 'starting':
          return
        case 'ready':
          put(paneId, { kind, phase: 'ready', since: Date.now() })
          if (!here) notify(`${label} is ready in another pane.`)
          return
        case 'blocked':
          put(paneId, undefined)
          if (here) {
            showView(TERMINAL_VIEW_ID)
            notify(`${label} is asking something in the terminal.`)
          } else {
            notify(`${label} is asking something in another pane's terminal.`)
          }
          return
        default:
          put(paneId, undefined)
          notify(
            here
              ? `${label} did not start. Open the terminal to see why.`
              : `${label} did not start in another pane.`,
            {
              variant: 'warning',
              action: here
                ? {
                    label: 'Open terminal',
                    onClick: () => optsRef.current.showView(TERMINAL_VIEW_ID),
                  }
                : undefined,
            },
          )
      }
    },
    [put],
  )

  // Starts followed now
  const followingKey = keyOf(starts, (r) => r.phase === 'starting')

  useEffect(() => {
    const following: Keyed[] = JSON.parse(followingKey)
    if (following.length === 0) return
    // A followed start that cannot be followed any more
    const lose = ({ id, kind }: Keyed, error: string) =>
      put(id, { kind, phase: 'failed', error, since: Date.now() })
    const poll = () => {
      for (const s of following) {
        // Never followed for ever, whatever the server answers
        if (Date.now() - s.since > START_GIVE_UP_MS) {
          lose(s, LOST)
          continue
        }
        if (inFlight.current.has(s.id)) continue
        inFlight.current.add(s.id)
        agentStartState(s.id)
          .then(
            (r) => onState(s.id, r.kind, r.state),
            (err) => {
              // No start on the server (it restarted, or the POST never
              // reached it), or the server cannot be asked (it no longer
              // starts agents, a refused read): nothing to follow. A
              // network failure is retried.
              if (err instanceof RequestError) {
                lose(
                  s,
                  err.status === 404 ? 'Could not start the agent.' : LOST,
                )
              }
            },
          )
          .finally(() => inFlight.current.delete(s.id))
      }
    }
    const timer = setInterval(poll, START_POLL_MS)
    // A page shown again reads the true state at once.
    const onVisible = () => {
      if (document.visibilityState === 'visible') poll()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [followingKey, onState, put])

  // A ready start lives as long as its agent: marked seen once the snapshot
  // shows it, dropped once it has gone, or when it never showed.
  const agentKey = [...opts.agentPanes].sort().join('\n')
  useEffect(() => {
    const running = new Set(agentKey.split('\n'))
    setStarts((prev) => {
      const next = { ...prev }
      let changed = false
      for (const [id, r] of Object.entries(prev)) {
        if (r.phase !== 'ready' || running.has(id) === !!r.seen) continue
        if (running.has(id)) next[id] = { ...r, seen: true }
        else delete next[id]
        changed = true
      }
      // Unchanged: no render for every snapshot
      return changed ? next : prev
    })
  }, [agentKey])

  const unseenKey = keyOf(starts, (r) => r.phase === 'ready' && !r.seen)
  useEffect(() => {
    const unseen: Keyed[] = JSON.parse(unseenKey)
    const timers = unseen.map(({ id, since }) =>
      setTimeout(
        () => put(id, undefined),
        since + READY_UNSEEN_MS - Date.now(),
      ),
    )
    return () => timers.forEach(clearTimeout)
  }, [unseenKey, put])

  return useMemo(() => ({ starts, start }), [starts, start])
}
