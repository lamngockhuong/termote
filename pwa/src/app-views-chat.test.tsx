import { render, screen } from '@testing-library/react'
import { Suspense } from 'react'
import { describe, expect, it, vi } from 'vitest'
import {
  APP_VIEWS,
  availableViews,
  CHAT_VIEW_ID,
  type ViewContext,
  type ViewProps,
} from './app-views'

vi.mock('./hooks/use-agent-transcript', () => ({
  useAgentTranscript: () => ({
    entries: [
      {
        id: 'a',
        role: 'assistant',
        parts: [{ kind: 'text', text: 'hello from claude' }],
      },
    ],
    loaded: true,
    loadingOlder: false,
    refresh: vi.fn(),
    loadOlder: vi.fn(),
  }),
}))

const claudePane: ViewContext = {
  mux: {
    backend: 'tmux',
    caps: { clientSideSelect: false, copyMode: true, agentChat: true },
  },
  session: {
    id: '0',
    name: 'claude',
    icon: '',
    description: '',
    paneId: '0',
    hasAgent: true,
    agentName: 'claude',
  },
  readOnly: false,
}

const ids = (ctx: ViewContext) =>
  availableViews(APP_VIEWS, ctx).map((v) => v.id)

describe('chat view', () => {
  it('is offered for a Claude Code pane on a backend with agentChat', () => {
    expect(ids(claudePane)).toEqual(['terminal', CHAT_VIEW_ID])
  })

  it.each([
    [
      'the backend has no agentChat',
      {
        mux: {
          ...claudePane.mux,
          caps: { clientSideSelect: false, copyMode: true },
        },
      },
    ],
    [
      'the pane runs no agent',
      { session: { ...claudePane.session, hasAgent: false } },
    ],
    [
      'the agent is not Claude Code',
      { session: { ...claudePane.session, agentName: 'codex' } },
    ],
  ])('is not offered when %s', (_, over) => {
    expect(ids({ ...claudePane, ...over })).toEqual(['terminal'])
  })

  it('loads its main area on first use', async () => {
    const chat = APP_VIEWS.find((v) => v.id === CHAT_VIEW_ID)!
    const props: ViewProps = {
      ...claudePane,
      isMobile: false,
      notify: vi.fn(),
      showView: vi.fn(),
    }
    const Main = chat.Main!
    render(
      <Suspense fallback={<p>loading</p>}>
        <Main {...props} />
      </Suspense>,
    )
    expect(await screen.findByText('hello from claude')).toBeInTheDocument()
  })
})
