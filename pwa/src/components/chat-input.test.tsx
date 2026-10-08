import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ViewProps } from '../app-views'
import { ChatInput } from './chat-input'

vi.mock('./chat-composer', () => ({
  ChatComposer: () => <div data-testid="composer" />,
}))

const props: ViewProps = {
  mux: {
    backend: 'herdr',
    caps: { clientSideSelect: true, copyMode: false, agentStart: true },
  },
  session: {
    id: 'w1:t1',
    name: 'tab',
    icon: '',
    description: '',
    paneId: 'w1:p1',
    hasAgent: true,
    agentName: 'claude',
  },
  readOnly: false,
  isMobile: false,
  notify: vi.fn(),
  showView: vi.fn(),
}

describe('ChatInput', () => {
  it('shows the composer for an agent the server writes to', () => {
    const { queryByTestId } = render(<ChatInput {...props} />)
    expect(queryByTestId('composer')).toBeTruthy()
  })

  it('has no composer on a pane with no agent', () => {
    const { container } = render(
      <ChatInput
        {...props}
        session={{ ...props.session, hasAgent: false, agentName: undefined }}
      />,
    )
    expect(container.innerHTML).toBe('')
  })
})
