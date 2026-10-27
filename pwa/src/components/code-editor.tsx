import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  isolateHistory,
} from '@codemirror/commands'
import {
  bracketMatching,
  indentOnInput,
  indentUnit,
} from '@codemirror/language'
import {
  gotoLine,
  highlightSelectionMatches,
  openSearchPanel,
  search,
  searchKeymap,
} from '@codemirror/search'
import {
  Annotation,
  Compartment,
  EditorState,
  type Extension,
  Prec,
  Transaction,
} from '@codemirror/state'
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from '@codemirror/view'
import { type RefObject, useEffect, useLayoutEffect, useRef } from 'react'
import { useTheme } from '../contexts/theme-context'
import type { SyncSide } from '../hooks/use-scroll-sync'
import { useSettings } from '../hooks/use-settings'
import { loadLanguage } from '../utils/cm-languages'
import { baseTheme, darkCode, lightCode } from '../utils/cm-theme'
import { HIGHLIGHT_MAX_LINE } from '../utils/highlight'
import { languageFor } from '../utils/highlight-langs'
import { selectedLines, type TextLines } from '../utils/line-range'
import type { PasteEdit } from '../utils/markdown-image-paste'
import { imageFromClipboard } from '../utils/upload-image'

// Where the editor opens a file, or moves to: a line (1-based) and a column
// (UTF-16, 0-based), again each time jump changes
export interface EditorAt {
  line: number
  col?: number
  jump: number
}

export interface CodeEditorProps {
  path: string
  text: string
  onChange: (text: string) => void
  wrap: boolean
  saving: boolean
  // Ctrl+S (and :w in Vim) saves only when this is true (something to save,
  // not saving, the root did not move)
  canSave: boolean
  onSave: () => void
  notify: (message: string) => void
  // A sensitive file the user chose to show: what Vim kept of it (its
  // registers, its search history) is dropped when the editor closes
  reveal?: boolean
  // Text the user selected; the editor's DOM holds only the lines on screen,
  // so a page's selection would miss the rest
  onSelectText?: (text: string) => void
  // Where it starts scrolled to (a tab shown again)
  scrollTop?: number
  at?: EditorAt
  // Set to what reads the whole lines of the main selection (the cursor's
  // line without one), for a review comment
  linesRef?: RefObject<(() => TextLines) | null>
  // Out of sight for now, kept mounted: measured again once it shows
  hidden?: boolean
  // Given how to read and set the line at its top (a Markdown draft's
  // preview scrolls with it); null once the editor is gone
  onSyncSide?: (side: SyncSide | null) => void
  // An image pasted (alone: a paste with text is text): edit puts text at
  // the cursor, then replaces it (pasteEdit)
  onPasteImage?: (file: File, edit: PasteEdit) => void
}

// Marks a change made from the props, which onChange is not told about
const external = Annotation.define<boolean>()

// Ctrl+H opens the search panel with its replace field focused
function openReplace(view: EditorView): boolean {
  openSearchPanel(view)
  view.dom.querySelector<HTMLInputElement>('.cm-search [name=replace]')?.focus()
  return true
}

type VimModule = typeof import('@replit/codemirror-vim')

// What :w does in each editor: Vim's ex commands are global, shared by every
// editor open (Files and Changes)
const vimSaves = new WeakMap<EditorView, () => void>()
let vimLoad: Promise<VimModule> | undefined
// Vim once loaded
let vimModule: VimModule | undefined

// Vim mode, loaded the first time it is turned on; a failed load is tried
// again the next time
function loadVim(): Promise<VimModule> {
  vimLoad ??= import('@replit/codemirror-vim').then(
    (m) => {
      m.Vim.defineEx('write', 'w', (cm: { cm6: EditorView }) =>
        vimSaves.get(cm.cm6)?.(),
      )
      vimModule = m
      return m
    },
    (error: unknown) => {
      vimLoad = undefined
      throw error
    },
  )
  return vimLoad
}

// The indent unit of a file: a tab when most of its indented lines start with
// one, else size spaces
export function indentOf(text: string, size: number): string {
  let tabs = 0
  let spaces = 0
  for (const line of text.split('\n')) {
    if (line.startsWith('\t')) tabs++
    else if (line.startsWith(' ')) spaces++
  }
  return tabs > spaces ? '\t' : ' '.repeat(size)
}

function tabsOf(text: string, size: number): Extension {
  return [EditorState.tabSize.of(size), indentUnit.of(indentOf(text, size))]
}

function fontSizeOf(size: number): Extension {
  return EditorView.theme({ '&': { fontSize: `${size}px` } })
}

function labelOf(path: string): Extension {
  return EditorView.contentAttributes.of({
    'aria-label': `Text of ${path}`,
    'aria-multiline': 'true',
  })
}

// Vim leaves Escape to the page: a maximized panel would be restored by the
// Escape that leaves insert mode. Listened to while bubbling, so Vim (on the
// content) has seen the key first.
function stopEscape(e: KeyboardEvent) {
  if (e.key === 'Escape') e.stopPropagation()
}

// The position of line:col in the text, kept inside it
function positionOf(state: EditorState, at: EditorAt): number {
  const n = Math.min(Math.max(at.line, 1), state.doc.lines)
  const line = state.doc.line(n)
  return line.from + Math.min(Math.max(at.col ?? 0, 0), line.length)
}

// The editing a pasted image gets, while live() says the editor is there:
// text in place of the selection, a change the user can undo; then that text
// swapped for other, the swap alone in the history (the text it replaces
// leaves outside it). Undo then takes out the image's link, and the cursor
// and the edits made meanwhile stay where they are.
function pasteEdit(v: EditorView, live: () => boolean): PasteEdit {
  return {
    insert: (text) =>
      v.dispatch(v.state.replaceSelection(text), {
        userEvent: 'input.paste',
        scrollIntoView: true,
      }),
    replace: (find, with_) => {
      const at = live() ? v.state.doc.toString().indexOf(find) : -1
      if (at < 0) return false
      v.dispatch({
        changes: { from: at, to: at + find.length },
        annotations: Transaction.addToHistory.of(false),
      })
      if (with_)
        v.dispatch({
          changes: { from: at, insert: with_ },
          userEvent: 'input.paste',
          annotations: isolateHistory.of('full'),
        })
      return true
    },
  }
}

function reconfigure(
  view: EditorView | null,
  part: Compartment,
  value: Extension,
) {
  view?.dispatch({ effects: part.reconfigure(value) })
}

// The text of a file being edited, in CodeMirror: line numbers, syntax
// colors, search and replace, go to line, several cursors, Vim when the user
// turns it on. Loaded in a chunk of its own the first time a file is edited
// on a device with a fine pointer. Its text is the draft's: "\n" line breaks,
// as the textarea gives (the server writes a CRLF file back with "\r\n").
export default function CodeEditor({
  path,
  text,
  onChange,
  wrap,
  saving,
  canSave,
  onSave,
  notify,
  reveal,
  onSelectText,
  scrollTop,
  at,
  linesRef,
  hidden = false,
  onSyncSide,
  onPasteImage,
}: CodeEditorProps) {
  const { settings } = useSettings()
  const { editorFontSize, editorTabSize, editorVim } = settings
  const { resolvedTheme } = useTheme()
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView>(null)
  // The latest props, read by the key bindings, the listener and the effects
  // that run later, so the editor never has to be configured again for them
  const latest = useRef({
    onChange,
    onSave,
    canSave,
    notify,
    text,
    reveal,
    onSelectText,
    hidden,
    onPasteImage,
  })
  latest.current = {
    onChange,
    onSave,
    canSave,
    notify,
    text,
    reveal,
    onSelectText,
    hidden,
    onPasteImage,
  }
  // What the editor told onChange last: a render with it is no change
  const lastEmitted = useRef(text)
  const parts = useRef({
    label: new Compartment(),
    readOnly: new Compartment(),
    wrap: new Compartment(),
    language: new Compartment(),
    colors: new Compartment(),
    fontSize: new Compartment(),
    tabs: new Compartment(),
    vim: new Compartment(),
  })

  // biome-ignore lint/correctness/useExhaustiveDependencies: created once; props after that reconfigure it
  useLayoutEffect(() => {
    const c = parts.current
    const save = () => {
      if (latest.current.canSave) latest.current.onSave()
    }
    const extensions: Extension[] = [
      c.vim.of([]),
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      bracketMatching(),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      search({ top: true }),
      // The real Ctrl key on every system: Cmd+G stays find next on macOS
      // and Cmd+H hides the browser there
      Prec.high(
        keymap.of([
          { key: 'Ctrl-g', run: gotoLine, preventDefault: true },
          { key: 'Ctrl-h', run: openReplace, preventDefault: true },
          { mac: 'Mod-Alt-f', run: openReplace, preventDefault: true },
        ]),
      ),
      keymap.of([
        ...searchKeymap,
        ...historyKeymap,
        ...defaultKeymap,
        indentWithTab,
      ]),
      EditorView.domEventHandlers({
        paste: (e, v) => {
          const paste = latest.current.onPasteImage
          const file = paste && imageFromClipboard(e.clipboardData)
          if (!paste || !file) return false
          e.preventDefault()
          paste(
            file,
            pasteEdit(v, () => v === view.current),
          )
          return true
        },
      }),
      baseTheme,
      c.fontSize.of(fontSizeOf(editorFontSize)),
      c.tabs.of(tabsOf(text, editorTabSize)),
      c.colors.of(resolvedTheme === 'dark' ? darkCode : lightCode),
      c.language.of([]),
      c.label.of(labelOf(path)),
      c.readOnly.of(EditorState.readOnly.of(saving)),
      c.wrap.of(wrap ? EditorView.lineWrapping : []),
      EditorView.updateListener.of((u) => {
        if (!u.docChanged) return
        // A text set from the props is not the user's
        if (u.transactions.every((t) => t.annotation(external))) return
        const next = u.state.doc.toString()
        lastEmitted.current = next
        latest.current.onChange(next)
      }),
      // Apart from the one above, which leaves out a change of selection alone
      EditorView.updateListener.of((u) => {
        // A selection moved by a text set from the props is not the user's
        if (
          !u.selectionSet ||
          u.transactions.some((t) => t.annotation(external))
        )
          return
        const { from, to } = u.state.selection.main
        if (from !== to)
          latest.current.onSelectText?.(u.state.sliceDoc(from, to))
      }),
    ]
    const v = new EditorView({
      parent: host.current as HTMLDivElement,
      state: EditorState.create({ doc: text, extensions }),
    })
    view.current = v
    vimSaves.set(v, save)
    // Ctrl/Cmd+S saves wherever the focus is in the editor: the text, the
    // search panel, go to line, Vim's command line. Caught before any of
    // them, never reaching the browser's Save page.
    const onSaveKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        save()
      }
    }
    v.dom.addEventListener('keydown', onSaveKey, true)
    // Scrolled back to where it was left (unless it opens at a line); the
    // viewer is told about scrolling only after that, so the scroll to the
    // top while mounting is not kept
    v.requestMeasure({
      read: () => null,
      write: () => {
        // Hidden, it has no height to scroll: done once it shows
        if (scrollTop && !at && !latest.current.hidden)
          v.scrollDOM.scrollTop = scrollTop
        v.scrollDOM.dataset.scrollRestore = ''
      },
    })
    return () => {
      v.dom.removeEventListener('keydown', onSaveKey, true)
      v.destroy()
      view.current = null
      // Vim's registers and histories outlive the editor: a sensitive file's
      // text is not left in them
      if (latest.current.reveal) vimModule?.Vim.resetVimGlobalState_()
    }
  }, [])

  useEffect(() => {
    if (!linesRef) return
    linesRef.current = () => {
      const state = (view.current as EditorView).state
      const { from, to } = state.selection.main
      return selectedLines(state.doc.toString(), from, to)
    }
    return () => {
      linesRef.current = null
    }
  }, [linesRef])

  // The draft changed elsewhere (Reload, a save rebased it, another view of
  // the pane edited it): the editor shows it, kept out of the undo history.
  // What the editor itself sent is its text already. Before paint, so a key
  // typed meanwhile lands on the new text.
  useLayoutEffect(() => {
    if (text === lastEmitted.current) return
    lastEmitted.current = text
    const v = view.current as EditorView
    const { main } = v.state.selection
    v.dispatch({
      changes: { from: 0, to: v.state.doc.length, insert: text },
      selection: {
        anchor: Math.min(main.anchor, text.length),
        head: Math.min(main.head, text.length),
      },
      annotations: [external.of(true), Transaction.addToHistory.of(false)],
    })
  }, [text])

  // Colored once its language is loaded; a file with a very long line stays
  // plain (a legacy mode is slow on one)
  useEffect(() => {
    let live = true
    const long = latest.current.text
      .split('\n')
      .some((l) => l.length > HIGHLIGHT_MAX_LINE)
    if (!long)
      loadLanguage(languageFor(path)).then((lang) => {
        if (live && lang)
          reconfigure(view.current, parts.current.language, lang)
      })
    return () => {
      live = false
    }
  }, [path])

  useEffect(() => {
    if (!editorVim) return
    const v = view.current as EditorView
    let live = true
    loadVim().then(
      (m) => {
        if (!live) return
        reconfigure(v, parts.current.vim, Prec.highest(m.vim({ status: true })))
        v.dom.addEventListener('keydown', stopEscape)
      },
      () => {
        if (live) latest.current.notify('Could not load Vim mode')
      },
    )
    return () => {
      live = false
      v.dom.removeEventListener('keydown', stopEscape)
      reconfigure(view.current, parts.current.vim, [])
    }
  }, [editorVim])

  // Opens at, or moves to, a line: the cursor there, the line in the middle
  // biome-ignore lint/correctness/useExhaustiveDependencies: again each time it jumps
  useEffect(() => {
    const v = view.current as EditorView
    if (!at) return
    const pos = positionOf(v.state, at)
    v.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: 'center' }),
    })
    v.focus()
  }, [at?.jump, at?.line, at?.col])

  // Lines by their height in the document, which starts below the scroll
  // box's padding
  // biome-ignore lint/correctness/useExhaustiveDependencies: given once, for the editor's life
  useEffect(() => {
    if (!onSyncSide) return
    const v = view.current as EditorView
    const box = v.scrollDOM
    // Where the document starts in the scroll box's content
    const docTop = () =>
      v.documentTop - box.getBoundingClientRect().top + box.scrollTop
    onSyncSide({
      el: box,
      topLine: () => {
        // Brings CodeMirror's measure up to date first: it may move the
        // document (a scroll restored) as it measures
        v.lineBlockAtHeight(0)
        const h = Math.max(box.scrollTop - docTop(), 0)
        const block = v.lineBlockAtHeight(h)
        const into = block.height ? (h - block.top) / block.height : 0
        return (
          v.state.doc.lineAt(block.from).number +
          Math.min(Math.max(into, 0), 0.99)
        )
      },
      scrollToLine: (line) => {
        const doc = v.state.doc
        const n = Math.min(Math.max(Math.floor(line), 1), doc.lines)
        const block = v.lineBlockAt(doc.line(n).from)
        // Past the last line: at its top
        const into = line >= n + 1 ? 0 : Math.max(line - n, 0)
        box.scrollTop = docTop() + block.top + into * block.height
      },
    })
    return () => onSyncSide(null)
  }, [])

  // Opened hidden: where it starts (the offset it was left at, or the line
  // it opens at) waits until it shows
  const pending = useRef(hidden ? { scrollTop, at: !!at } : undefined)
  // Its size and line heights read while it was hidden are wrong
  useEffect(() => {
    if (hidden) return
    const v = view.current as EditorView
    const start = pending.current
    pending.current = undefined
    if (start?.at) {
      v.dispatch({
        effects: EditorView.scrollIntoView(v.state.selection.main.head, {
          y: 'center',
        }),
      })
    }
    v.requestMeasure({
      read: () => null,
      write: () => {
        if (start?.scrollTop && !start.at)
          v.scrollDOM.scrollTop = start.scrollTop
      },
    })
  }, [hidden])

  useEffect(() => {
    reconfigure(view.current, parts.current.label, labelOf(path))
  }, [path])
  useEffect(() => {
    reconfigure(
      view.current,
      parts.current.readOnly,
      EditorState.readOnly.of(saving),
    )
  }, [saving])
  useEffect(() => {
    reconfigure(
      view.current,
      parts.current.wrap,
      wrap ? EditorView.lineWrapping : [],
    )
  }, [wrap])
  useEffect(() => {
    reconfigure(
      view.current,
      parts.current.colors,
      resolvedTheme === 'dark' ? darkCode : lightCode,
    )
  }, [resolvedTheme])
  useEffect(() => {
    reconfigure(
      view.current,
      parts.current.fontSize,
      fontSizeOf(editorFontSize),
    )
  }, [editorFontSize])
  useEffect(() => {
    const v = view.current as EditorView
    reconfigure(
      v,
      parts.current.tabs,
      tabsOf(v.state.doc.toString(), editorTabSize),
    )
  }, [editorTabSize])

  return (
    <div
      ref={host}
      aria-busy={saving}
      className="min-h-0 w-full flex-1 overflow-hidden"
    />
  )
}
