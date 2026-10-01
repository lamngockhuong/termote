import { render, screen } from '@testing-library/react'
import { Suspense } from 'react'
import { describe, expect, it, vi } from 'vitest'
import {
  APP_VIEWS,
  availableViews,
  CHANGES_VIEW_ID,
  FILES_VIEW_ID,
  type ViewContext,
  type ViewProps,
} from './app-views'
import { ThemeProvider } from './contexts/theme-context'

vi.mock('./hooks/use-mux-api', async (orig) => ({
  ...(await orig<typeof import('./hooks/use-mux-api')>()),
  fetchFilesTree: async () => ({
    root: '/r',
    isRepo: true,
    path: '',
    entries: [{ name: 'main.go', type: 'file', size: 1, sensitive: false }],
    truncated: false,
  }),
  fetchGitChanges: async () => ({
    root: '/r',
    isRepo: true,
    branch: 'main',
    entries: [{ path: 'main.go', staged: '', unstaged: 'M', sensitive: false }],
    truncated: false,
  }),
}))

const pane = (files?: boolean): ViewContext => ({
  mux: {
    backend: 'tmux',
    caps: { clientSideSelect: false, copyMode: true, files },
  },
  session: { id: '0', name: 'sh', icon: '', description: '', paneId: '0' },
  readOnly: false,
})

const ids = (ctx: ViewContext) =>
  availableViews(APP_VIEWS, ctx).map((v) => v.id)

describe('files and changes views', () => {
  it('are offered when the backend reports a pane directory, in the side panel', () => {
    expect(ids(pane(true))).toEqual([
      'terminal',
      FILES_VIEW_ID,
      CHANGES_VIEW_ID,
    ])
    expect(ids(pane(false))).toEqual(['terminal'])
    for (const id of [FILES_VIEW_ID, CHANGES_VIEW_ID]) {
      const v = APP_VIEWS.find((x) => x.id === id)!
      expect(v.placement).toBe('panel')
      // One component in both places
      expect(v.Main).toBe(v.Panel)
    }
  })

  it.each([
    [FILES_VIEW_ID, 'main.go'],
    [CHANGES_VIEW_ID, 'Modified:'],
  ])('%s loads on first use', async (id, text) => {
    const Main = APP_VIEWS.find((v) => v.id === id)!.Main!
    const props: ViewProps = {
      ...pane(true),
      isMobile: false,
      notify: vi.fn(),
      showView: vi.fn(),
    }
    render(
      <ThemeProvider>
        <Suspense fallback={<p>loading</p>}>
          <Main {...props} />
        </Suspense>
      </ThemeProvider>,
    )
    expect(await screen.findByText(text, { exact: false })).toBeInTheDocument()
  })
})
