import { fireEvent, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatAttachments } from '../components/chat-attachments'
import { LoadFailed } from '../components/lazy-boundary'
import {
  PaneLayoutMenu,
  paneLayoutMessage,
} from '../components/pane-layout-menu'
import { StartAgentPanel } from '../components/start-agent-panel'
import { ConfirmDialog } from '../components/ui/confirm-dialog'
import { Sheet } from '../components/ui/sheet'
import { worktreeProblem } from '../components/worktree-dialog'
import { buildSessions } from '../hooks/use-local-sessions'
import { type MuxSnapshot, RequestError } from '../hooks/use-mux-api'
import { notificationContent } from '../utils/agent-notify'
import { serverErrorText } from '../utils/server-error'
import { uploadErrorMessage } from '../utils/upload-image'
import { tFor } from './i18n-context'
import { renderWithLocale } from './test-utils'

// Shared dialogs, toasts, refusals and notifications in Vietnamese
const tVi = tFor('vi')

// jsdom has no modal dialog
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (
    this: HTMLDialogElement,
  ) {
    this.setAttribute('open', '')
  })
  HTMLDialogElement.prototype.close = vi.fn()
})

describe('shared dialogs in Vietnamese', () => {
  it('Cancel and the close button of a confirmation', () => {
    renderWithLocale(
      <ConfirmDialog
        isOpen
        title="Đóng tab?"
        confirmLabel="Đóng tab"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      >
        x
      </ConfirmDialog>,
      'vi',
    )
    expect(screen.getByRole('button', { name: 'Hủy' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Đóng' })).toBeInTheDocument()
  })

  it('a sheet keeps a close label it was given', () => {
    renderWithLocale(
      <Sheet isOpen onClose={vi.fn()} title="x" closeLabel="Thôi">
        x
      </Sheet>,
      'vi',
    )
    expect(screen.getByRole('button', { name: 'Thôi' })).toBeInTheDocument()
  })

  it('a view that could not load', () => {
    renderWithLocale(<LoadFailed message="x" retry={vi.fn()} />, 'vi')
    expect(screen.getByRole('button', { name: 'Thử lại' })).toBeInTheDocument()
  })
})

describe('the Pane menu in Vietnamese', () => {
  it('names every action', () => {
    renderWithLocale(
      <PaneLayoutMenu
        desktop
        arrange
        canSwapNext
        canClose
        onSplit={vi.fn()}
        onZoom={vi.fn()}
        onSwapNext={vi.fn()}
        onResize={vi.fn()}
        onClose={vi.fn()}
      />,
      'vi',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Pane' }))
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual([
      'Chia sang phải',
      'Chia xuống dưới',
      'Phóng to',
      'Đổi chỗ với pane kế tiếp',
      'Đổi cỡ sang trái',
      'Đổi cỡ sang phải',
      'Đổi cỡ lên trên',
      'Đổi cỡ xuống dưới',
      'Đóng pane',
    ])
    expect(screen.getByRole('group', { name: 'Đổi cỡ' })).toBeInTheDocument()
  })

  it('says why a layout action was refused', () => {
    const err = (code: string) => new RequestError(400, code, 'server text')
    expect(paneLayoutMessage(err('no_room'), tVi)).toBe(
      'Không còn chỗ cho pane mới',
    )
    expect(paneLayoutMessage(err('busy'), tVi)).toBe('Đang bận, hãy thử lại')
    expect(paneLayoutMessage(err('invalid_mode'), tVi)).toBe(
      'Không đổi được các pane',
    )
  })
})

describe('refusals in Vietnamese', () => {
  it('a server code, never its English text', () => {
    expect(
      serverErrorText(new RequestError(409, 'no_client', 'open it'), tVi),
    ).toBe(
      'Hãy mở phiên Zellij này trong một terminal (hoặc trong Termote) trước khi thêm tab',
    )
    expect(serverErrorText(new RequestError(409, 'what', 'x'), tVi)).toBe(
      'Server không hoàn tất được yêu cầu. Hãy thử lại',
    )
  })

  it('a worktree change', () => {
    expect(worktreeProblem('changed', tVi)).toBe(
      'Worktree này đã đổi; hãy xem lại',
    )
    expect(worktreeProblem('not_git', tVi)).toBe(
      'Workspace này không nằm trong repository git',
    )
    expect(worktreeProblem('', tVi)).toBe('Không thay đổi được worktree')
  })

  it('an image that could not be attached', () => {
    expect(uploadErrorMessage('too_large', tVi)).toBe('Ảnh lớn hơn 10 MB')
    expect(uploadErrorMessage('busy', tVi)).toBe(
      'Một lượt tải lên khác đang chạy. Hãy thử lại sau giây lát',
    )
    renderWithLocale(
      <ChatAttachments
        items={[
          {
            key: 1,
            n: 1,
            thumb: null,
            status: 'failed',
            error: 'dialogs.upload.gone',
          },
        ]}
        onRemove={vi.fn()}
      />,
      'vi',
    )
    expect(screen.getByRole('listitem')).toHaveAttribute(
      'title',
      'Không còn trên máy host',
    )
  })

  it('a start the server refused', () => {
    renderWithLocale(
      <StartAgentPanel
        kinds={['claude']}
        record={{
          kind: 'claude',
          phase: 'failed',
          error: 'dialogs.startAgent.pending',
          since: 0,
        }}
        onStart={vi.fn()}
      />,
      'vi',
    )
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Herdr vẫn giữ lần khởi động trước trong pane này tới 30 giây. Lát nữa hãy thử lại.',
    )
  })
})

describe('agents in Vietnamese', () => {
  it('a notification from the page', () => {
    const c = notificationContent(
      { kind: 'blocked', tabId: 't', paneId: 'p' },
      [],
      [],
      tVi,
    )
    expect(c.title).toBe('Agent cần bạn')
    expect(c.options.body).toBe('Agent')
    expect(
      notificationContent(
        { kind: 'done', tabId: 't', paneId: 'p' },
        [],
        [],
        tVi,
      ).title,
    ).toBe('Agent đã xong')
  })

  it('a pane with no agent and no title, by its place', () => {
    const snap = {
      groups: [
        {
          id: '$1',
          name: 'g',
          tabs: [
            {
              id: '$1:1',
              name: 'build',
              panes: [{ id: '%1' }, { id: '%2', title: 'vim' }, { id: '%3' }],
            },
          ],
        },
      ],
    } as unknown as MuxSnapshot
    const panes = buildSessions(snap, {}, tVi).sessions[0].panes
    expect(panes?.map((p) => p.label)).toEqual(['Pane 1', 'vim', 'Pane 3'])
  })
})
