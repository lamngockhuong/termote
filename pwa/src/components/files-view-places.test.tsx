import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ViewProps } from '../app-views'
import { ThemeProvider } from '../contexts/theme-context'
import { resetFilesStores } from '../hooks/use-files'
import { RequestError } from '../hooks/use-mux-api'
import { FilesView } from './files-view'

const mockTree = vi.fn()
const mockPlaces = vi.fn()
vi.mock('../hooks/use-mux-api', async (orig) => ({
  ...(await orig<typeof import('../hooks/use-mux-api')>()),
  fetchFilesTree: (...a: unknown[]) => mockTree(...a),
  fetchPlaces: () => mockPlaces(),
}))

const PANE = '/home/kim/app'
const NOTES = '/home/kim/notes'

function props(over: Partial<ViewProps> = {}, places = true): ViewProps {
  return {
    mux: {
      backend: 'tmux',
      caps: { clientSideSelect: false, copyMode: true, files: true, places },
    },
    session: {
      id: '1',
      name: 'Shell',
      icon: '💻',
      description: '',
      paneId: '%1',
    },
    readOnly: false,
    isMobile: false,
    notify: vi.fn(),
    showView: vi.fn(),
    ...over,
  }
}

async function show(over: Partial<ViewProps> = {}, places = true) {
  const p = props(over, places)
  render(
    <ThemeProvider>
      <FilesView {...p} />
    </ThemeProvider>,
  )
  await act(async () => {})
  return p
}

const rootShown = () => screen.getByTestId('pane-root').getAttribute('title')

beforeEach(() => {
  localStorage.clear()
  Element.prototype.scrollIntoView = vi.fn()
  resetFilesStores()
  mockTree.mockReset()
  mockPlaces.mockReset()
  mockPlaces.mockResolvedValue([{ id: 'n1', name: 'notes', path: NOTES }])
  mockTree.mockImplementation(
    async (t: { place?: string }, path: string, seen?: string) => {
      if (t.place && t.place !== 'n1')
        throw new RequestError(404, 'unknown_place', 'no such place')
      const root = t.place ? NOTES : PANE
      if (seen && seen !== root)
        throw Object.assign(new RequestError(409, '', 'moved'), { root })
      return {
        root,
        isRepo: false,
        path,
        entries: [
          {
            name: t.place ? 'todo.md' : 'main.go',
            type: 'file',
            size: 1,
            sensitive: false,
          },
        ],
        truncated: false,
      }
    },
  )
})

describe('Places in Files', () => {
  it('offers the Places and shows the one picked, then the pane folder again', async () => {
    const p = await show()
    await waitFor(() => expect(rootShown()).toBe(PANE))
    fireEvent.click(screen.getByRole('button', { name: 'Places' }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'notes' }))
    await waitFor(() => expect(rootShown()).toBe(NOTES))
    expect(screen.getByRole('treeitem', { name: /todo\.md/ })).toBeTruthy()
    // Asked for: not told as the pane's folder moving
    expect(p.notify).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Places: notes' }))
    expect(
      screen.getByRole('menuitemradio', { name: 'notes' }),
    ).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Pane folder' }))
    await waitFor(() => expect(rootShown()).toBe(PANE))
    expect(p.notify).not.toHaveBeenCalled()
  })

  it('without Places, or for a view-only client, nothing is offered', async () => {
    await show({}, false)
    await waitFor(() => expect(rootShown()).toBe(PANE))
    expect(screen.queryByRole('button', { name: 'Places' })).toBeNull()
    expect(mockPlaces).not.toHaveBeenCalled()
  })

  it('a view-only client is offered none', async () => {
    await show({ readOnly: true })
    await waitFor(() => expect(rootShown()).toBe(PANE))
    expect(screen.queryByRole('button', { name: 'Places' })).toBeNull()
    expect(mockPlaces).not.toHaveBeenCalled()
  })

  it('a Place kept on the device that is gone falls back with one notice', async () => {
    localStorage.clear()
    const { setPaneKeys } = await import('../utils/pane-remap')
    const { saveTabs, flushAll } = await import('../utils/files-persist')
    setPaneKeys(
      {
        instanceId: 'i1',
        groups: [{ id: '$0', name: 'main', tabs: [{ id: '%1', panes: [] }] }],
      } as never,
      new Map([['%1', '@1']]),
    )
    saveTabs('files', '%1', { place: 'gone', tabs: [], activeId: null })
    flushAll()
    const p = await show()
    await waitFor(() => expect(rootShown()).toBe(PANE))
    expect(p.notify).toHaveBeenCalledTimes(1)
    expect(p.notify).toHaveBeenCalledWith(
      "That place isn't available; showing the pane's folder",
      { variant: 'warning' },
    )
  })
})
