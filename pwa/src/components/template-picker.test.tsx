import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PromptTemplate } from '../hooks/use-mux-api'
import type { TemplatesState } from '../hooks/use-prompt-templates'
import { TemplatePicker } from './template-picker'

const store = vi.hoisted(() => ({
  state: {} as TemplatesState,
  refresh: vi.fn(async () => {}),
}))
vi.mock('../hooks/use-prompt-templates', () => ({
  usePromptTemplates: () => ({ ...store.state, refresh: store.refresh }),
}))

const tpl = (id: string, name: string, text = 'first\nsecond') =>
  ({ id, name, text, updated: 'u' }) as PromptTemplate

function setTemplates(templates: PromptTemplate[], over = {}) {
  store.state = {
    templates,
    readOnly: false,
    loaded: true,
    loading: false,
    error: false,
    ...over,
  }
}

function renderPicker(manage = true) {
  const onManage = manage ? vi.fn() : undefined
  const onPick = vi.fn()
  const onClose = vi.fn()
  const view = render(
    <TemplatePicker
      isOpen
      onClose={onClose}
      onPick={onPick}
      onManage={onManage}
    />,
  )
  return { ...view, onPick, onClose, onManage }
}

const box = () => screen.getByRole('combobox', { name: 'Search templates' })

describe('TemplatePicker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    HTMLDialogElement.prototype.showModal = vi.fn(function (
      this: HTMLDialogElement,
    ) {
      this.setAttribute('open', '')
    })
    HTMLDialogElement.prototype.close = vi.fn()
    setTemplates([tpl('1', 'Code review'), tpl('2', 'Deploy\u202e')])
  })

  it('renders nothing closed', () => {
    const { container } = render(
      <TemplatePicker isOpen={false} onClose={vi.fn()} onPick={vi.fn()} />,
    )
    expect(container).toBeEmptyDOMElement()
    expect(store.refresh).not.toHaveBeenCalled()
  })

  it('reads them again, lists them and finds one by a word', () => {
    const { onPick } = renderPicker()
    expect(store.refresh).toHaveBeenCalledOnce()
    expect(box()).toHaveFocus()
    const options = screen.getAllByRole('option')
    expect(options.map((o) => o.textContent)).toEqual([
      'Code reviewfirst',
      'Deploy⟨U+202E⟩first',
    ])
    expect(box()).toHaveAttribute('aria-activedescendant', options[0].id)
    fireEvent.change(box(), { target: { value: 'rev' } })
    expect(screen.getAllByRole('option')).toHaveLength(1)
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(onPick).toHaveBeenCalledWith(tpl('1', 'Code review'))
  })

  it('moves with the arrows, wrapping; a click or a hover picks', () => {
    const { onPick } = renderPicker()
    const options = () => screen.getAllByRole('option')
    fireEvent.keyDown(box(), { key: 'ArrowUp' })
    expect(options()[1]).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(box(), { key: 'ArrowDown' })
    expect(options()[0]).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(box(), { key: 'x' })
    fireEvent.mouseMove(options()[1])
    expect(options()[1]).toHaveAttribute('aria-selected', 'true')
    fireEvent.mouseMove(options()[1])
    const down = new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
    })
    options()[1].dispatchEvent(down)
    expect(down.defaultPrevented).toBe(true)
    fireEvent.click(options()[1])
    expect(onPick).toHaveBeenCalledWith(tpl('2', 'Deploy\u202e'))
  })

  it('says when nothing matches; keys do nothing then', () => {
    const { onPick } = renderPicker()
    fireEvent.change(box(), { target: { value: 'zzz' } })
    expect(screen.getByText('No matching template')).toBeInTheDocument()
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(onPick).not.toHaveBeenCalled()
    expect(box()).not.toHaveAttribute('aria-activedescendant')
  })

  it('opens Settings to manage them, or to make the first one', () => {
    const { onManage, unmount } = renderPicker()
    fireEvent.click(screen.getByRole('button', { name: 'Manage templates…' }))
    expect(onManage).toHaveBeenCalled()
    unmount()
    setTemplates([])
    renderPicker()
    expect(screen.getByText('No templates yet')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Create one…' }),
    ).toBeInTheDocument()
  })

  it('says it is loading or failed; no Manage without a way there', () => {
    setTemplates([], { loaded: false })
    const { unmount } = renderPicker(false)
    expect(screen.getByText('Loading…')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Manage|Create/ })).toBeNull()
    unmount()
    setTemplates([], { loaded: false, error: true })
    renderPicker()
    expect(screen.getByText('Could not read the templates')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Manage templates…' }),
    ).toBeInTheDocument()
  })

  it('closes', async () => {
    const { onClose } = renderPicker()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    })
    expect(onClose).toHaveBeenCalled()
  })
})
