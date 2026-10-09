import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThemeProvider, useTheme } from '../contexts/theme-context'
import type { MermaidResult } from '../utils/mermaid-render'
import MarkdownPreview from './markdown-preview'
import { MERMAID_REASONS } from './mermaid-block'

const mockRender = vi.fn()
const mockPeek = vi.fn()
vi.mock('../utils/mermaid-render', () => ({
  renderMermaid: (...a: unknown[]) => mockRender(...a),
  peekMermaid: (...a: unknown[]) => mockPeek(...a),
}))
vi.mock('../utils/highlight', async (orig) => ({
  ...(await orig<typeof import('../utils/highlight')>()),
  highlightLang: () => Promise.resolve(null),
}))

const urlOf = (n: number) => `data:image/svg+xml;charset=utf-8,%3Csvg%3E${n}`
const ok = (n = 1): MermaidResult => ({
  ok: true,
  url: urlOf(n),
  width: 300,
  height: 120,
})

const GRAPH = 'graph TD\n  A --> B'
const md = (...blocks: string[]) =>
  blocks.map((b) => `\`\`\`mermaid\n${b}\n\`\`\``).join('\n\n')

// Changes the theme from inside the provider
let setTheme: (t: 'light' | 'dark') => void = () => {}
function ThemeHandle() {
  setTheme = useTheme().setTheme
  return null
}

function show(text: string) {
  const props = {
    text,
    path: 'docs/a.md',
    wrap: false,
    onFollow: vi.fn(),
    notify: vi.fn(),
  }
  const view = render(
    <ThemeProvider>
      <ThemeHandle />
      <MarkdownPreview {...props} />
    </ThemeProvider>,
  )
  const again = (next: string) =>
    view.rerender(
      <ThemeProvider>
        <ThemeHandle />
        <MarkdownPreview {...props} text={next} />
      </ThemeProvider>,
    )
  return { ...props, ...view, again }
}

// A promise resolved from the test
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  localStorage.clear()
  mockPeek.mockReset().mockReturnValue(undefined)
  mockRender.mockReset().mockResolvedValue(ok())
})
afterEach(() => vi.unstubAllGlobals())

describe('MermaidBlock', () => {
  it('draws the diagram as an image numbered in the file', async () => {
    mockRender.mockResolvedValueOnce(ok(1)).mockResolvedValueOnce(ok(2))
    show(
      `# T\n\n${md('graph LR\n  X', GRAPH)}\n\n\`\`\`ts\nconst a = 1\n\`\`\``,
    )
    const img = await screen.findByAltText('Mermaid diagram 2')
    expect(img).toHaveAttribute('src', urlOf(2))
    expect(img).toHaveAttribute('width', '300')
    expect(img).toHaveAttribute('height', '120')
    expect(screen.getByAltText('Mermaid diagram 1')).toBeInTheDocument()
    expect(mockRender).toHaveBeenCalledWith(
      GRAPH,
      'light',
      expect.any(AbortSignal),
    )
    // The ts block stays a plain code block
    const blocks = screen.getAllByTestId('fenced-code')
    expect(blocks[2]).toHaveTextContent('const a = 1')
    expect(blocks[2].querySelector('img')).toBeNull()
  })

  it('takes Mermaid in any case, and shows the info as written', async () => {
    show('```Mermaid\ngraph TD\n```')
    expect(await screen.findByAltText('Mermaid diagram 1')).toBeInTheDocument()
    expect(screen.getByTestId('fenced-code')).toHaveTextContent('Mermaid')
  })

  it('shows a cached diagram at once, without rendering again', () => {
    mockPeek.mockReturnValue(ok())
    show(md(GRAPH))
    expect(screen.getByAltText('Mermaid diagram 1')).toBeInTheDocument()
    expect(mockRender).not.toHaveBeenCalled()
  })

  it('shows the source while it renders', () => {
    mockRender.mockReturnValue(new Promise(() => {}))
    show(md(GRAPH))
    expect(screen.getByText('Rendering diagram…')).toBeInTheDocument()
    expect(screen.getByTestId('fenced-code')).toHaveTextContent('A --> B')
  })

  it.each(Object.entries(MERMAID_REASONS))(
    'falls back to the source for %s',
    async (reason, message) => {
      mockRender.mockResolvedValue({ ok: false, reason })
      show(`${md(GRAPH)}\n\n## After`)
      expect(await screen.findByText(message)).toBeInTheDocument()
      expect(screen.getByTestId('fenced-code')).toHaveTextContent('A --> B')
      expect(screen.queryByRole('img')).toBeNull()
      expect(screen.queryByRole('button', { name: 'Show source' })).toBeNull()
      // The rest of the file still renders
      expect(screen.getByRole('heading', { name: 'After' })).toBeInTheDocument()
    },
  )

  it('falls back to the source when the image cannot be decoded', async () => {
    show(md(GRAPH))
    fireEvent.error(await screen.findByAltText('Mermaid diagram 1'))
    expect(screen.getByText(MERMAID_REASONS.render_failed)).toBeInTheDocument()
    expect(screen.getByTestId('fenced-code')).toHaveTextContent('A --> B')
  })

  it('opens the diagram full screen at its own size', async () => {
    HTMLDialogElement.prototype.showModal = vi.fn(function (
      this: HTMLDialogElement,
    ) {
      this.setAttribute('open', '')
    })
    show(md(GRAPH))
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Open Mermaid diagram 1 full screen',
      }),
    )
    const dialog = await screen.findByRole(
      'dialog',
      {
        hidden: true,
        name: 'Mermaid diagram 1',
      },
      { timeout: 5000 },
    )
    expect(dialog.querySelector('img')).toHaveAttribute('src', urlOf(1))
    // Closed again by its own history entry
    const popped = new Promise((r) =>
      window.addEventListener('popstate', r, { once: true }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Close', hidden: true }))
    await popped
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { hidden: true })).toBeNull(),
    )
  })

  it('switches between the diagram and its source', async () => {
    show(md(GRAPH))
    await screen.findByAltText('Mermaid diagram 1')
    const toggle = screen.getByRole('button', { name: 'Show source' })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByAltText('Mermaid diagram 1')).toBeNull()
    expect(screen.getByTestId('fenced-code')).toHaveTextContent('A --> B')
    fireEvent.click(toggle)
    expect(screen.getByAltText('Mermaid diagram 1')).toBeInTheDocument()
  })

  it('copies the source while the diagram shows', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const p = show(md(GRAPH))
    await screen.findByAltText('Mermaid diagram 1')
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Copy code' })),
    )
    expect(writeText).toHaveBeenCalledWith(GRAPH)
    expect(p.notify).toHaveBeenCalledWith('Code copied')
  })

  it('renders again in the new theme, keeping the image meanwhile', async () => {
    show(md(GRAPH))
    await screen.findByAltText('Mermaid diagram 1')
    const next = deferred<MermaidResult>()
    mockRender.mockReturnValueOnce(next.promise)
    act(() => setTheme('dark'))
    expect(mockRender).toHaveBeenLastCalledWith(
      GRAPH,
      'dark',
      expect.any(AbortSignal),
    )
    expect(screen.getByAltText('Mermaid diagram 1')).toHaveAttribute(
      'src',
      urlOf(1),
    )
    await act(async () => next.resolve(ok(7)))
    expect(screen.getByAltText('Mermaid diagram 1')).toHaveAttribute(
      'src',
      urlOf(7),
    )
  })

  it('renders an edited block again and drops the late result of the old one', async () => {
    const old = deferred<MermaidResult>()
    mockRender.mockReturnValueOnce(old.promise)
    const p = show(md('graph TD\n  Old'))
    const first: AbortSignal = mockRender.mock.calls[0][2]
    p.again(md('graph TD\n  New'))
    expect(first.aborted).toBe(true)
    await screen.findByAltText('Mermaid diagram 1')
    await act(async () => old.resolve({ ok: false, reason: 'syntax' }))
    expect(screen.queryByText(MERMAID_REASONS.syntax)).toBeNull()
    expect(screen.getByAltText('Mermaid diagram 1')).toBeInTheDocument()
  })

  it('shows the source of an edited block until its own diagram is ready', async () => {
    const p = show(md('graph TD\n  Old'))
    await screen.findByAltText('Mermaid diagram 1')
    mockRender.mockReturnValueOnce(new Promise(() => {}))
    p.again(md('graph TD\n  New'))
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByText('Rendering diagram…')).toBeInTheDocument()
  })

  it('aborts when the block is gone, and ignores the rejection', async () => {
    const pending = deferred<MermaidResult>()
    mockRender.mockReturnValueOnce(pending.promise)
    const p = show(md(GRAPH))
    const signal: AbortSignal = mockRender.mock.calls[0][2]
    p.unmount()
    expect(signal.aborted).toBe(true)
    await act(async () => pending.reject(signal.reason))
  })

  it('a rejected render leaves the source showing', async () => {
    mockRender.mockRejectedValue(new DOMException('gone', 'AbortError'))
    show(md(GRAPH))
    await act(async () => {})
    expect(screen.getByText('Rendering diagram…')).toBeInTheDocument()
  })
})

describe('MermaidBlock: rendering near the screen only', () => {
  let observers: {
    cb: IntersectionObserverCallback
    opts?: IntersectionObserverInit
    el?: Element
    disconnected: boolean
  }[] = []

  beforeEach(() => {
    observers = []
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        o: (typeof observers)[number]
        constructor(
          cb: IntersectionObserverCallback,
          opts?: IntersectionObserverInit,
        ) {
          this.o = { cb, opts, disconnected: false }
          observers.push(this.o)
        }
        observe(el: Element) {
          this.o.el = el
        }
        disconnect() {
          this.o.disconnected = true
        }
      },
    )
  })

  const enter = (i: number, isIntersecting = true) =>
    act(() =>
      observers[i].cb(
        [{ isIntersecting } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      ),
    )

  it('waits until the block nears the preview’s visible part', async () => {
    show(md(GRAPH))
    expect(mockRender).not.toHaveBeenCalled()
    expect(screen.getByText('Rendering diagram…')).toBeInTheDocument()
    expect(observers[0].opts).toEqual({
      root: screen.getByTestId('markdown-preview'),
      rootMargin: '200px',
    })
    expect(observers[0].el).toBe(screen.getByTestId('mermaid-block'))

    enter(0, false)
    expect(mockRender).not.toHaveBeenCalled()
    enter(0)
    expect(mockRender).toHaveBeenCalledTimes(1)
    expect(observers[0].disconnected).toBe(true)
    expect(await screen.findByAltText('Mermaid diagram 1')).toBeInTheDocument()
  })

  it('shows a cached diagram even off screen', () => {
    mockPeek.mockReturnValue(ok())
    show(md(GRAPH))
    expect(screen.getByAltText('Mermaid diagram 1')).toBeInTheDocument()
    expect(mockRender).not.toHaveBeenCalled()
  })
})
