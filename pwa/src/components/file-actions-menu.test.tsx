import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FileActionItems, type FileActionsProps } from './file-actions-menu'
import { Menu } from './ui/menu'

const copyText = vi.hoisted(() =>
  vi.fn<(text: string) => Promise<'ok' | 'failed'>>(),
)
vi.mock('../utils/copy-text', () => ({ copyText }))

beforeEach(() => {
  copyText.mockReset()
  copyText.mockResolvedValue('ok')
})

function renderItems(props: Partial<FileActionsProps> = {}) {
  const notify = vi.fn()
  render(
    <Menu label="Actions" trigger="…" open>
      <FileActionItems
        path="pwa/src/my file.ts"
        root="/home/me/repo"
        paneDir={async () => 'pwa'}
        notify={notify}
        {...props}
      />
    </Menu>,
  )
  return { notify }
}

const items = () =>
  screen.getAllByRole('menuitem').map((el) => el.textContent?.trim() ?? '')
const choose = (name: string) =>
  fireEvent.click(screen.getByRole('menuitem', { name }))

describe('FileActionItems', () => {
  it('offers only the copies without any other action (view-only)', () => {
    renderItems()
    expect(items()).toEqual([
      'Copy relative path',
      'Copy absolute path',
      'Copy name',
    ])
    expect(screen.queryByRole('separator')).toBeNull()
  })

  it('offers every action of a folder, in groups', () => {
    const fns = {
      insertText: vi.fn(() => true),
      onNewFile: vi.fn(),
      onNewFolder: vi.fn(),
      onUpload: vi.fn(),
      onDownload: vi.fn(),
      onRename: vi.fn(),
      onDelete: vi.fn(),
    }
    const { container } = render(
      <Menu label="Actions" trigger="…" open>
        <FileActionItems path="src" root="/r" notify={vi.fn()} {...fns} />
      </Menu>,
    )
    expect(items()).toEqual([
      'Copy relative path',
      'Copy absolute path',
      'Copy name',
      'Insert @path in terminal',
      'New file',
      'New folder',
      'Upload files here',
      'Download',
      'Rename',
      'Delete',
    ])
    expect(container.ownerDocument.querySelectorAll('hr')).toHaveLength(4)
    choose('New file')
    choose('New folder')
    choose('Upload files here')
    choose('Download')
    choose('Rename')
    choose('Delete')
    for (const fn of Object.values(fns).slice(1))
      expect(fn).toHaveBeenCalledOnce()
  })

  it('copies the relative path, the absolute one and the name', async () => {
    const { notify } = renderItems()
    choose('Copy relative path')
    expect(copyText).toHaveBeenLastCalledWith('pwa/src/my file.ts')
    choose('Copy absolute path')
    expect(copyText).toHaveBeenLastCalledWith(
      '/home/me/repo/pwa/src/my file.ts',
    )
    choose('Copy name')
    expect(copyText).toHaveBeenLastCalledWith('my file.ts')
    await waitFor(() => expect(notify).toHaveBeenCalledTimes(3))
    expect(notify.mock.calls.map((c) => c[0])).toEqual([
      'Path copied',
      'Path copied',
      'Name copied',
    ])
  })

  it('copies the path as Windows names it, and opens it there (WSL)', async () => {
    const onOpenWindows = vi.fn()
    const { notify } = renderItems({
      windowsRoot: '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo',
      onOpenWindows,
      onDownload: vi.fn(),
    })
    expect(items()).toEqual([
      'Copy relative path',
      'Copy absolute path',
      'Copy Windows path',
      'Copy name',
      'Open in Windows',
      'Download',
    ])
    choose('Copy Windows path')
    expect(copyText).toHaveBeenLastCalledWith(
      '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo\\pwa\\src\\my file.ts',
    )
    await waitFor(() => expect(notify).toHaveBeenCalledWith('Path copied'))
    choose('Open in Windows')
    expect(onOpenWindows).toHaveBeenCalledOnce()
  })

  it('copies a drive path for a root under a mounted drive', () => {
    renderItems({ path: 'a/b.html', windowsRoot: 'C:\\' })
    choose('Copy Windows path')
    expect(copyText).toHaveBeenLastCalledWith('C:\\a\\b.html')
  })

  it('says when the clipboard refused', async () => {
    copyText.mockResolvedValue('failed')
    const { notify } = renderItems()
    choose('Copy relative path')
    choose('Copy name')
    await waitFor(() => expect(notify).toHaveBeenCalledTimes(2))
    expect(notify.mock.calls).toEqual([
      ['Could not copy the path', { variant: 'danger' }],
      ['Could not copy the name', { variant: 'danger' }],
    ])
  })

  it('types the @path from the pane directory, read now, at the agent', async () => {
    const insertText = vi.fn(() => true)
    const { notify } = renderItems({ insertText })
    choose('Insert @path in terminal')
    await waitFor(() =>
      expect(insertText).toHaveBeenCalledWith('@"src/my file.ts"'),
    )
    expect(notify).not.toHaveBeenCalled()
  })

  it('types the whole path when the pane directory is not known', async () => {
    const insertText = vi.fn(() => true)
    renderItems({ insertText, paneDir: undefined })
    choose('Insert @path in terminal')
    await waitFor(() =>
      expect(insertText).toHaveBeenCalledWith(
        '@"/home/me/repo/pwa/src/my file.ts"',
      ),
    )
  })

  it('never types a name with a line break or a quote', async () => {
    const insertText = vi.fn(() => true)
    const { notify } = renderItems({
      insertText,
      path: 'pwa/a"\ntouch x\nb',
    })
    choose('Insert @path in terminal')
    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        "This path has a line break or a quote; it can't be typed into the terminal",
        { variant: 'warning' },
      ),
    )
    expect(insertText).not.toHaveBeenCalled()
  })

  it('offers to copy the @path when it could not be typed', async () => {
    const { notify } = renderItems({
      path: 'server/main.go',
      place: 'notes',
      insertText: () => false,
    })
    choose('Insert @path in terminal')
    await waitFor(() => expect(notify).toHaveBeenCalled())
    const [text, opts] = notify.mock.calls[0]
    expect(text).toBe(
      'Not inserted in the terminal: @/home/me/repo/server/main.go',
    )
    expect(opts.variant).toBe('warning')
    expect(opts.action.label).toBe('Copy')
    opts.action.onClick()
    expect(copyText).toHaveBeenCalledWith('@/home/me/repo/server/main.go')
    await waitFor(() => expect(notify).toHaveBeenLastCalledWith('Path copied'))
  })

  it('keeps Delete of a folder holding something, off', () => {
    const onDelete = vi.fn()
    renderItems({ onDelete, deleteBlocked: true })
    const del = screen.getByRole('menuitem', { name: 'Delete (not empty)' })
    expect(del).toBeDisabled()
  })
})
