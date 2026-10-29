import type { Session } from '../types/session'

// The welcome screen's content version. Raised only when what it states
// changes (a new feature, a control moved), never for a wording fix: each
// device then sees it once more.
export const WELCOME_VERSION = 1

// An agent waiting on the user, and where
export interface WaitingAgent {
  sessionId: string
  paneId?: string
  agent: string
  tab: string
}

export type NotifyState = 'on' | 'off' | 'unsupported'
// How this browser can add the app to the home screen: its own prompt, or
// Safari's Share menu on iPhone and iPad
export type InstallOffer = 'prompt' | 'ios' | null

export interface WelcomeInput {
  sessions: Session[]
  readOnly: boolean
  notify: NotifyState
  install: InstallOffer
  desktop: boolean
  // Paired devices this server knows, when this device may pair one and
  // the list was read
  pairedDevices?: number
}

export type NextAction =
  | { kind: 'waiting'; agent: WaitingAgent }
  | { kind: 'start' }
  | { kind: 'notify' }
  | { kind: 'install'; how: 'prompt' | 'ios' }
  | { kind: 'pair' }

export interface WelcomeFacts {
  sessions: number
  panes: number
  waiting: WaitingAgent[]
  // At most two, the most useful first
  next: NextAction[]
  // The main button: the pane that needs the user, else the terminal
  primary: 'waiting' | 'terminal'
}

// Every agent waiting on the user: each blocked pane, or a tab reported
// blocked as a whole
export function waitingAgents(sessions: Session[]): WaitingAgent[] {
  return sessions.flatMap((s) => {
    if (!s.panes) {
      return s.agentStatus === 'blocked'
        ? [
            {
              sessionId: s.id,
              paneId: s.paneId,
              agent: s.agentName ?? s.name,
              tab: s.name,
            },
          ]
        : []
    }
    return s.panes
      .filter((p) => p.agentStatus === 'blocked')
      .map((p) => ({
        sessionId: s.id,
        paneId: p.id,
        agent: p.agentName ?? p.label,
        tab: s.name,
      }))
  })
}

export function buildWelcomeFacts(input: WelcomeInput): WelcomeFacts {
  const waiting = waitingAgents(input.sessions)
  const candidates: (NextAction | false)[] = [
    waiting.length > 0 && { kind: 'waiting', agent: waiting[0] },
    input.sessions.length === 0 && !input.readOnly && { kind: 'start' },
    input.notify === 'off' && !input.readOnly && { kind: 'notify' },
    !!input.install && { kind: 'install', how: input.install },
    input.desktop && input.pairedDevices === 0 && { kind: 'pair' },
  ]
  return {
    sessions: input.sessions.length,
    panes: input.sessions.reduce((n, s) => n + (s.panes?.length || 1), 0),
    waiting,
    next: candidates.filter((a): a is NextAction => !!a).slice(0, 2),
    primary: waiting.length > 0 ? 'waiting' : 'terminal',
  }
}

// Whether a device that saw seen should see the welcome screen
export function shouldShowWelcome(seen: number): boolean {
  return seen < WELCOME_VERSION
}

// How this page was loaded: 'navigate', 'reload', 'back_forward'; undefined
// where the browser does not say
export function navigationType(): string | undefined {
  const [entry] = performance.getEntriesByType?.('navigation') ?? []
  return (entry as PerformanceNavigationTiming | undefined)?.type
}

// Opened on a link to a pane (a notification opens a window on one): the
// welcome screen waits for the next visit rather than cover it. The app
// keeps the pane on screen in the address, so a reload is not a link.
export function openedOnLink(
  hasLink: boolean,
  type: string | undefined = navigationType(),
): boolean {
  return hasLink && type !== 'reload'
}
