import { fireEvent, render, screen } from '@testing-library/react'
import { Suspense } from 'react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import {
  APP_VIEWS,
  availableViews,
  CHAT_VIEW_ID,
  type ViewContext,
  type ViewProps,
} from './app-views'

// The composer's own tests cover it; here only which input a pane gets
vi.mock('./components/chat-composer', () => ({
  ChatComposer: () => <textarea aria-label="Message" />,
}))

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

const codexPane: ViewContext = {
  ...claudePane,
  session: { ...claudePane.session, name: 'codex', agentName: 'codex' },
}

const ids = (ctx: ViewContext) =>
  availableViews(APP_VIEWS, ctx).map((v) => v.id)

// The lazy chat view, loaded once up front: its first load can outlast a
// find under coverage
beforeAll(() => import('./components/chat-view'))

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
      'the agent has no transcript reader',
      { session: { ...claudePane.session, agentName: 'pi' } },
    ],
    [
      'the agent is not named',
      { session: { ...claudePane.session, agentName: undefined } },
    ],
  ])('is not offered when %s', (_, over) => {
    expect(ids({ ...claudePane, ...over })).toEqual(['terminal'])
  })

  it('is offered for a Codex pane', () => {
    expect(ids(codexPane)).toEqual(['terminal', CHAT_VIEW_ID])
  })

  it('gives Claude Code and Codex the composer, another agent a read-only bar', () => {
    const chat = APP_VIEWS.find((v) => v.id === CHAT_VIEW_ID)!
    const Input = chat.Input!
    const showView = vi.fn()
    const props = (ctx: ViewContext): ViewProps => ({
      ...ctx,
      isMobile: false,
      notify: vi.fn(),
      showView,
    })
    for (const pane of [claudePane, codexPane]) {
      const { unmount } = render(<Input {...props(pane)} />)
      expect(screen.getByRole('textbox')).toBeInTheDocument()
      expect(screen.queryByText('Read only')).toBeNull()
      unmount()
    }

    // An agent the server reads but cannot write to.
    const other = {
      ...codexPane,
      session: { ...codexPane.session, name: 'pi', agentName: 'pi' },
    }
    render(<Input {...props(other)} />)
    expect(screen.getByText('Read only')).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open terminal' }))
    expect(showView).toHaveBeenCalledWith('terminal')
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
