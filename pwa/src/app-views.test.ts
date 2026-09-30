import { MessageSquare } from 'lucide-react'
import { describe, expect, it } from 'vitest'
import {
  APP_VIEWS,
  type AppView,
  availableViews,
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

  it('names the element that shows a view', () => {
    expect(viewPanelId('chat')).toBe('view-panel-chat')
  })
})
