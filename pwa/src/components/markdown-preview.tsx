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
}

interface Ctx {
  path: string
  wrap: boolean
  // The scroll box, once mounted
  scroller: () => Element | null
  go: (target: LinkPath, newTab?: boolean) => void
  notify: (message: string) => void
}

// Always provided by MarkdownPreview
const PreviewContext = createContext({} as Ctx)

const LINK = 'text-accent underline underline-offset-2'
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
  const { scroller, path, wrap, notify } = useContext(PreviewContext)
  return (
    <CodeFence
      node={node}
      wrap={wrap}
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

const PROSE = [
  'min-w-0 break-words px-4 py-3 text-[14px] leading-relaxed text-fg',
  '[&_h1]:mt-6 [&_h1]:mb-3 [&_h1]:border-b [&_h1]:border-border [&_h1]:pb-1 [&_h1]:text-[22px] [&_h1]:font-semibold',
  '[&_h2]:mt-6 [&_h2]:mb-3 [&_h2]:border-b [&_h2]:border-border [&_h2]:pb-1 [&_h2]:text-[18px] [&_h2]:font-semibold',
  '[&_h3]:mt-5 [&_h3]:mb-2 [&_h3]:text-[16px] [&_h3]:font-semibold',
  '[&_h4]:mt-4 [&_h4]:mb-2 [&_h4]:font-semibold [&_h5]:mt-4 [&_h5]:font-semibold [&_h6]:mt-4 [&_h6]:font-semibold [&_h6]:text-fg-muted',
  '[&>*:first-child]:mt-0 [&_p]:my-3 [&_ul]:my-3 [&_ol]:my-3 [&_ul]:list-disc [&_ol]:list-decimal [&_li]:ml-5 [&_li>p]:my-1',
  '[&_.contains-task-list]:list-none [&_.task-list-item]:ml-0 [&_.task-list-item_input]:mr-1.5 [&_.task-list-item_input]:align-middle',
  '[&_blockquote]:my-3 [&_blockquote]:border-l-4 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-fg-muted',
  '[&_hr]:my-6 [&_hr]:border-border',
  '[&_details]:my-3 [&_details]:rounded-control [&_details]:border [&_details]:border-border [&_details]:px-3 [&_details]:py-1.5',
  '[&_summary]:cursor-pointer [&_summary]:font-medium [&_details[open]>summary]:mb-2',
  '[&_:not(pre)>code]:rounded [&_:not(pre)>code]:bg-surface-raised [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:font-term [&_:not(pre)>code]:text-[0.9em]',
  '[&_table]:border-collapse [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-border [&_th]:bg-surface [&_th]:px-2 [&_th]:py-1 [&_th]:text-left',
  '[&_.footnotes]:mt-8 [&_.footnotes]:border-t [&_.footnotes]:border-border [&_.footnotes]:pt-2 [&_.footnotes]:text-[13px] [&_sup]:text-[0.75em]',
].join(' ')

export default function MarkdownPreview({
  text,
  path,
  wrap,
  anchor,
  scrollTop,
  onFollow,
  notify,
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
    notify,
    scroller: () => ref.current,
    go: (target, newTab = false) => {
      if (target.path === path) {
        if (target.anchor) scrollTo(target.anchor)
        else box().scrollTop = 0
        return
      }
      onFollow(target, box().scrollTop, { newTab })
    },
  }

  return (
    <PreviewContext.Provider value={ctx}>
      <div
        ref={ref}
        className="min-h-0 flex-1 overflow-auto bg-bg"
        data-testid="markdown-preview"
        data-scroll-restore
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
