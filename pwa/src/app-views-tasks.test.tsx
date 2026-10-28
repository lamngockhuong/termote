import { render, screen } from '@testing-library/react'
import { Suspense } from 'react'
import { describe, expect, it, vi } from 'vitest'
import {
  APP_VIEWS,
  availableViews,
  TASKS_VIEW_ID,
  type ViewContext,
  type ViewProps,
} from './app-views'
import { ThemeProvider } from './contexts/theme-context'

vi.mock('./hooks/use-mux-api', async (orig) => ({
  ...(await orig<typeof import('./hooks/use-mux-api')>()),
  fetchTasks: async () => ({
    root: '/r',
    packageManager: 'pnpm',
    scripts: [{ name: 'lint', command: 'eslint .' }],
    makefile: '',
    makeTargets: [],
    userTasks: [],
    runs: {},
    skipped: 0,
    tooLarge: [],
    toolGroups: [],
    unreadable: [],
  }),
}))

const pane = (tasks: boolean): ViewContext => ({
  mux: {
    backend: 'tmux',
    caps: { clientSideSelect: false, copyMode: true, tasks },
  },
  session: { id: '0', name: 'sh', icon: '', description: '', paneId: '0' },
  readOnly: false,
})

describe('tasks view', () => {
  it('is offered only when the backend reports tasks, as a main view', () => {
    const ids = (ctx: ViewContext) =>
      availableViews(APP_VIEWS, ctx).map((v) => v.id)
    expect(ids(pane(true))).toContain(TASKS_VIEW_ID)
    expect(ids(pane(false))).not.toContain(TASKS_VIEW_ID)
  })

  it('loads on first use and lists the pane scripts', async () => {
    const Main = APP_VIEWS.find((v) => v.id === TASKS_VIEW_ID)!.Main!
    const props: ViewProps = {
      ...pane(true),
      isMobile: false,
      notify: vi.fn(),
      showView: vi.fn(),
    } as ViewProps
    render(
      <ThemeProvider>
        <Suspense fallback={<p>loading</p>}>
          <Main {...props} />
        </Suspense>
      </ThemeProvider>,
    )
    expect(await screen.findByText('eslint .')).toBeInTheDocument()
  })
})
