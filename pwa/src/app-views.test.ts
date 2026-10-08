import { MessageSquare } from 'lucide-react'
import { describe, expect, it } from 'vitest'
import {
  APP_VIEWS,
  type AppView,
  availableViews,
  CHAT_VIEW_ID,
  TERMINAL_VIEW_ID,
  type ViewContext,
  viewPanelId,
} from './app-views'

const ctx: ViewContext = {
  mux: { backend: 'tmux', caps: { clientSideSelect: false, copyMode: true } },
  session: { id: '1', name: 'Shell', icon: '💻', description: '' },
  readOnly: false,
}

describe('app views', () => {
  it('offers only the terminal today', () => {
    expect(availableViews(APP_VIEWS, ctx).map((v) => v.id)).toEqual([
      TERMINAL_VIEW_ID,
    ])
  })

  it('offers a view only where it says it is available', () => {
    const chat: AppView = {
      id: 'chat',
      label: 'Chat',
      Icon: MessageSquare,
      available: (c) => !!c.session.hasAgent,
    }
    const views = [...APP_VIEWS, chat]
    expect(availableViews(views, ctx)).toHaveLength(1)
    expect(
      availableViews(views, {
        ...ctx,
        session: { ...ctx.session, hasAgent: true },
      }),
    ).toHaveLength(2)
  })

  it('offers Chat on a pane that shows only its shell, with caps.agentStart', () => {
    const idle: ViewContext = {
      mux: {
        backend: 'herdr',
        caps: { clientSideSelect: true, copyMode: false, agentChat: true },
      },
      session: {
        id: 'w1:t1',
        name: 'tab',
        icon: '',
        description: '',
        paneId: 'w1:p1',
        hasAgent: false,
        panes: [
          { id: 'w1:p1', label: 'Pane 1', hasAgent: false, command: 'zsh' },
        ],
      },
      readOnly: false,
    }
    const ids = (c: ViewContext) =>
      availableViews(APP_VIEWS, c).map((v) => v.id)
    expect(ids(idle)).not.toContain(CHAT_VIEW_ID)
    const startable = {
      ...idle,
      mux: { ...idle.mux, caps: { ...idle.mux.caps, agentStart: true } },
    }
    expect(ids(startable)).toContain(CHAT_VIEW_ID)
    // View only: nothing that sends input
    expect(ids({ ...startable, readOnly: true })).not.toContain(CHAT_VIEW_ID)
    // A pane running something else
    const busy = {
      ...startable,
      session: {
        ...startable.session,
        panes: [
          { id: 'w1:p1', label: 'Pane 1', hasAgent: false, command: 'vim' },
        ],
      },
    }
    expect(ids(busy)).not.toContain(CHAT_VIEW_ID)
    // ...unless a start made there from this page is still followed
    const following = {
      ...busy,
      agentStart: {
        starts: {
          'w1:p1': {
            kind: 'claude' as const,
            phase: 'starting' as const,
            since: 0,
          },
        },
        start: () => {},
      },
    }
    expect(ids(following)).toContain(CHAT_VIEW_ID)
    // A refused start does not keep it offered on a busy pane
    const refused = {
      ...busy,
      agentStart: {
        starts: {
          'w1:p1': {
            kind: 'claude' as const,
            phase: 'failed' as const,
            since: 0,
          },
        },
        start: () => {},
      },
    }
    expect(ids(refused)).not.toContain(CHAT_VIEW_ID)
    // A tab with no pane yet (first load)
    expect(
      ids({ ...following, session: { ...busy.session, paneId: undefined } }),
    ).not.toContain(CHAT_VIEW_ID)
  })

  it('names the element that shows a view', () => {
    expect(viewPanelId('chat')).toBe('view-panel-chat')
  })
})
