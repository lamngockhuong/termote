import { ImageIcon } from 'lucide-react'
import {
  type ComponentProps,
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useLongPress } from '../hooks/use-long-press'
import {
  findAnchor,
  type LinkPath,
  rehypeHeadingIds,
  rehypeMermaidIndex,
  resolveLink,
  splitFrontMatter,
} from '../utils/markdown-links'
import { detailsBlocks, htmlAsText } from '../utils/markdown-safety'
import { exportName } from '../utils/mermaid-export'
import { LINK, PROSE } from '../utils/prose'
import { CodeFence, FencedCode } from './fenced-code'

// A Markdown file of the Files (or Changes) view, rendered. The file is
// untrusted like an agent's text: raw HTML and MDX JSX show as text (only a
// <details> block folds, rebuilt from markdown nodes), no image
// ever loads, only http(s) links leave the app. Relative links stay inside
// the pane's root and open in the Files view.

interface Props {
  text: string
  // The file's path under the root: links resolve from its directory
  path: string
  wrap: boolean
  // Where to start: a heading, else an offset to restore
  anchor?: string
  scrollTop?: number
  // A link to another file or a directory, followed from scrollTop; newTab
  // for Ctrl/Cmd+click, a middle click or a long press
  onFollow: (
    target: LinkPath,
    scrollTop: number,
    opts: { newTab: boolean },
  ) => void
  notify: (message: string) => void
  // The text is a draft being edited beside (or behind) it: it starts at
  // the top, is not where the viewer keeps the file's scroll, and a diagram
  // keeps its last image while its source changes
  editing?: boolean
  // Where a link followed from the draft is left at (the editor's offset,
  // which Back restores), in place of the preview's own
  followScrollTop?: () => number
}

interface Ctx {
  path: string
  wrap: boolean
  editing: boolean
  // The scroll box, once mounted
  scroller: () => Element | null
  go: (target: LinkPath, newTab?: boolean) => void
  notify: (message: string) => void
}

// Always provided by MarkdownPreview
const PreviewContext = createContext({} as Ctx)

// How long a diagram drawn late may still move the start back into place
const RESTORE_FOR = 10_000

// A link inside the app: a button, so it never navigates the page.
// Ctrl/Cmd+click, a middle click or a long press ask for a new tab.
function LinkButton({
  id,
  label,
  onClick,
  children,
}: {
  id?: string
  // A footnote's back link is only an arrow: its label names it
  label?: string
  onClick: (newTab: boolean) => void
  children: ReactNode
}) {
  const press = useLongPress(() => onClick(true))
  return (
    <button
      type="button"
      id={id}
      aria-label={label}
      {...press}
      onClick={(e) => onClick(e.ctrlKey || e.metaKey)}
      onMouseDown={(e) => {
        // No autoscroll: a middle click opens the link
        if (e.button === 1) e.preventDefault()
      }}
      onAuxClick={(e) => {
        if (e.button !== 1) return
        e.preventDefault()
        onClick(true)
      }}
      className={`${LINK} inline cursor-pointer text-left [-webkit-touch-callout:none]`}
    >
      {children}
    </button>
  )
}

function MdLink({
  href,
  id,
  'aria-label': label,
  children,
}: ComponentProps<'a'>) {
  const { path, go } = useContext(PreviewContext)
  const t = resolveLink(href, path)
  switch (t.kind) {
    case 'external':
      return (
        <a
          id={id}
          href={t.url.href}
          // The text of a link can name another host than it goes to.
          title={t.url.host}
          target="_blank"
          rel="noopener noreferrer"
          className={LINK}
        >
          {children}
        </a>
      )
    case 'anchor':
      return (
        <LinkButton
          id={id}
          label={label}
          onClick={() => go({ path, anchor: t.anchor })}
        >
          {children}
        </LinkButton>
      )
    case 'path':
      return (
        <LinkButton id={id} label={label} onClick={(n) => go(t, n)}>
          {children}
        </LinkButton>
      )
    default:
      return <span id={id}>{children}</span>
  }
}

// Never loaded: a relative image opens as a file, an external one is a link
function MdImage({ src, alt }: ComponentProps<'img'>) {
  const { path, go } = useContext(PreviewContext)
  // Always a string from markdown (React also types a Blob)
  const t = resolveLink(src as string | undefined, path)
  if (t.kind === 'external') {
    return (
      <a
        href={t.url.href}
        title={t.url.host}
        target="_blank"
        rel="noopener noreferrer"
        className={`inline-flex items-center gap-1 ${LINK}`}
      >
        <ImageIcon size={13} aria-hidden="true" />
        image: {t.url.host}
      </a>
    )
  }
  if (t.kind === 'path') {
    const name = t.path.slice(t.path.lastIndexOf('/') + 1)
    return (
      <LinkButton onClick={(n) => go(t, n)}>
        <ImageIcon size={13} aria-hidden="true" className="mr-1 inline" />
        image: {alt || name}
      </LinkButton>
    )
  }
  return <span className="text-fg-muted">[image: {alt || 'unavailable'}]</span>
}

// A code block, or a Mermaid diagram, of the file
function MdPre({ node }: { node?: unknown }) {
  const { scroller, path, wrap, editing, notify } = useContext(PreviewContext)
  return (
    <CodeFence
      node={node}
      wrap={wrap}
      live={editing}
      notify={notify}
      scrollRoot={scroller}
      exportName={(index) => exportName(path, index)}
    />
  )
}

function MdTable(props: ComponentProps<'table'>) {
  return (
    <div className="my-3 overflow-x-auto">
      <table {...props} />
    </div>
  )
}

const COMPONENTS = {
  a: MdLink,
  img: MdImage,
  pre: MdPre,
  table: MdTable,
}

export default function MarkdownPreview({
  text,
  path,
  wrap,
  anchor,
  scrollTop,
  onFollow,
  notify,
  editing = false,
  followScrollTop,
}: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const { frontMatter, body } = useMemo(() => splitFrontMatter(text), [text])

  // Only called once the preview is on screen
  const box = () => ref.current as HTMLDivElement
  const scrollTo = (a: string) => {
    const el = findAnchor(box(), a)
    // A heading inside closed disclosures: open them first
    for (
      let d = el?.closest('details');
      d;
      d = d.parentElement?.closest('details')
    ) {
      d.open = true
    }
    if (el) el.scrollIntoView({ block: 'start' })
    else notify('Heading not found')
  }

  // Where the file starts, once its content is on screen
  // biome-ignore lint/correctness/useExhaustiveDependencies: only where it opens
  useLayoutEffect(() => {
    if (anchor) scrollTo(anchor)
    else if (scrollTop) box().scrollTop = scrollTop
  }, [])

  // A diagram drawn after that changes the height above where the file
  // starts: put it back there, until the user scrolls or for 10 s.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only where it opens
  useEffect(() => {
    if ((!anchor && !scrollTop) || typeof ResizeObserver === 'undefined') {
      return
    }
    const el = box()
    const restore = () => {
      if (!anchor) el.scrollTop = scrollTop as number
      else findAnchor(el, anchor)?.scrollIntoView({ block: 'start' })
    }
    const ro = new ResizeObserver(restore)
    ro.observe(el.firstElementChild as Element)
    const events = ['wheel', 'touchstart', 'keydown', 'pointerdown']
    const stop = () => {
      ro.disconnect()
      clearTimeout(timer)
      for (const e of events) el.removeEventListener(e, stop)
    }
    const timer = setTimeout(stop, RESTORE_FOR)
    for (const e of events) el.addEventListener(e, stop, { passive: true })
    return stop
  }, [])

  const ctx: Ctx = {
    path,
    wrap,
    editing,
    notify,
    scroller: () => ref.current,
    go: (target, newTab = false) => {
      if (target.path === path) {
        if (target.anchor) scrollTo(target.anchor)
        else box().scrollTop = 0
        return
      }
      onFollow(target, followScrollTop?.() ?? box().scrollTop, { newTab })
    },
  }

  return (
    <PreviewContext.Provider value={ctx}>
      <div
        ref={ref}
        className="min-h-0 flex-1 overflow-auto bg-bg"
        data-testid="markdown-preview"
        data-scroll-restore={editing ? undefined : ''}
        // Focused when the editor hides (MarkdownEditLayout)
        tabIndex={editing ? -1 : undefined}
      >
        <div className={PROSE}>
          {frontMatter !== undefined && (
            <FencedCode
              text={frontMatter}
              lang="yaml"
              label="front matter"
              wrap={wrap}
              notify={notify}
            />
          )}
          <Markdown
            remarkPlugins={[remarkGfm, detailsBlocks, htmlAsText]}
            rehypePlugins={[rehypeHeadingIds, rehypeMermaidIndex]}
            components={COMPONENTS}
          >
            {body}
          </Markdown>
        </div>
      </div>
    </PreviewContext.Provider>
  )
}
