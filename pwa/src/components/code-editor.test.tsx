import { undo } from '@codemirror/commands'
import { highlightingFor, indentUnit, language } from '@codemirror/language'
import { EditorView } from '@codemirror/view'
import { tags } from '@lezer/highlight'
import { act, fireEvent, render, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ThemeProvider, useTheme } from '../contexts/theme-context'
import { type Settings, useSettings } from '../hooks/use-settings'
import type { TextLines } from '../utils/line-range'
import CodeEditor, { indentOf } from './code-editor'

// Vim mode is a stand-in: what the editor does with it is tested, not Vim
const vimMock = vi.hoisted(() => ({
  vim: vi.fn(() => []),
  defineEx: vi.fn(),
  reset: vi.fn(),
}))
vi.mock('@replit/codemirror-vim', () => ({
  vim: vimMock.vim,
  Vim: {
    defineEx: vimMock.defineEx,
    resetVimGlobalState_: vimMock.reset,
  },
}))

type Props = ComponentProps<typeof CodeEditor>

// jsdom lays nothing out: CodeMirror measures text ranges when scrolling to
// the cursor
Range.prototype.getClientRects ??= () =>
  Object.assign([], { item: () => null }) as unknown as DOMRectList
Range.prototype.getBoundingClientRect ??= () => new DOMRect()

// The settings and theme setters, reached from a test
const handles: {
  update?: ReturnType<typeof useSettings>['updateSetting']
  setTheme?: ReturnType<typeof useTheme>['setTheme']
} = {}

function Handles() {
  handles.update = useSettings().updateSetting
  handles.setTheme = useTheme().setTheme
  return null
}

function setting<K extends keyof Settings>(key: K, value: Settings[K]) {
  act(() => handles.update?.(key, value))
}

const base = (): Props => ({
  path: 'a.txt',
  text: 'one\ntwo\nthree\n',
  onChange: vi.fn(),
  wrap: false,
  saving: false,
  canSave: true,
  onSave: vi.fn(),
  notify: vi.fn(),
})

function setup(over: Partial<Props> = {}) {
  const props = { ...base(), ...over }
  const ui = (p: Props) => (
    <ThemeProvider>
      <Handles />
      <CodeEditor {...p} />
    </ThemeProvider>
  )
  const r = render(ui(props))
  const content = r.container.querySelector('.cm-content') as HTMLElement
  const view = EditorView.findFromDOM(content) as EditorView
  return {
    ...r,
    props,
    view,
    content,
    rerender: (more: Partial<Props>) => r.rerender(ui({ ...props, ...more })),
  }
}

const frame = () =>
  act(() => new Promise<void>((done) => requestAnimationFrame(() => done())))

beforeEach(() => {
  vimMock.vim.mockClear()
  vimMock.defineEx.mockClear()
  vimMock.reset.mockClear()
})

describe('indentOf', () => {
  it('is a tab when most indented lines start with one', () => {
    expect(indentOf('a\n\tb\n\tc\n  d', 4)).toBe('\t')
    expect(indentOf('a\n\tb\n  c\n  d', 2)).toBe('  ')
    expect(indentOf('no indent', 8)).toBe('        ')
  })
})

describe('CodeEditor', () => {
  it('opened hidden, goes to where it was left once it shows', async () => {
    const { view, rerender } = setup({ hidden: true, scrollTop: 40 })
    await frame()
    expect(view.scrollDOM.scrollTop).toBe(0)
    rerender({ hidden: false, scrollTop: 40 })
    await frame()
    expect(view.scrollDOM.scrollTop).toBe(40)
    // Only the first time it shows
    view.scrollDOM.scrollTop = 5
    rerender({ hidden: true, scrollTop: 40 })
    rerender({ hidden: false, scrollTop: 40 })
    await frame()
    expect(view.scrollDOM.scrollTop).toBe(5)
  })

  it('opened hidden at a line, brings the line into view once it shows', () => {
    const at = { line: 2, jump: 1 }
    const { view, rerender } = setup({ hidden: true, at })
    const dispatch = vi.spyOn(view, 'dispatch')
    rerender({ hidden: false, at })
    expect(dispatch).toHaveBeenCalledWith({ effects: expect.anything() })
    expect(view.state.selection.main.head).toBe(4)
  })

  it('measures itself again once it shows after being hidden', () => {
    const { view, rerender } = setup({ hidden: true })
    const measure = vi.spyOn(view, 'requestMeasure')
    rerender({ hidden: true })
    expect(measure).not.toHaveBeenCalled()
    rerender({ hidden: false })
    expect(measure).toHaveBeenCalledTimes(1)
  })

  it('is labeled like the textarea and sends what is typed with "\\n"', () => {
    const { view, content, props } = setup()
    expect(content).toHaveAttribute('aria-label', 'Text of a.txt')
    expect(content).toHaveAttribute('aria-multiline', 'true')
    expect(content).toHaveAttribute('role', 'textbox')
    view.dispatch({ changes: { from: 0, insert: 'x\r\n' } })
    expect(props.onChange).toHaveBeenCalledWith('x\none\ntwo\nthree\n')
  })

  it('tells a selection, even one that changes no text', () => {
    const onSelectText = vi.fn()
    const { view } = setup({ onSelectText })
    view.dispatch({ selection: { anchor: 0, head: 3 } })
    expect(onSelectText).toHaveBeenCalledWith('one')
    // A cursor moved: no text
    view.dispatch({ selection: { anchor: 5 } })
    // A change that keeps the selection where it is
    view.dispatch({ changes: { from: 0, insert: 'x' } })
    expect(onSelectText).toHaveBeenCalledTimes(1)
    // Without a listener, nothing breaks
    setup().view.dispatch({ selection: { anchor: 0, head: 3 } })
  })

  it('a text set from the props selects nothing for the user', () => {
    const onSelectText = vi.fn()
    const { view, rerender } = setup({ onSelectText })
    view.dispatch({ selection: { anchor: 0, head: 3 } })
    onSelectText.mockClear()
    rerender({ onSelectText, text: 'ABCDEF\n' })
    expect(view.state.doc.toString()).toBe('ABCDEF\n')
    expect(onSelectText).not.toHaveBeenCalled()
  })

  it('shows a text changed elsewhere without telling onChange, out of undo', () => {
    const { view, props, rerender } = setup()
    view.dispatch({
      changes: { from: 0, insert: 'x' },
      selection: { anchor: 14 },
    })
    expect(props.onChange).toHaveBeenCalledTimes(1)
    // The text it just sent is no change
    rerender({ text: 'xone\ntwo\nthree\n' })
    expect(view.state.doc.toString()).toBe('xone\ntwo\nthree\n')
    // A shorter text from elsewhere: the cursor stays inside it
    rerender({ text: 'new' })
    expect(view.state.doc.toString()).toBe('new')
    expect(view.state.selection.main.head).toBe(3)
    expect(props.onChange).toHaveBeenCalledTimes(1)
    // Undo takes back the user's typing, not the text set from outside
    undo(view)
    expect(view.state.doc.toString()).toBe('new')
  })

  it('renames its label with the path', () => {
    const { content, rerender } = setup()
    rerender({ path: 'b.txt' })
    expect(content).toHaveAttribute('aria-label', 'Text of b.txt')
  })

  it('Ctrl+S saves only when it can, and never reaches the browser', () => {
    const onSave = vi.fn()
    const { content, rerender } = setup({ onSave, canSave: false })
    expect(fireEvent.keyDown(content, { key: 's', ctrlKey: true })).toBe(false)
    expect(onSave).not.toHaveBeenCalled()
    rerender({ canSave: true })
    fireEvent.keyDown(content, { key: 's', ctrlKey: true })
    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it('Ctrl/Cmd+S saves from the search panel too', () => {
    const onSave = vi.fn()
    const { content, container } = setup({ onSave })
    fireEvent.keyDown(content, { key: 'h', ctrlKey: true })
    const replace = container.querySelector(
      '.cm-search [name=replace]',
    ) as Element
    expect(fireEvent.keyDown(replace, { key: 'S', metaKey: true })).toBe(false)
    expect(onSave).toHaveBeenCalledTimes(1)
    // Another key with Ctrl, or s alone, is not a save
    fireEvent.keyDown(replace, { key: 'a', ctrlKey: true })
    fireEvent.keyDown(replace, { key: 's' })
    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it('Ctrl+F finds, Ctrl+H replaces, Ctrl+G goes to a line', () => {
    const { content, container } = setup()
    fireEvent.keyDown(content, { key: 'f', ctrlKey: true })
    // Focused by select(), which jsdom does not do
    const find = container.querySelector('.cm-search [name=search]')
    expect(find).not.toBeNull()
    // Escape closes it, and is used up: a maximized panel stays
    expect(fireEvent.keyDown(find as Element, { key: 'Escape' })).toBe(false)
    expect(container.querySelector('.cm-search')).toBeNull()

    fireEvent.keyDown(content, { key: 'h', ctrlKey: true })
    expect(document.activeElement).toBe(
      container.querySelector('.cm-search [name=replace]'),
    )

    fireEvent.keyDown(content, { key: 'g', ctrlKey: true })
    expect(container.querySelector('.cm-goto-line')).not.toBeNull()
  })

  it('is read-only while saving, and says so', () => {
    const { view, container, rerender } = setup({ saving: true })
    expect(view.state.readOnly).toBe(true)
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull()
    rerender({ saving: false })
    expect(view.state.readOnly).toBe(false)
  })

  it('wraps lines as asked', () => {
    const { content, rerender } = setup({ wrap: true })
    expect(content).toHaveClass('cm-lineWrapping')
    rerender({ wrap: false })
    expect(content).not.toHaveClass('cm-lineWrapping')
  })

  it('starts where it was scrolled, then marks itself for the viewer', async () => {
    const { view } = setup({ scrollTop: 33 })
    expect(view.scrollDOM.dataset.scrollRestore).toBeUndefined()
    await frame()
    expect(view.scrollDOM.scrollTop).toBe(33)
    expect(view.scrollDOM.dataset.scrollRestore).toBe('')
  })

  it('starts at the top without an offset', async () => {
    const { view } = setup()
    await frame()
    expect(view.scrollDOM.scrollTop).toBe(0)
    expect(view.scrollDOM.dataset.scrollRestore).toBe('')
  })

  it('colors the file once its language is loaded', async () => {
    const { view } = setup({ path: 'a.json', text: '{"a": 1}' })
    await waitFor(() => expect(view.state.facet(language)?.name).toBe('json'))
  })

  it('leaves a file of no language, or with a very long line, plain', async () => {
    const plain = setup({ path: 'a.txt' })
    const long = setup({ path: 'b.json', text: `{"a": "${'x'.repeat(2001)}"}` })
    await frame()
    expect(plain.view.state.facet(language)).toBeNull()
    expect(long.view.state.facet(language)).toBeNull()
  })

  it('drops a language loaded after it closed', async () => {
    const { unmount, view } = setup({ path: 'c.go', text: 'package a' })
    unmount()
    await frame()
    expect(view.state.facet(language)).toBeNull()
  })

  it('follows the light and dark themes', () => {
    const { view } = setup()
    const keyword = () => highlightingFor(view.state, [tags.keyword])
    const light = keyword()
    act(() => handles.setTheme?.('dark'))
    expect(keyword()).not.toBe(light)
    act(() => handles.setTheme?.('light'))
    expect(keyword()).toBe(light)
  })

  it('opens in the dark theme when that is the one in use', () => {
    localStorage.setItem('termote-theme', 'dark')
    const { view } = setup()
    const dark = highlightingFor(view.state, [tags.keyword])
    act(() => handles.setTheme?.('light'))
    expect(highlightingFor(view.state, [tags.keyword])).not.toBe(dark)
  })

  it('takes the font size and tab size from the settings, live', () => {
    const { view } = setup({ text: 'a\n\tb\n\tc\n' })
    expect(view.state.tabSize).toBe(4)
    expect(view.state.facet(indentUnit)).toBe('\t')
    const classes = view.dom.className
    setting('editorFontSize', 16)
    expect(view.dom.className).not.toBe(classes)
    setting('editorTabSize', 8)
    expect(view.state.tabSize).toBe(8)
  })

  it('opens at a line and column, kept inside the text, again on each jump', () => {
    const { view, rerender } = setup({ at: { line: 2, col: 1, jump: 1 } })
    expect(view.state.selection.main.head).toBe(5)
    expect(view.hasFocus).toBe(true)
    view.dispatch({ selection: { anchor: 0 } })
    rerender({ at: { line: 2, col: 1, jump: 2 } })
    expect(view.state.selection.main.head).toBe(5)
    rerender({ at: { line: 99, col: 99, jump: 3 } })
    expect(view.state.selection.main.head).toBe(14)
    rerender({ at: { line: 0, jump: 4 } })
    expect(view.state.selection.main.head).toBe(0)
  })

  it('opening at a line wins over the offset it was left at', async () => {
    const { view } = setup({ scrollTop: 33, at: { line: 1, jump: 1 } })
    await frame()
    expect(view.scrollDOM.scrollTop).toBe(0)
  })
})

describe('CodeEditor Vim mode', () => {
  it('is loaded when turned on, :w saves when it can, and off removes it', async () => {
    setting('editorVim', false)
    const onSave = vi.fn()
    const { view, rerender } = setup({ onSave })
    expect(vimMock.vim).not.toHaveBeenCalled()
    setting('editorVim', true)
    await waitFor(() => expect(vimMock.vim).toHaveBeenCalled())
    // :w is defined once, for every editor
    expect(vimMock.defineEx).toHaveBeenCalledTimes(1)
    const write = vimMock.defineEx.mock.calls[0][2] as (cm: {
      cm6: unknown
    }) => void
    write({ cm6: view })
    expect(onSave).toHaveBeenCalledTimes(1)
    rerender({ canSave: false })
    write({ cm6: view })
    // An editor already closed
    write({ cm6: {} })
    expect(onSave).toHaveBeenCalledTimes(1)
    setting('editorVim', false)
    setting('editorVim', true)
    await waitFor(() => expect(vimMock.vim).toHaveBeenCalledTimes(2))
    expect(vimMock.defineEx).toHaveBeenCalledTimes(1)
    setting('editorVim', false)
  })

  it('keeps Escape from the page while on', async () => {
    setting('editorVim', true)
    const { content } = setup()
    await waitFor(() => expect(vimMock.vim).toHaveBeenCalled())
    const seen = vi.fn()
    document.addEventListener('keydown', seen)
    fireEvent.keyDown(content, { key: 'Escape' })
    expect(seen).not.toHaveBeenCalled()
    fireEvent.keyDown(content, { key: 'a' })
    expect(seen).toHaveBeenCalledTimes(1)
    setting('editorVim', false)
    fireEvent.keyDown(content, { key: 'Escape' })
    expect(seen).toHaveBeenCalledTimes(2)
    document.removeEventListener('keydown', seen)
  })

  it('is not applied when turned off before it loaded', async () => {
    setting('editorVim', false)
    setup()
    setting('editorVim', true)
    setting('editorVim', false)
    await frame()
    expect(vimMock.vim).not.toHaveBeenCalled()
  })

  it("drops Vim's registers when a shown sensitive file closes", async () => {
    setting('editorVim', true)
    const shown = setup({ reveal: true })
    await waitFor(() => expect(vimMock.vim).toHaveBeenCalled())
    const plain = setup()
    plain.unmount()
    expect(vimMock.reset).not.toHaveBeenCalled()
    shown.unmount()
    expect(vimMock.reset).toHaveBeenCalledTimes(1)
    setting('editorVim', false)
  })
})

describe('CodeEditor lines for a comment', () => {
  it('reads the whole lines of the main selection, the cursor line without one', () => {
    const linesRef: { current: (() => TextLines) | null } = { current: null }
    const { view, unmount } = setup({ linesRef })
    view.dispatch({ selection: { anchor: 5, head: 9 } })
    expect(linesRef.current?.()).toEqual({
      from: 2,
      to: 3,
      lines: ['two', 'three'],
    })
    view.dispatch({ selection: { anchor: 1 } })
    expect(linesRef.current?.()).toEqual({ from: 1, to: 1, lines: ['one'] })
    unmount()
    expect(linesRef.current).toBeNull()
  })
})
