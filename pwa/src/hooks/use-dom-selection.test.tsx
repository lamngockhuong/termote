import { act, render } from '@testing-library/react'
import { useRef } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { paneSelection, resetPaneSelections } from '../utils/pane-selection'
import { useDomSelection } from './use-dom-selection'

function Host({
  paneId,
  onSelect,
}: {
  paneId?: string
  onSelect?: (range: Range) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useDomSelection(ref, paneId, 'src/a.ts', onSelect)
  return (
    <div>
      <div ref={ref}>
        <p data-testid="text">some text</p>
        <div className="cm-editor">
          <p data-testid="editor">in the editor</p>
        </div>
      </div>
      <p data-testid="outside">outside</p>
    </div>
  )
}

function select(node: Node) {
  const range = document.createRange()
  range.selectNodeContents(node)
  const sel = document.getSelection() as Selection
  sel.removeAllRanges()
  sel.addRange(range)
  act(() => {
    document.dispatchEvent(new Event('selectionchange'))
  })
}

describe('useDomSelection', () => {
  beforeEach(() => {
    resetPaneSelections()
    document.getSelection()?.removeAllRanges()
  })

  it('keeps a selection inside the element, but not in the editor', () => {
    const { getByTestId, unmount } = render(<Host paneId="1" />)
    select(getByTestId('outside'))
    expect(paneSelection('1')).toBeNull()
    select(getByTestId('editor').firstChild as Node)
    expect(paneSelection('1')).toBeNull()
    select(getByTestId('text').firstChild as Node)
    expect(paneSelection('1')).toEqual({
      text: 'some text',
      source: 'src/a.ts',
    })
    // Collapsed: nothing new
    document.getSelection()?.collapseToStart()
    act(() => {
      document.dispatchEvent(new Event('selectionchange'))
    })
    expect(paneSelection('1')?.text).toBe('some text')
    unmount()
  })

  it('a selection dragged out of the element is not kept', () => {
    const { getByTestId } = render(<Host paneId="1" />)
    const range = document.createRange()
    range.setStart(getByTestId('text').firstChild as Node, 0)
    range.setEnd(getByTestId('outside').firstChild as Node, 3)
    const sel = document.getSelection() as Selection
    sel.removeAllRanges()
    sel.addRange(range)
    act(() => {
      document.dispatchEvent(new Event('selectionchange'))
    })
    expect(paneSelection('1')).toBeNull()
  })

  it('an element node anchor counts; off without a pane', () => {
    const { getByTestId, rerender } = render(<Host />)
    select(getByTestId('text'))
    expect(paneSelection('1')).toBeNull()
    rerender(<Host paneId="1" />)
    select(getByTestId('text'))
    expect(paneSelection('1')?.text).toBe('some text')
  })

  it('tells the latest onSelect of each selection kept, not of others', () => {
    const first = vi.fn()
    const second = vi.fn()
    const { getByTestId, rerender } = render(
      <Host paneId="1" onSelect={first} />,
    )
    rerender(<Host paneId="2" onSelect={second} />)
    select(getByTestId('text').firstChild as Node)
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
    expect((second.mock.calls[0][0] as Range).toString()).toBe('some text')
    // In the editor, or out of the element: not told
    select(getByTestId('editor').firstChild as Node)
    select(getByTestId('outside').firstChild as Node)
    expect(second).toHaveBeenCalledTimes(1)
  })
})
