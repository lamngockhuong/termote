import { Excalidraw, isElementLink, MainMenu } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import './drawing-preview.css'
import type {
  ExcalidrawElement,
  NonDeletedExcalidrawElement,
} from '@excalidraw/excalidraw/element/types'
import type {
  AppState,
  BinaryFiles,
  ExcalidrawProps,
  LibraryItems,
} from '@excalidraw/excalidraw/types'
import {
  type KeyboardEvent,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from 'react'
import { useTheme } from '../contexts/theme-context'
import { useT } from '../i18n/i18n-context'
import { drawingLink } from '../utils/drawing-link'
import type { DrawingKind } from '../utils/drawing-path'
import {
  type LoadedDrawing,
  libraryHash,
  loadDrawing,
  type Scene,
  sceneHash,
  serializeDrawing,
  serializeLibrary,
} from '../utils/drawing-scene'
import type { LinkPath } from '../utils/markdown-links'
import { LoadFailed } from './lazy-boundary'
import { ViewMessage } from './pane-dir-header'
import { Banner } from './ui/banner'

// What the viewer holding the drawing calls: the change still waiting
// written now (Save calls it first: false when it could not be), or
// dropped (the draft was discarded)
export interface DrawingControl {
  flush: () => Promise<boolean>
  drop: () => void
}

export interface DrawingPreviewProps {
  kind: DrawingKind
  // The drawing's file, which an element's link is read from
  path: string
  // An element's link to a file under the root; newTab with Ctrl/Cmd
  onFollow: (target: LinkPath, opts: { newTab: boolean }) => void
  // The text the drawing is read from (every kind but a PNG), once: the
  // caller mounts it again for another
  text?: string
  // A PNG's bytes, read once when it mounts
  readBlob?: () => Promise<Blob>
  // The file may be changed here: each change gives the text it now
  // writes, the text read when it is back to the drawing as read. Absent:
  // shown only.
  onChange?: (text: string) => void
  // Ctrl/Cmd+S in the drawing, after the last change is given
  onSave?: () => void
  controlRef?: RefObject<DrawingControl | null>
  notify: (message: string) => void
}

// A change is written once the drawing rests this long: a stroke gives one
// per frame, and each one is the whole file
const WRITE_DELAY = 250

// What the file holds is all a save writes: no opening or saving of other
// files, no export (its fonts are subset with WebAssembly, which the page's
// policy does not run), the theme the app's
const UI: ExcalidrawProps['UIOptions'] = {
  canvasActions: {
    loadScene: false,
    saveToActiveFile: false,
    export: false,
    saveAsImage: false,
    toggleTheme: false,
  },
}

// An embedded web page would be a frame of any site, which the page's
// policy refuses: each shows as its link
const noEmbeds = () => false

type State =
  | { status: 'loading' }
  | { status: 'ready'; drawing: LoadedDrawing }
  | { status: 'error' }

// An Excalidraw file as its drawing, in Excalidraw itself: changed and
// saved as the file's text when onChange is given, else only looked at
export default function DrawingPreview({
  kind,
  text,
  readBlob,
  onChange,
  onSave,
  controlRef,
  notify,
  path,
  onFollow,
}: DrawingPreviewProps) {
  const { t, locale } = useT()
  const { resolvedTheme } = useTheme()
  const [state, setState] = useState<State>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  // Read once: the drawing shown is what changes from here
  const source = useRef(text ?? '')
  const read = useRef(readBlob)
  const changed = useRef(onChange)
  changed.current = onChange
  const saved = useRef(onSave)
  saved.current = onSave
  const told = useRef(notify)
  told.current = notify
  // The hash of the drawing last given (the one read at first)
  const last = useRef<string>(undefined)

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt reads it again
  useEffect(() => {
    let live = true
    setState({ status: 'loading' })
    const load = async () =>
      loadDrawing(
        kind,
        kind === 'png'
          ? await (read.current as () => Promise<Blob>)()
          : source.current,
      )
    load().then(
      (drawing) => {
        if (!live) return
        last.current = drawing.base
        setState({ status: 'ready', drawing })
      },
      () => {
        if (live) setState({ status: 'error' })
      },
    )
    return () => {
      live = false
    }
  }, [kind, attempt])

  const drawing = state.status === 'ready' ? state.drawing : undefined
  // The scene waiting to be written, and the writes in order: an SVG's is
  // made asynchronously, and an older one must never land after a newer one
  const pending = useRef<Scene>(undefined)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const queue = useRef(Promise.resolve(true))
  // Bumped when what is waiting is dropped: a write made before gives nothing
  const round = useRef(0)

  const write = async () => {
    const scene = pending.current
    if (!scene) return true
    pending.current = undefined
    const mine = round.current
    // A change is only ever made to a drawing shown
    const shown = drawing as LoadedDrawing
    try {
      const next =
        sceneHash(scene.elements, scene.appState) === shown.base
          ? source.current
          : await serializeDrawing(
              kind as Exclude<DrawingKind, 'library' | 'png'>,
              scene,
              source.current,
              shown.obsidian,
            )
      // Dropped while it was made: given to no one
      if (mine !== round.current) return true
      changed.current?.(next)
      return true
    } catch {
      // The draft stays as the last change written: the next one tries again
      told.current(t('files.drawing.writeFailed'))
      return false
    }
  }
  // Nothing waiting is written: the draft was discarded, or the view goes
  // (a stroke made just before a tab is closed must not make a draft again)
  const drop = () => {
    clearTimeout(timer.current)
    pending.current = undefined
    round.current++
  }
  const dropRef = useRef(drop)
  dropRef.current = drop
  const flush = () => {
    clearTimeout(timer.current)
    queue.current = queue.current.then(write)
    return queue.current
  }
  const flushRef = useRef(flush)
  flushRef.current = flush

  useEffect(() => {
    if (!controlRef) return
    controlRef.current = {
      flush: () => flushRef.current(),
      drop: () => dropRef.current(),
    }
    return () => {
      controlRef.current = null
    }
  }, [controlRef])

  useEffect(() => () => dropRef.current(), [])

  const onSceneChange = (
    elements: readonly ExcalidrawElement[],
    appState: AppState,
    files: BinaryFiles,
  ) => {
    if (!changed.current || kind === 'library' || kind === 'png') return
    const hash = sceneHash(elements, appState)
    if (hash === last.current) return
    last.current = hash
    pending.current = { elements, appState, files }
    clearTimeout(timer.current)
    timer.current = setTimeout(() => void flushRef.current(), WRITE_DELAY)
  }

  // Excalidraw reports the library of any file: only a library's is saved
  const onLibraryChange = (items: LibraryItems) => {
    if (kind !== 'library' || !changed.current || !drawing) return
    const hash = libraryHash(items)
    if (hash === last.current) return
    last.current = hash
    changed.current(
      hash === drawing.base
        ? source.current
        : serializeLibrary(items, source.current),
    )
  }

  // An element's link: Excalidraw would open one that is not a web page's
  // address as a page of this site. A file's (an Obsidian wiki link
  // included) opens in Files, a web page in a tab of its own; one to
  // another element of the drawing is Excalidraw's.
  const onLinkOpen = (
    element: NonDeletedExcalidrawElement,
    e: CustomEvent<{ nativeEvent: { ctrlKey: boolean; metaKey: boolean } }>,
  ) => {
    const link = element.link
    if (!link || isElementLink(link)) return
    e.preventDefault()
    const target = drawingLink(link, path)
    const { ctrlKey, metaKey } = e.detail.nativeEvent
    if (target.kind === 'external')
      window.open(target.url.href, '_blank', 'noopener,noreferrer')
    else if (target.kind === 'path')
      onFollow(
        { path: target.path, anchor: target.anchor },
        { newTab: ctrlKey || metaKey },
      )
  }

  // Ctrl/Cmd+S saves the file here: Excalidraw's own would download it
  const onKey = (e: KeyboardEvent) => {
    if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 's') return
    e.preventDefault()
    e.stopPropagation()
    void flush().then((ok) => {
      if (ok) saved.current?.()
    })
  }

  if (state.status === 'error')
    return (
      <LoadFailed
        message={t('files.drawing.unreadable')}
        retry={() => setAttempt((n) => n + 1)}
      />
    )
  if (state.status === 'loading')
    return <ViewMessage>{t('files.loading')}</ViewMessage>
  const editing = !!onChange
  return (
    <div className="flex min-h-0 flex-1 flex-col" onKeyDownCapture={onKey}>
      {kind === 'library' && editing && (
        <Banner>{t('files.drawing.libraryOnly')}</Banner>
      )}
      {kind === 'png' && <Banner>{t('files.drawing.pngReadOnly')}</Banner>}
      <div className="relative min-h-0 flex-1" data-testid="drawing">
        <Excalidraw
          initialData={state.drawing.initial}
          viewModeEnabled={!editing}
          theme={resolvedTheme}
          langCode={locale === 'vi' ? 'vi-VN' : 'en'}
          UIOptions={UI}
          onChange={onSceneChange}
          onLibraryChange={onLibraryChange}
          validateEmbeddable={noEmbeds}
          onLinkOpen={onLinkOpen}
          aiEnabled={false}
        >
          {/* Excalidraw's own, less what UI turns off and its links to
              its sites (GitHub, X, Discord) */}
          <MainMenu>
            <MainMenu.DefaultItems.SearchMenu />
            <MainMenu.DefaultItems.Help />
            <MainMenu.DefaultItems.ClearCanvas />
            <MainMenu.Separator />
            <MainMenu.DefaultItems.ChangeCanvasBackground />
          </MainMenu>
        </Excalidraw>
      </div>
    </div>
  )
}
