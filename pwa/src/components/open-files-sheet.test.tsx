import { fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TabEntry, TabListProps } from './file-tab-bar'
import { OpenFilesButton, OpenFilesSheet } from './open-files-sheet'

const entry = (id: string, over: Partial<TabEntry> = {}): TabEntry => ({
  id,
  name: `${id}.md`,
  title: `docs/${id}.md`,
  detail: 'docs',
  pinned: true,
  dirty: false,
  ...over,
})

function show(over: Partial<TabListProps> = {}) {
  const props: TabListProps = {
    tabs: [
      entry('a'),
      entry('b', { pinned: false, detail: '' }),
      entry('c', { dirty: true }),
    ],
    activeId: 'a',
    homeLabel: 'Files',
    onActivate: vi.fn(),
    onClose: vi.fn(),
    onPin: vi.fn(),
    ...over,
  }
  render(<Harness {...props} />)
  return props
}

// The button and the sheet, as a view puts them together
function Harness(props: TabListProps) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <OpenFilesButton
        count={props.tabs.length}
        onClick={() => setOpen(true)}
      />
      <OpenFilesSheet
        {...props}
        isOpen={open}
        onDismiss={() => setOpen(false)}
      />
    </>
  )
}

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (
    this: HTMLDialogElement,
  ) {
    this.setAttribute('open', '')
  })
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.removeAttribute('open')
  })
})

const sheet = () => screen.getByRole('dialog', { name: 'Open files' })
const open = () =>
  fireEvent.click(screen.getByRole('button', { name: 'Open files (3)' }))

describe('OpenFilesButton', () => {
  it('counts the open files and lists them in a sheet', () => {
    show()
    expect(screen.queryByRole('dialog')).toBeNull()
    open()
    const rows = within(sheet()).getAllByRole('listitem')
    expect(rows.map((r) => r.textContent)).toEqual([
      'Files',
      'a.mddocs',
      'b.mdPreview',
      'c.md (unsaved changes)docs',
    ])
    expect(
      within(sheet()).getByRole('button', { name: /^a\.md/ }),
    ).toHaveAttribute('aria-current', 'true')
    expect(
      within(sheet()).getByRole('button', { name: 'Files' }),
    ).not.toHaveAttribute('aria-current')
  })

  it('a row shows its file and closes the sheet', () => {
    const p = show()
    open()
    fireEvent.click(within(sheet()).getByRole('button', { name: /^c\.md/ }))
    expect(p.onActivate).toHaveBeenCalledWith('c')
    expect(screen.queryByRole('dialog')).toBeNull()
    open()
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Files' }))
    expect(p.onActivate).toHaveBeenLastCalledWith(null)
  })

  it('the list entry is current when no file shows', () => {
    show({ activeId: null })
    open()
    expect(
      within(sheet()).getByRole('button', { name: 'Files' }),
    ).toHaveAttribute('aria-current', 'true')
  })

  it('pins a preview file and closes a file, keeping the sheet open', () => {
    const p = show()
    open()
    expect(
      within(sheet()).queryByRole('button', { name: 'Keep a.md open' }),
    ).toBeNull()
    fireEvent.click(
      within(sheet()).getByRole('button', { name: 'Keep b.md open' }),
    )
    expect(p.onPin).toHaveBeenCalledWith('b')
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Close c.md' }))
    expect(p.onClose).toHaveBeenCalledWith('c')
    expect(sheet()).toBeInTheDocument()
  })
})
