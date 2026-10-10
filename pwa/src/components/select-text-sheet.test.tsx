import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PaneTextState } from '../hooks/use-pane-text'
import { rangeText, SelectTextSheet } from './select-text-sheet'

const paneText = vi.hoisted(() => ({
  state: {} as Omit<PaneTextState, 'loadMore'>,
  loadMore: vi.fn(),
  args: undefined as unknown,
}))
vi.mock('../hooks/use-pane-text', () => ({
  usePaneText: (args: unknown) => {
    paneText.args = args
    return { ...paneText.state, loadMore: paneText.loadMore }
  },
}))

const copyText = vi.hoisted(() =>
  vi.fn(async (_t: string): Promise<'ok' | 'failed'> => 'ok'),
)
vi.mock('../utils/copy-text', () => ({ copyText }))

function setState(s: Partial<PaneTextState>) {
  paneText.state = {
    text: '',
    source: 'server',
    loading: false,
    truncated: false,
    canLoadMore: false,
    ...s,
  }
}

function renderSheet() {
  const onClose = vi.fn()
  const onCopied = vi.fn()
  const readBuffer = vi.fn(() => '')
  render(
    <SelectTextSheet
      onClose={onClose}
      paneId="0"
      useServer
      readBuffer={readBuffer}
      onCopied={onCopied}
    />,
  )
  return { onClose, onCopied, readBuffer }
}

// Selects the whole contents of node, as a drag or a long press would
function select(node: Node) {
  const range = document.createRange()
  range.selectNodeContents(node)
  const sel = document.getSelection()!
  sel.removeAllRanges()
  sel.addRange(range)
  act(() => {
    document.dispatchEvent(new Event('selectionchange'))
  })
}

describe('SelectTextSheet', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    HTMLDialogElement.prototype.showModal = vi.fn(function (
      this: HTMLDialogElement,
    ) {
      this.setAttribute('open', '')
    })
    HTMLDialogElement.prototype.close = vi.fn()
    document.getSelection()?.removeAllRanges()
    setState({ text: 'one\ntwo' })
  })

  it('shows the text from the bottom and passes its sources on', () => {
    const { readBuffer } = renderSheet()
    expect(screen.getByTestId('select-text').textContent).toBe('one\ntwo')
    expect(paneText.args).toEqual({ paneId: '0', useServer: true, readBuffer })
    expect(screen.queryByText(/Only what the terminal/)).toBeNull()
    expect(screen.queryByText(/oldest lines/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull()
  })

  it('copies all of the text', async () => {
    const { onCopied } = renderSheet()
    fireEvent.click(screen.getByRole('button', { name: 'Copy all' }))
    expect(copyText).toHaveBeenCalledWith('one\ntwo')
    await waitFor(() => expect(onCopied).toHaveBeenCalledWith('ok'))
  })

  it('copies the selection only once there is one in the text', async () => {
    const { onCopied } = renderSheet()
    const copy = screen.getByRole('button', { name: 'Copy' })
    expect(copy).toBeDisabled()
    // A selection outside the text does not count
    select(screen.getByRole('heading'))
    expect(copy).toBeDisabled()
    select(screen.getByTestId('select-text'))
    expect(copy).toBeEnabled()
    // Pressing the button keeps the selection
    const down = new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
    })
    copy.dispatchEvent(down)
    expect(down.defaultPrevented).toBe(true)
    fireEvent.pointerDown(copy)
    copyText.mockResolvedValueOnce('failed')
    fireEvent.click(copy)
    expect(copyText).toHaveBeenCalledWith('one\ntwo')
    await waitFor(() => expect(onCopied).toHaveBeenCalledWith('failed'))
    // The selection gone before the click: nothing to copy
    document.getSelection()!.removeAllRanges()
    fireEvent.click(copy)
    expect(copyText).toHaveBeenCalledTimes(1)
  })

  it('shows hidden characters and copies them as they are', () => {
    setState({ text: 'a\u202eb' })
    renderSheet()
    const pre = screen.getByTestId('select-text')
    expect(pre.textContent).toBe('a⟨U+202E⟩b')
    select(pre)
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    expect(copyText).toHaveBeenCalledWith('a\u202eb')
  })

  it("the device's own copy takes the characters, not their marks", () => {
    setState({ text: 'a\u202eb' })
    renderSheet()
    const pre = screen.getByTestId('select-text')
    const data = new Map<string, string>()
    const clipboardData = { setData: (t: string, v: string) => data.set(t, v) }
    // Nothing selected in the text: the browser copies as it would
    expect(fireEvent.copy(pre, { clipboardData })).toBe(true)
    expect(data.size).toBe(0)
    select(pre)
    expect(fireEvent.copy(pre, { clipboardData })).toBe(false)
    expect(data.get('text/plain')).toBe('a\u202eb')
  })

  it('says when it shows the buffer, a cut history, or more can be loaded', () => {
    setState({
      text: 'x',
      source: 'buffer',
      truncated: true,
      canLoadMore: true,
    })
    renderSheet()
    expect(screen.getByText(/Only what the terminal/)).toBeInTheDocument()
    expect(screen.getByText(/oldest lines/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    expect(paneText.loadMore).toHaveBeenCalled()
  })

  it('shows loading with nothing to copy', () => {
    setState({ loading: true })
    renderSheet()
    expect(screen.getByText('Loading…')).toBeInTheDocument()
    expect(screen.queryByText(/Only what the terminal/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Copy all' })).toBeDisabled()
  })

  it('closes', () => {
    const { onClose } = renderSheet()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalled()
  })
})

describe('rangeText', () => {
  it('turns each mark back into its character', () => {
    const pre = document.createElement('pre')
    pre.innerHTML = 'a<span data-raw="\u200b">⟨U+200B⟩</span>b<span>c</span>'
    const range = document.createRange()
    range.selectNodeContents(pre)
    expect(rangeText(range)).toBe('a\u200bbc')
  })
})
