import type { TranscriptEntry } from '../hooks/use-mux-api'
import {
  ACME_COMMANDS,
  REPLY_DECLINED,
  REPLY_PROMPT,
  REPLY_TEXT,
  REPLY_TOOL,
  WEB_ACTIVITY,
} from './fixtures/agent'
import { fail, type Handler, json, noContent, unsupported } from './http'
import {
  type DemoState,
  findPane,
  iso,
  newId,
  type PaneRef,
  setAgentStatus,
} from './state'

// Claude Code's routes (/panes/{id}/agent/*). A message plays a short turn,
// moved on by time whenever a request comes in: the agent works, asks to
// run the tests (a permission dialog), works again and answers. After that
// first turn it answers with a note on what the demo is.

export const THINK_MS = 4000
export const ANSWER_MS = 2500

// The demo's own note, after the scripted turn
export const DEMO_NOTE =
  'This is the Termote demo: nothing runs here. With Termote on your own machine, this message goes to Claude Code there.'

function append(state: DemoState, paneId: string, entry: TranscriptEntry) {
  state.transcripts
    .get(paneId)
    ?.push({ ...entry, id: newId(state, 'e'), ts: iso(state) })
}

function text(t: string): TranscriptEntry {
  return { id: '', role: 'assistant', parts: [{ kind: 'text', text: t }] }
}

// Moves every pane's turn on to where the clock says it is
export function advanceTurns(state: DemoState) {
  for (const [paneId, turn] of state.turns) {
    const ref = findPane(state, paneId)
    if (!ref) {
      state.turns.delete(paneId)
      continue
    }
    if (turn.stage !== 'working' || state.now() < turn.until) continue
    if (turn.next === 'ask') {
      turn.stage = 'asking'
      turn.promptId = newId(state, 'prompt')
      setAgentStatus(state, ref, 'blocked')
      continue
    }
    if (turn.next === 'reply') append(state, paneId, REPLY_TEXT)
    else if (turn.next === 'declined')
      append(state, paneId, text(REPLY_DECLINED))
    else append(state, paneId, text(DEMO_NOTE))
    state.turns.delete(paneId)
    state.answered.add(paneId)
    setAgentStatus(state, ref, 'done')
  }
}

// The newest assistant text of the pane's conversation, flattened
export function lastAssistantText(
  state: DemoState,
  paneId: string,
): { text: string; ts?: string } | undefined {
  const entries = state.transcripts.get(paneId) ?? []
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    const part = [...e.parts].reverse().find((p) => p.kind === 'text')
    if (e.role === 'assistant' && part?.text)
      return { text: part.text.replace(/\s+/g, ' '), ts: e.ts }
  }
  return undefined
}

// The pane, when it runs an agent with a conversation
function agentPane(state: DemoState, paneId: string): PaneRef | null {
  const ref = findPane(state, paneId)
  return ref?.pane.agent && state.transcripts.has(paneId) ? ref : null
}

const noSession = () => fail(404, 'no_session', 'no agent session in this pane')

const SESSION = 'demo-session'

// The cursor is how many entries the client holds
const transcript: Handler = ({ state, params, query }) => {
  const ref = agentPane(state, params.id)
  if (!ref) return noSession()
  const entries = state.transcripts.get(params.id) ?? []
  const cursor = query.get('cursor')
  const held = cursor?.startsWith('c') ? Number(cursor.slice(1)) : Number.NaN
  const reset = !(held >= 0 && held <= entries.length)
  return json({
    agent: ref.pane.agent?.name,
    sessionId: SESSION,
    status: ref.pane.agent?.status,
    entries: reset ? entries : entries.slice(held),
    cursor: `c${entries.length}`,
    reset,
  })
}

const message: Handler = ({ state, params, body }) => {
  const ref = agentPane(state, params.id)
  if (!ref) return noSession()
  const said = String(body?.text ?? '')
  if (!said.trim()) return fail(400, 'invalid_text', 'empty message')
  const turn = state.turns.get(params.id)
  if (turn?.stage === 'asking')
    return fail(409, 'input_not_ready', 'the agent is asking something')
  const entry: TranscriptEntry = {
    id: '',
    role: 'user',
    parts: [{ kind: 'text', text: said }],
  }
  append(state, params.id, entry)
  // Working already (the web agent, a turn running): queued for later
  if (turn || ref.pane.agent?.status === 'working')
    return new Response(null, { status: 202 })
  const first = params.id === 'w1:p1' && !state.answered.has(params.id)
  state.turns.set(params.id, {
    stage: 'working',
    next: first ? 'ask' : 'note',
    startedAt: state.now(),
    until: state.now() + (first ? THINK_MS : ANSWER_MS),
  })
  setAgentStatus(state, ref, 'working')
  return noContent()
}

const prompt: Handler = ({ state, params }) => {
  const ref = agentPane(state, params.id)
  if (!ref) return noSession()
  const turn = state.turns.get(params.id)
  if (turn?.stage === 'asking')
    return json({
      prompt: { ...REPLY_PROMPT, promptId: turn.promptId },
      activity: null,
    })
  if (turn)
    return json({
      prompt: null,
      activity: {
        // i18n-ignore: the working line's word, read off the agent's screen
        label: 'Incubating',
        elapsed: Math.floor((state.now() - turn.startedAt) / 1000),
        phase: 'thinking',
        detail: 'thinking',
      },
    })
  const working = ref.pane.agent?.status === 'working'
  return json({ prompt: null, activity: working ? WEB_ACTIVITY : null })
}

const answer: Handler = ({ state, params, body }) => {
  const ref = agentPane(state, params.id)
  if (!ref) return noSession()
  const turn = state.turns.get(params.id)
  if (turn?.stage !== 'asking' || body?.promptId !== turn.promptId)
    return fail(409, 'prompt_expired', 'the dialog is gone')
  const choice = body?.choice
  const yes = choice === 1 || choice === 2
  if (!yes && choice !== 3 && choice !== 'cancel')
    return fail(400, 'invalid_choice', 'invalid choice')
  if (yes) append(state, params.id, REPLY_TOOL)
  Object.assign(turn, {
    stage: 'working',
    next: yes ? 'reply' : 'declined',
    startedAt: state.now(),
    until: state.now() + ANSWER_MS,
    promptId: undefined,
  })
  setAgentStatus(state, ref, 'working')
  return noContent()
}

const commands: Handler = ({ state, params }) => {
  if (!agentPane(state, params.id)) return noSession()
  return json({ commands: params.id === 'w1:p1' ? ACME_COMMANDS : [] })
}

export const AGENT_ROUTES: Record<string, Handler> = {
  'GET /panes/{id}/agent/transcript': transcript,
  'POST /panes/{id}/agent/message': message,
  'GET /panes/{id}/agent/prompt': prompt,
  'POST /panes/{id}/agent/answer': answer,
  'GET /panes/{id}/agent/commands': commands,
  'GET /panes/{id}/agent/start': () =>
    fail(404, 'no_start', 'no start in this pane'),
  'POST /panes/{id}/agent/start': unsupported,
}
