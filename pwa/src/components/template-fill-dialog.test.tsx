import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PromptTemplate } from '../hooks/use-mux-api'
import { takeDraftInsert } from '../utils/chat-draft'
import { remapPanes } from '../utils/pane-remap'
import { MAX_TEMPLATE_TEXT } from '../utils/prompt-templates'
import type { TemplateValues } from '../utils/resolve-template-vars'
import { requestTemplateFill } from '../utils/template-fill-request'
import { type FillPane, TemplateFillDialog } from './template-fill-dialog'

const store = vi.hoisted(() => ({
  templates: [] as PromptTemplate[],
  refresh: vi.fn(async () => {}),
}))
vi.mock('../hooks/use-prompt-templates', () => ({
  templateById: (id: string) =>
    store.templates.find((t) => t.id === id) ?? null,
  refreshTemplates: store.refresh,
}))
const vars = vi.hoisted(() => ({
  known: {} as Required<TemplateValues>,
  args: undefined as unknown,
  branch: vi.fn<(paneId: string) => Promise<string>>(),
}))
vi.mock('../utils/resolve-template-vars', () => ({
  knownTemplateValues: (...a: unknown[]) => {
    vars.args = a
    return vars.known
  },
  fetchBranch: (paneId: string) => vars.branch(paneId),
}))

const none = { value: '', source: '' }
const tpl = (id: string, text: string, name = 'Review') =>
  ({ id, name, text, updated: 'u' }) as PromptTemplate

function renderDialog(pane: FillPane | null = { agent: 'claude' }) {
  const notify = vi.fn()
  const props = {
    pane: vi.fn((_: string) => pane),
    terminalText: vi.fn((p: string) => (p === '1' ? 'live' : '')),
    notify,
  }
  const view = render(<TemplateFillDialog {...props} />)
  return { ...view, ...props }
}

const pick = (
  templateId: string,
  at?: { start: number; end: number; was: string },
) =>
  act(() =>
    requestTemplateFill({ paneId: '1', templateId, agent: 'claude', at }),
  )

describe('TemplateFillDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    takeDraftInsert('1', 'claude')
    HTMLDialogElement.prototype.showModal = vi.fn(function (
      this: HTMLDialogElement,
    ) {
      this.setAttribute('open', '')
    })
    HTMLDialogElement.prototype.close = vi.fn()
    vars.known = {
      file: { value: 'src/a.ts', source: 'chat.fill.from.file' },
      selection: none,
      branch: none,
      input: none,
    }
    vars.branch.mockResolvedValue('main')
    store.templates = [
      tpl('plain', 'Just text'),
      tpl('full', 'Review {{file}} on {{branch}}: {{input}}\n{{selection}}'),
      tpl('file', 'See {{file}}', 'File\u202e'),
    ]
  })

  it('puts a template without variables in the draft at once', () => {
    renderDialog()
    pick('plain', { start: 0, end: 4, was: '/rev' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(takeDraftInsert('1', 'claude')).toEqual({
      text: 'Just text',
      at: { start: 0, end: 4, was: '/rev' },
    })
  })

  it('a template deleted elsewhere says so and reads them again', () => {
    const { notify } = renderDialog()
    pick('gone')
    expect(notify).toHaveBeenCalledWith(
      'This template was deleted on another device',
    )
    expect(store.refresh).toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('fills the variables, reads the branch, and inserts without sending', async () => {
    let answer!: (b: string) => void
    vars.branch.mockReturnValue(new Promise((r) => (answer = r)))
    const { pane, terminalText } = renderDialog({
      agent: 'claude',
      branch: 'wt',
    })
    pick('full')
    expect(pane).toHaveBeenCalledWith('1')
    expect(terminalText).toHaveBeenCalledWith('1')
    expect(vars.args).toEqual([
      '1',
      { terminalText: 'live', worktreeBranch: 'wt' },
    ])
    expect(screen.getByRole('dialog', { name: 'Insert Review' })).toBeVisible()
    // Your text first, focused; then the template's order
    const fields = screen.getAllByRole('textbox')
    expect(fields.map((f) => f.getAttribute('id')?.split('-').pop())).toEqual([
      'input',
      'file',
      'branch',
      'selection',
    ])
    const input = screen.getByLabelText(/Your text/)
    expect(input).toHaveFocus()
    expect(screen.getByLabelText(/^File /)).toHaveValue('src/a.ts')
    expect(screen.getByText('From the file shown')).toBeInTheDocument()
    expect(
      screen.getByText('Nothing found: type it or leave it empty'),
    ).toBeInTheDocument()
    expect(screen.getByLabelText(/Branch/)).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByText('Reading the branch…')).toBeInTheDocument()
    await act(async () => answer('main'))
    expect(screen.getByLabelText(/Branch/)).toHaveValue('main')
    expect(screen.getByText('From git')).toBeInTheDocument()

    fireEvent.change(input, { target: { value: 'be brief $&' } })
    expect(screen.getByTestId('template-preview')).toHaveTextContent(
      'Review src/a.ts on main: be brief $&',
    )
    expect(screen.getByText('1 KB of 16 KB')).toBeInTheDocument()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.getByRole('dialog')).toBeVisible()
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(takeDraftInsert('1', 'claude')).toEqual({
      text: 'Review src/a.ts on main: be brief $&\n',
      at: undefined,
    })
  })

  it('a branch read after the user typed one keeps theirs; none found stays empty', async () => {
    let answer!: (b: string) => void
    vars.branch.mockReturnValue(new Promise((r) => (answer = r)))
    renderDialog()
    pick('full')
    fireEvent.change(screen.getByLabelText(/Branch/), {
      target: { value: 'mine' },
    })
    await act(async () => answer('main'))
    expect(screen.getByLabelText(/Branch/)).toHaveValue('mine')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    vars.branch.mockResolvedValue('')
    pick('full')
    await act(async () => {})
    expect(screen.getByLabelText(/Branch/)).toHaveValue('')
    expect(
      screen.getAllByText('Nothing found: type it or leave it empty'),
    ).toHaveLength(2)
  })

  it('a branch read that ends after Cancel lands nowhere', async () => {
    let answer!: (b: string) => void
    vars.branch.mockReturnValue(new Promise((r) => (answer = r)))
    renderDialog()
    pick('full')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await act(async () => answer('main'))
    expect(screen.queryByRole('dialog')).toBeNull()
    // No text; the focus, gone nowhere, back to the message box
    expect(takeDraftInsert('1', 'claude')).toBeNull()
  })

  it('closed with the focus somewhere, leaves it there', () => {
    const other = document.createElement('button')
    document.body.append(other)
    other.focus()
    renderDialog()
    pick('file')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(other).toHaveFocus()
    expect(takeDraftInsert('1', 'claude')).toBeUndefined()
    other.remove()
  })

  it('a field the user changed no longer names a source; a late branch leaves it', async () => {
    let answer!: (b: string) => void
    vars.branch.mockReturnValue(new Promise((r) => (answer = r)))
    renderDialog()
    pick('full')
    fireEvent.change(screen.getByLabelText(/^File /), { target: { value: '' } })
    expect(screen.queryByText('From the file shown')).toBeNull()
    fireEvent.change(screen.getByLabelText(/Branch/), {
      target: { value: 'x' },
    })
    fireEvent.change(screen.getByLabelText(/Branch/), { target: { value: '' } })
    await act(async () => answer('main'))
    expect(screen.getByLabelText(/Branch/)).toHaveValue('')
    expect(
      screen.getAllByText('Nothing found: type it or leave it empty'),
    ).toHaveLength(1)
  })

  it('a known branch needs no read; Enter in a field inserts', () => {
    vars.known = {
      ...vars.known,
      branch: { value: 'dev', source: 'chat.fill.from.worktree' },
    }
    renderDialog()
    pick('full')
    expect(vars.branch).not.toHaveBeenCalled()
    expect(screen.getByText('From the worktree')).toBeInTheDocument()
    fireEvent.submit(screen.getByLabelText(/Branch/))
    expect(takeDraftInsert('1', 'claude')).toMatchObject({
      text: expect.stringContaining('on dev'),
    })
  })

  it('names a source it does not know by itself; shows hidden characters', () => {
    vars.known = { ...vars.known, file: { value: 'x', source: 'src/b.ts' } }
    renderDialog()
    pick('file')
    expect(
      screen.getByRole('dialog', { name: 'Insert File⟨U+202E⟩' }),
    ).toBeVisible()
    expect(screen.getByText('From src/b.ts')).toBeInTheDocument()
    expect(screen.getByLabelText(/^File /)).toHaveFocus()
  })

  it('warns when the text is longer than a message', () => {
    vars.known = {
      ...vars.known,
      file: {
        value: 'x'.repeat(MAX_TEMPLATE_TEXT),
        source: 'chat.fill.from.file',
      },
    }
    renderDialog()
    pick('file')
    expect(
      screen.getByText(/17 KB of 16 KB: shorten it before sending/),
    ).toHaveClass('text-danger')
  })

  it('closes when its pane moves, goes, or runs another agent', () => {
    const { rerender, pane, terminalText, notify } = renderDialog()
    pick('file')
    act(() =>
      remapPanes({ moved: new Map([['2', '3']]), stale: new Set(['2', '3']) }),
    )
    expect(screen.getByRole('dialog')).toBeVisible()
    act(() => remapPanes({ moved: new Map(), stale: new Set(['1']) }))
    expect(screen.queryByRole('dialog')).toBeNull()
    act(() => remapPanes({ moved: new Map(), stale: new Set(['1']) }))

    pick('file')
    pane.mockReturnValue({ agent: 'codex' })
    rerender(
      <TemplateFillDialog
        pane={pane}
        terminalText={terminalText}
        notify={notify}
      />,
    )
    expect(screen.queryByRole('dialog')).toBeNull()

    pane.mockReturnValue({ agent: 'claude' })
    pick('file')
    pane.mockReturnValue(null)
    rerender(
      <TemplateFillDialog
        pane={pane}
        terminalText={terminalText}
        notify={notify}
      />,
    )
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(takeDraftInsert('1', 'claude')).toBeUndefined()
  })

  it('takes a pick made before it mounted', () => {
    pick('plain')
    renderDialog()
    expect(takeDraftInsert('1', 'claude')).toEqual({
      text: 'Just text',
      at: undefined,
    })
  })
})
