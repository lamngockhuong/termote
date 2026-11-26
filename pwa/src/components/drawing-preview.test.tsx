import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { createRef, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThemeProvider } from '../contexts/theme-context'
import { I18nContext } from '../i18n/i18n-context'
import type { DrawingKind } from '../utils/drawing-path'
import DrawingPreview, {
  type DrawingControl,
  type DrawingPreviewProps,
} from './drawing-preview'

// Excalidraw draws on a canvas jsdom has not: it stands in, showing how it
// was made, with buttons that make the changes it would report
type Props = Record<string, unknown> & {
  onChange: (els: unknown[], appState: unknown, files: unknown) => void
  onLibraryChange: (items: unknown[]) => void
  validateEmbeddable: (link: string) => boolean
  onLinkOpen: (element: { link: string | null }, e: CustomEvent) => void
}
const made = vi.hoisted(() => ({ props: undefined as Props | undefined }))
vi.mock('@excalidraw/excalidraw', () => ({
  isElementLink: (url: string) => url.includes('?element='),
  Excalidraw: (p: Props) => {
    made.props = p
    return (
      <div
        data-testid="excalidraw"
        data-view={String(p.viewModeEnabled)}
        data-theme={String(p.theme)}
        data-lang={String(p.langCode)}
      >
        {p.children as ReactNode}
      </div>
    )
  },
  // Each item named as Excalidraw shows it
  MainMenu: Object.assign(
    ({ children }: { children: ReactNode }) => (
      <div data-testid="main-menu">{children}</div>
    ),
    {
      Separator: () => <hr />,
      DefaultItems: {
        SearchMenu: () => <span>Find on canvas</span>,
        Help: () => <span>Help</span>,
        ClearCanvas: () => <span>Reset the canvas</span>,
        ChangeCanvasBackground: () => <span>Canvas background</span>,
      },
    },
  ),
}))
vi.mock('@excalidraw/excalidraw/index.css', () => ({}))
vi.mock('./drawing-preview.css', () => ({}))

// The scene's own work stands in too: a scene's hash is its elements'
// names, the drawing read is ['a']
const scene = vi.hoisted(() => ({
  loadDrawing: vi.fn(),
  serializeDrawing: vi.fn(),
}))
vi.mock('../utils/drawing-scene', () => ({
  loadDrawing: scene.loadDrawing,
  serializeDrawing: scene.serializeDrawing,
  sceneHash: (els: string[]) => els.join(),
  libraryHash: (items: string[]) => items.join(),
  serializeLibrary: (items: string[], source: string) =>
    `lib:${items.join()} from ${source}`,
}))

const READ = { initial: { elements: ['a'] }, base: 'a', obsidian: { at: 1 } }

function show(over: Partial<DrawingPreviewProps> = {}) {
  const props: DrawingPreviewProps = {
    kind: 'scene',
    text: 'file',
    notify: vi.fn(),
    path: 'notes/a.excalidraw',
    onFollow: vi.fn(),
    ...over,
  }
  const view = render(
    <ThemeProvider>
      <DrawingPreview {...props} />
    </ThemeProvider>,
  )
  const again = (next: Partial<DrawingPreviewProps>) =>
    view.rerender(
      <ThemeProvider>
        <DrawingPreview {...props} {...next} />
      </ThemeProvider>,
    )
  return { ...props, ...view, again }
}

const change = (els: string[]) =>
  act(() => made.props?.onChange(els, { bg: 1 }, {}))

beforeEach(() => {
  made.props = undefined
  scene.loadDrawing.mockReset()
  scene.loadDrawing.mockResolvedValue(READ)
  scene.serializeDrawing.mockReset()
  scene.serializeDrawing.mockImplementation(
    async (_k: DrawingKind, s: { elements: string[] }) =>
      `text:${s.elements.join()}`,
  )
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('DrawingPreview', () => {
  it('reads the text once, then shows it in Excalidraw, only looked at', async () => {
    const p = show()
    expect(screen.getByText('Loading…')).toBeInTheDocument()
    const ex = await screen.findByTestId('excalidraw')
    expect(scene.loadDrawing).toHaveBeenCalledWith('scene', 'file')
    expect(ex).toHaveAttribute('data-view', 'true')
    expect(ex).toHaveAttribute('data-lang', 'en')
    expect(made.props?.initialData).toBe(READ.initial)
    // Its menu without the links to Excalidraw's sites
    expect(screen.getByTestId('main-menu')).toHaveTextContent(
      'Find on canvasHelpReset the canvasCanvas background',
    )
    // No embedded page, no AI, nothing saved or exported by Excalidraw
    expect(made.props?.validateEmbeddable('https://example.com')).toBe(false)
    expect(made.props?.aiEnabled).toBe(false)
    expect(made.props?.UIOptions).toEqual({
      canvasActions: {
        loadScene: false,
        saveToActiveFile: false,
        export: false,
        saveAsImage: false,
        toggleTheme: false,
      },
    })
    // A change is not taken where nothing may change
    change(['a', 'b'])
    p.again({ text: 'other' })
    expect(scene.loadDrawing).toHaveBeenCalledTimes(1)
  })

  it('reads a PNG from its bytes and says it is shown only', async () => {
    const blob = new Blob(['png'])
    show({ kind: 'png', text: undefined, readBlob: async () => blob })
    await screen.findByTestId('excalidraw')
    expect(scene.loadDrawing).toHaveBeenCalledWith('png', blob)
    expect(screen.getByText(/A PNG drawing is shown only/)).toBeInTheDocument()
  })

  it('says when the file holds no drawing, and reads it again on Retry', async () => {
    scene.loadDrawing.mockRejectedValueOnce(new Error('no'))
    show()
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }))
    expect(await screen.findByTestId('excalidraw')).toBeInTheDocument()
    expect(scene.loadDrawing).toHaveBeenCalledTimes(2)
  })

  it('drops a read that answers after it is gone', async () => {
    let done: (v: unknown) => void = () => {}
    scene.loadDrawing.mockReturnValueOnce(new Promise((r) => (done = r)))
    const p = show()
    p.unmount()
    await act(async () => done(READ))
    let fail: (e: unknown) => void = () => {}
    scene.loadDrawing.mockReturnValueOnce(new Promise((_, r) => (fail = r)))
    show().unmount()
    await act(async () => fail(new Error('late')))
    expect(made.props).toBeUndefined()
  })

  it('follows the theme and the language', async () => {
    localStorage.setItem('termote-theme', 'dark')
    render(
      <I18nContext.Provider value={{ tourLocale: 'vi', appLocale: 'vi' }}>
        <ThemeProvider>
          <DrawingPreview
            kind="scene"
            text=""
            path="a.excalidraw"
            onFollow={vi.fn()}
            notify={vi.fn()}
            onChange={vi.fn()}
          />
        </ThemeProvider>
      </I18nContext.Provider>,
    )
    const ex = await screen.findByTestId('excalidraw')
    expect(ex).toHaveAttribute('data-view', 'false')
    expect(ex).toHaveAttribute('data-theme', 'dark')
    expect(ex).toHaveAttribute('data-lang', 'vi-VN')
    localStorage.clear()
  })

  describe('a scene changed', () => {
    beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }))

    it('gives the text once the drawing rests, the text read when back to it', async () => {
      const onChange = vi.fn()
      show({ onChange })
      await screen.findByTestId('excalidraw')
      // The drawing as read: nothing
      change(['a'])
      change(['a', 'b'])
      change(['a', 'b'])
      expect(onChange).not.toHaveBeenCalled()
      await act(() => vi.advanceTimersByTimeAsync(250))
      expect(onChange).toHaveBeenLastCalledWith('text:a,b')
      expect(scene.serializeDrawing).toHaveBeenCalledWith(
        'scene',
        { elements: ['a', 'b'], appState: { bg: 1 }, files: {} },
        'file',
        READ.obsidian,
      )
      change(['a'])
      await act(() => vi.advanceTimersByTimeAsync(250))
      expect(onChange).toHaveBeenLastCalledWith('file')
      expect(scene.serializeDrawing).toHaveBeenCalledTimes(1)
    })

    it('writes the last change at once when asked; drops it when it goes', async () => {
      const onChange = vi.fn()
      const controlRef = createRef<DrawingControl>()
      const p = show({ onChange, controlRef })
      await screen.findByTestId('excalidraw')
      change(['a', 'b'])
      let ok: boolean | undefined
      await act(async () => {
        ok = await controlRef.current?.flush()
      })
      expect(ok).toBe(true)
      expect(onChange).toHaveBeenLastCalledWith('text:a,b')
      // Nothing waiting: nothing written
      await act(() => controlRef.current?.flush())
      expect(onChange).toHaveBeenCalledTimes(1)
      // A stroke just before the tab closes makes no draft again
      change(['a', 'c'])
      p.unmount()
      await act(() => vi.advanceTimersByTimeAsync(300))
      expect(onChange).toHaveBeenCalledTimes(1)
      expect(controlRef.current).toBeNull()
    })

    it('gives nothing waiting, or being written, once dropped', async () => {
      let done: (t: string) => void = () => {}
      scene.serializeDrawing.mockReturnValueOnce(new Promise((r) => (done = r)))
      const onChange = vi.fn()
      const controlRef = createRef<DrawingControl>()
      show({ onChange, controlRef })
      await screen.findByTestId('excalidraw')
      change(['a', 'b'])
      const writing = controlRef.current?.flush()
      // The write has begun: dropped while it runs
      await act(async () => {})
      expect(scene.serializeDrawing).toHaveBeenCalled()
      act(() => controlRef.current?.drop())
      await act(async () => {
        done('late')
        await writing
      })
      change(['a', 'c'])
      act(() => controlRef.current?.drop())
      await act(() => vi.advanceTimersByTimeAsync(300))
      expect(onChange).not.toHaveBeenCalled()
    })

    it('writes nothing when it goes with no change waiting', async () => {
      const onChange = vi.fn()
      show({ onChange }).unmount()
      await act(() => vi.advanceTimersByTimeAsync(300))
      expect(onChange).not.toHaveBeenCalled()
    })

    it('gives nothing once it may no longer change the file', async () => {
      const onChange = vi.fn()
      const controlRef = createRef<DrawingControl>()
      const p = show({ onChange, controlRef })
      await screen.findByTestId('excalidraw')
      change(['a', 'b'])
      p.again({ onChange: undefined })
      await act(() => controlRef.current?.flush())
      expect(onChange).not.toHaveBeenCalled()
    })

    it('says when a change cannot be written', async () => {
      scene.serializeDrawing.mockRejectedValueOnce(new Error('export'))
      const onChange = vi.fn()
      const controlRef = createRef<DrawingControl>()
      const p = show({ onChange, controlRef })
      await screen.findByTestId('excalidraw')
      change(['a', 'b'])
      await act(() => controlRef.current?.flush())
      expect(onChange).not.toHaveBeenCalled()
      expect(p.notify).toHaveBeenCalledWith(
        expect.stringMatching(/could not be written/),
      )
      // The next one goes through
      change(['a', 'c'])
      await act(() => controlRef.current?.flush())
      expect(onChange).toHaveBeenLastCalledWith('text:a,c')
    })

    it('never saves with Ctrl+S after a change that could not be written', async () => {
      scene.serializeDrawing.mockRejectedValueOnce(new Error('export'))
      const onSave = vi.fn()
      const p = show({ onChange: vi.fn(), onSave })
      const ex = await screen.findByTestId('excalidraw')
      change(['a', 'b'])
      fireEvent.keyDown(ex, { key: 's', ctrlKey: true })
      await waitFor(() => expect(p.notify).toHaveBeenCalled())
      expect(onSave).not.toHaveBeenCalled()
    })

    it('saves with Ctrl+S after the last change, never with another key', async () => {
      const onChange = vi.fn()
      const onSave = vi.fn()
      show({ onChange, onSave })
      const ex = await screen.findByTestId('excalidraw')
      change(['a', 'b'])
      fireEvent.keyDown(ex, { key: 'k', ctrlKey: true })
      fireEvent.keyDown(ex, { key: 's' })
      expect(onSave).not.toHaveBeenCalled()
      fireEvent.keyDown(ex, { key: 'S', metaKey: true })
      await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
      expect(onChange).toHaveBeenCalledWith('text:a,b')
      // Without a save to call, the change is still written
      fireEvent.keyDown(ex, { key: 's', ctrlKey: true })
      await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2))
    })

    it('takes no scene change of a library', async () => {
      const onChange = vi.fn()
      const controlRef = createRef<DrawingControl>()
      show({ kind: 'library', onChange, controlRef })
      await screen.findByTestId('excalidraw')
      change(['a', 'b'])
      await act(() => controlRef.current?.flush())
      expect(onChange).not.toHaveBeenCalled()
    })
  })

  describe('a library', () => {
    it('gives its text at each change, the text read when back to it', async () => {
      const onChange = vi.fn()
      show({ kind: 'library', onChange })
      await screen.findByTestId('excalidraw')
      expect(screen.getByText(/Only the library is saved/)).toBeInTheDocument()
      act(() => made.props?.onLibraryChange(['a']))
      expect(onChange).not.toHaveBeenCalled()
      act(() => made.props?.onLibraryChange(['a', 'b']))
      expect(onChange).toHaveBeenLastCalledWith('lib:a,b from file')
      act(() => made.props?.onLibraryChange(['a']))
      expect(onChange).toHaveBeenLastCalledWith('file')
    })

    it('takes no change where nothing may change', async () => {
      show({ kind: 'library' })
      await screen.findByTestId('excalidraw')
      expect(screen.queryByText(/Only the library is saved/)).toBeNull()
      act(() => made.props?.onLibraryChange(['a', 'b']))
    })

    it('is never written into a drawing that is not a library', async () => {
      const onChange = vi.fn()
      show({ onChange })
      await screen.findByTestId('excalidraw')
      act(() => made.props?.onLibraryChange(['a', 'b']))
      expect(onChange).not.toHaveBeenCalled()
    })
  })

  describe("an element's link", () => {
    // Opens link as Excalidraw would, with Ctrl or not; true when it was
    // left to Excalidraw
    const open = (link: string | null, ctrlKey = false) => {
      const e = new CustomEvent('excalidraw-link', {
        cancelable: true,
        detail: { nativeEvent: { ctrlKey, metaKey: false } },
      })
      act(() => made.props?.onLinkOpen({ link }, e))
      return !e.defaultPrevented
    }

    it('opens a wiki link or a file in Files, a web page in a tab', async () => {
      const p = show()
      await screen.findByTestId('excalidraw')
      const opened = vi.spyOn(window, 'open').mockReturnValue(null)
      expect(open('[[Note A#Part]]')).toBe(false)
      expect(p.onFollow).toHaveBeenLastCalledWith(
        { path: 'notes/Note A.md', anchor: 'Part' },
        { newTab: false },
      )
      expect(open('plan.excalidraw', true)).toBe(false)
      expect(p.onFollow).toHaveBeenLastCalledWith(
        { path: 'notes/plan.excalidraw', anchor: undefined },
        { newTab: true },
      )
      expect(open('https://example.com/x')).toBe(false)
      expect(opened).toHaveBeenCalledWith(
        'https://example.com/x',
        '_blank',
        'noopener,noreferrer',
      )
      // Never this site's pages, nor another scheme
      expect(open('javascript:alert(1)')).toBe(false)
      expect(open('../../out')).toBe(false)
      expect(p.onFollow).toHaveBeenCalledTimes(2)
      expect(opened).toHaveBeenCalledTimes(1)
      opened.mockRestore()
    })

    it('leaves a link to another element, or none, to Excalidraw', async () => {
      const p = show()
      await screen.findByTestId('excalidraw')
      expect(open('https://excalidraw.com/?element=abc')).toBe(true)
      expect(open(null)).toBe(true)
      expect(p.onFollow).not.toHaveBeenCalled()
    })
  })
})
