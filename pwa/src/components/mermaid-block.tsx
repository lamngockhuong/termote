import { Code } from 'lucide-react'
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import { useTheme } from '../contexts/theme-context'
import { useDebouncedValue } from '../hooks/use-debounced-value'
import { useImageViewer } from '../hooks/use-image-viewer'
import { useT } from '../i18n/i18n-context'
import type { MessageKey } from '../i18n/messages/en'
import {
  type MermaidFailure,
  type MermaidResult,
  peekMermaid,
  renderMermaid,
} from '../utils/mermaid-render'
import { MermaidExport } from './mermaid-export'
import { IconButton } from './ui/button'

// What a Mermaid block puts in the frame of a code block (FencedCode):
// buttons before Copy, a line under the bar, and the diagram in
// place of the code.
export interface FrameParts {
  toolbar?: ReactNode
  note?: ReactNode
  body?: ReactNode
}

export const MERMAID_REASONS: Record<MermaidFailure, MessageKey> = {
  // Over 50 KB, or over the renderer's limits (500 links, nesting, output)
  too_large: 'files.mermaid.tooLarge',
  unsupported: 'files.mermaid.unsupported',
  syntax: 'files.mermaid.syntax',
  render_failed: 'files.mermaid.renderFailed',
  timeout: 'files.mermaid.timeout',
  load_failed: 'files.mermaid.loadFailed',
}

// While its source is edited, a diagram is drawn once the source has stayed
// the same this long: each keystroke would push the file's other diagrams
// out of the renderer's cache
export const LIVE_RENDER_DELAY = 800

// Within 200px of the scroll box's visible part, once; true at once without
// IntersectionObserver
function useNearViewport(
  ref: RefObject<HTMLElement | null>,
  root: () => Element | null,
): boolean {
  const [near, setNear] = useState(
    () => typeof IntersectionObserver === 'undefined',
  )
  // biome-ignore lint/correctness/useExhaustiveDependencies: the scroll box never changes
  useEffect(() => {
    if (near) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setNear(true)
      },
      { root: root(), rootMargin: '200px' },
    )
    io.observe(ref.current as HTMLElement)
    return () => io.disconnect()
  }, [near])
  return near
}

interface Props {
  // The block's source
  text: string
  // Its number among the Mermaid blocks of its file or message, from 1
  index: number
  // The scroll box it is shown in (the preview, the Chat view's list)
  scrollRoot: () => Element | null
  frame: (parts: FrameParts) => ReactNode
  // The file name an exported diagram is saved as, without its extension
  name: string
  notify: (message: string) => void
  // Its source is being edited (above)
  live?: boolean
  // The line of the file it starts on (a Markdown draft's preview)
  dataLine?: number
}

// A ```mermaid block: the diagram as an image once it nears the screen, the
// source with the reason whenever it cannot be drawn. Copy always copies the
// source; once drawn, the diagram can be shared, copied as an image or
// downloaded, here and in the full-screen viewer. While its source is
// edited, the last diagram drawn stays until a new one is, a source that
// cannot be drawn (half typed) only saying why under the bar.
export function MermaidBlock({
  text,
  index,
  scrollRoot,
  frame,
  name,
  notify,
  live = false,
  dataLine,
}: Props) {
  const { t } = useT()
  const { resolvedTheme } = useTheme()
  const ref = useRef<HTMLDivElement>(null)
  const near = useNearViewport(ref, scrollRoot)
  // The result of this text; a theme change keeps the image until the new one
  const [state, setState] = useState<{
    text: string
    result: MermaidResult | null
  }>(() => ({ text, result: peekMermaid(text, resolvedTheme) ?? null }))
  const [source, setSource] = useState(false)
  const settled = useDebouncedValue(text, LIVE_RENDER_DELAY)
  // Still changing: not drawn yet
  const waiting = live && settled !== text

  useEffect(() => {
    const hit = peekMermaid(text, resolvedTheme)
    if (hit) {
      setState({ text, result: hit })
      return
    }
    if (!near || waiting) return
    const ac = new AbortController()
    renderMermaid(text, resolvedTheme, ac.signal).then(
      (result) => {
        if (!ac.signal.aborted) setState({ text, result })
      },
      // Aborted before its turn: this block is gone or shows other text
      () => {},
    )
    return () => ac.abort()
  }, [text, resolvedTheme, near, waiting])

  const result = state.text === text ? state.result : null
  // The last diagram drawn, shown while the source is edited
  const [drawn, setDrawn] = useState(result?.ok ? result : null)
  if (result?.ok && result !== drawn) setDrawn(result)
  const image = result?.ok ? result : live ? drawn : null
  // The block takes focus when the image button goes (the diagram is drawn
  // again and fails, or the text changed), whether it had focus then or the
  // viewer it opened returns focus later
  const { open, viewer, failed } = useImageViewer(
    image?.url,
    ref,
    image
      ? (say) => <MermaidExport image={image} name={name} notify={say} />
      : undefined,
  )
  // The viewer's code could not be loaded: it closed, the diagram stays
  useEffect(() => {
    if (failed) notify(t('files.imagePreview.openFailed'))
  }, [failed, notify, t])
  const keepFocus = useCallback(
    (el: HTMLButtonElement | null) => () => {
      if (document.activeElement === el) ref.current?.focus()
    },
    [],
  )
  const alt = t('files.mermaid.alt', { index })
  // Why the source shown is not drawn (an older image may still show)
  const note = !result
    ? image
      ? undefined
      : t('files.mermaid.rendering')
    : result.ok
      ? undefined
      : t(MERMAID_REASONS[result.reason])
  let parts: FrameParts
  if (!image) {
    parts = { note }
  } else {
    const toggle = (
      <IconButton
        size="sm"
        onClick={() => setSource((s) => !s)}
        aria-pressed={source}
        aria-label={t('files.mermaid.showSource')}
        title={t('files.mermaid.showSource')}
      >
        <Code size={14} aria-hidden="true" />
      </IconButton>
    )
    // Their buttons go when the diagram does: focus then returns to the block
    const toolbar = (
      <>
        {toggle}
        <MermaidExport
          image={image}
          name={name}
          notify={notify}
          size="sm"
          buttonRef={keepFocus}
        />
      </>
    )
    parts = source
      ? { toolbar, note }
      : {
          toolbar,
          note,
          body: (
            <div className="overflow-x-auto p-3">
              <button
                ref={keepFocus}
                type="button"
                aria-label={t('files.imagePreview.open', { name: alt })}
                className="mx-auto block cursor-zoom-in"
                onClick={() =>
                  open({
                    src: image.url,
                    alt,
                    width: image.width,
                    height: image.height,
                    isSvg: true,
                  })
                }
              >
                <img
                  src={image.url}
                  width={image.width}
                  height={image.height}
                  alt={alt}
                  className="block max-w-none"
                  draggable={false}
                  // The SVG not valid as an image after all: show the source
                  onError={() =>
                    setState({
                      text,
                      result: { ok: false, reason: 'render_failed' },
                    })
                  }
                />
              </button>
            </div>
          ),
        }
  }

  return (
    <div
      ref={ref}
      tabIndex={-1}
      className="outline-none"
      data-testid="mermaid-block"
      data-line={dataLine}
    >
      {frame(parts)}
      {viewer}
    </div>
  )
}
