// The overview's queue of dialogs waiting on the user. The card on top is
// pinned: a pane that becomes blocked later goes to the end, never in front
// of it, and an answer never moves on by itself (a second tap would land on
// another agent's dialog). A wait is known by its pane and since (when that
// pane became blocked). One skipped stays out while it lasts; one answered
// stays out for ANSWER_GRACE, the time the snapshot may still show the pane
// blocked: still blocked after that, it waits on a new dialog (one asked
// within the same snapshot poll keeps the old since) and comes back.

// Two snapshot polls (5 s each)
export const ANSWER_GRACE = 10_000

export interface Blocked {
  paneId: string
  // When it became blocked (RFC 3339); absent from an older server
  since?: string
}

export interface QueueState {
  // The wait on top, whether a choice of its dialog was sent from here,
  // and whether its dialog was answered (closed since)
  current: string | null
  sent: boolean
  answered: boolean
  // The waits after it, in order
  waiting: string[]
  // Waits answered here (when), and waits skipped, kept out
  answeredWaits: ReadonlyMap<string, number>
  skipped: ReadonlySet<string>
}

export const EMPTY_QUEUE: QueueState = {
  current: null,
  sent: false,
  answered: false,
  waiting: [],
  answeredWaits: new Map(),
  skipped: new Set(),
}

// One wait: a pane blocked since a time.
export const waitKey = (b: Blocked) => `${b.paneId}\n${b.since ?? ''}`

// The pane of a wait key.
export const paneOf = (key: string) => key.slice(0, key.lastIndexOf('\n'))

const startedAt = (since?: string) => {
  const t = since ? Date.parse(since) : Number.NaN
  return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY
}

const keep = (set: ReadonlySet<string>, now: Set<string>) =>
  new Set([...set].filter((k) => now.has(k)))

// The queue once the blocked panes are these, at time clock (ms).
export function updateQueue(
  state: QueueState,
  blocked: Blocked[],
  clock = Date.now(),
): QueueState {
  const now = new Set(blocked.map(waitKey))
  const recent = new Map(
    [...state.answeredWaits].filter(
      ([k, at]) => now.has(k) && clock - at < ANSWER_GRACE,
    ),
  )
  const skipped = keep(state.skipped, now)
  let { current, sent, answered } = state
  let answeredWaits = recent
  if (current !== null && !answered && !now.has(current)) {
    if (sent) {
      // It stopped waiting after a choice sent from here: answered, even
      // when the snapshot says so before the dialog's own poll
      answered = true
      answeredWaits = new Map([...recent, [current, clock]])
    } else {
      // Its agent stopped waiting before an answer came from here
      current = null
    }
  }
  const eligible = (k: string) =>
    !answeredWaits.has(k) && !skipped.has(k) && k !== current
  const waiting = state.waiting.filter((k) => now.has(k) && eligible(k))
  const newcomers = blocked
    .filter((b) => eligible(waitKey(b)) && !waiting.includes(waitKey(b)))
    .sort((a, b) => startedAt(a.since) - startedAt(b.since))
    .map(waitKey)
  waiting.push(...newcomers)
  if (current === null) {
    current = waiting.shift() ?? null
    sent = false
    answered = false
  }
  return {
    current,
    sent,
    answered,
    waiting,
    answeredWaits,
    skipped,
  }
}

// A choice of the dialog on top was sent from here (maybe only a tab), as
// soon as it is pressed: its keys may reach the pane before the reply.
export function markSent(state: QueueState): QueueState {
  return state.current === null ? state : { ...state, sent: true }
}

// The dialog on top was answered from here: it stays, marked, until Next.
export function markAnswered(
  state: QueueState,
  clock = Date.now(),
): QueueState {
  if (state.current === null) return state
  return {
    ...state,
    answered: true,
    answeredWaits: new Map([...state.answeredWaits, [state.current, clock]]),
  }
}

// Next after an answer, or Skip: the wait on top leaves for the next one.
export function advance(
  state: QueueState,
  blocked: Blocked[],
  clock = Date.now(),
): QueueState {
  const { current, answered } = state
  const skipped =
    current === null || answered
      ? state.skipped
      : new Set([...state.skipped, current])
  return updateQueue(
    { ...state, current: null, sent: false, answered: false, skipped },
    blocked,
    clock,
  )
}

// The skipped waits back at the end of the queue.
export function unskip(
  state: QueueState,
  blocked: Blocked[],
  clock = Date.now(),
): QueueState {
  return updateQueue({ ...state, skipped: new Set() }, blocked, clock)
}
