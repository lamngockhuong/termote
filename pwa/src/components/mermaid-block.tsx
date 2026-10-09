import { Code } from 'lucide-react'
import {
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from 'react'
import { useTheme } from '../contexts/theme-context'
import {
  type MermaidFailure,
  type MermaidResult,
  peekMermaid,
  renderMermaid,
} from '../utils/mermaid-render'
import { IconButton } from './ui/button'

// What a Mermaid block puts in the frame of a code block (the preview's
// FencedCode): buttons before Copy, a line under the bar, and the diagram in
// place of the code.
export interface FrameParts {
  toolbar?: ReactNode
  note?: ReactNode
  body?: ReactNode
}

export const MERMAID_REASONS: Record<MermaidFailure, string> = {
  too_large: 'Diagram too large to render (over 50 KB)',
  unsupported: 'Diagrams with images or icons are not rendered',
  syntax: 'Not a valid Mermaid diagram',
  render_failed: 'Could not render the diagram',
  timeout: 'Diagram took too long to render',
  load_failed: 'Could not load the diagram renderer',
}

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
  // Its number among the file's Mermaid blocks, from 1
  index: number
  // The preview's scroll box
  scrollRoot: () => Element | null
  frame: (parts: FrameParts) => ReactNode
}

// A ```mermaid block: the diagram as an image once it nears the screen, the
// source with the reason whenever it cannot be drawn. Copy always copies the
// source.
export function MermaidBlock({ text, index, scrollRoot, frame }: Props) {
  const { resolvedTheme } = useTheme()
  const ref = useRef<HTMLDivElement>(null)
  const near = useNearViewport(ref, scrollRoot)
  // The result of this text; a theme change keeps the image until the new one
  const [state, setState] = useState<{
    text: string
    result: MermaidResult | null
  }>(() => ({ text, result: peekMermaid(text, resolvedTheme) ?? null }))
  const [source, setSource] = useState(false)

  useEffect(() => {
    const hit = peekMermaid(text, resolvedTheme)
    if (hit) {
      setState({ text, result: hit })
      return
    }
    if (!near) return
    const ac = new AbortController()
    renderMermaid(text, resolvedTheme, ac.signal).then(
      (result) => {
        if (!ac.signal.aborted) setState({ text, result })
      },
      // Aborted before its turn: this block is gone or shows other text
      () => {},
    )
    return () => ac.abort()
  }, [text, resolvedTheme, near])

  const result = state.text === text ? state.result : null
  let parts: FrameParts
  if (!result) {
    parts = { note: 'Rendering diagram…' }
  } else if (!result.ok) {
    parts = { note: MERMAID_REASONS[result.reason] }
  } else {
    const toggle = (
      <IconButton
        size="sm"
        onClick={() => setSource((s) => !s)}
        aria-pressed={source}
        aria-label="Show source"
        title="Show source"
      >
        <Code size={14} aria-hidden="true" />
      </IconButton>
    )
    parts = source
      ? { toolbar: toggle }
      : {
          toolbar: toggle,
          body: (
            <div className="overflow-x-auto p-3">
              <img
                src={result.url}
                width={result.width}
                height={result.height}
                alt={`Mermaid diagram ${index}`}
                className="mx-auto block max-w-none"
                draggable={false}
                // The SVG not valid as an image after all: show the source
                onError={() =>
                  setState({
                    text,
                    result: { ok: false, reason: 'render_failed' },
                  })
                }
              />
            </div>
          ),
        }
  }

  return (
    <div ref={ref} data-testid="mermaid-block">
      {frame(parts)}
    </div>
  )
}
