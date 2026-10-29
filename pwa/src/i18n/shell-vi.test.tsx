import { fireEvent, screen } from '@testing-library/react'
import { SquareTerminal } from 'lucide-react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { APP_VIEWS, viewLabel } from '../app-views'
import { AgentStatusBadge } from '../components/agent-status-badge'
import { ConnectionIndicator } from '../components/connection-indicator'
import { GroupDialog, groupProblem } from '../components/group-dialog'
import { KeyboardToolbar } from '../components/keyboard-toolbar'
import { moveProblem, reorderPausedHint } from '../components/session-sidebar'
import { SessionSwitcherChip } from '../components/session-switcher-chip'
import { SessionTabs } from '../components/session-tabs'
import { StatusTimeline } from '../components/status-timeline'
import { RootCloseDialog } from '../components/tab-close-dialogs'
import { ViewMenu } from '../components/ui/view-menu'
import { RequestError } from '../hooks/use-mux-api'
import type { Session } from '../types/session'
import { formatRunning } from '../utils/running-commands'
import { tFor } from './i18n-context'
import { renderWithLocale } from './test-utils'

// The app's frame in Vietnamese: a few strings of each part, and the
// accessible names a screen reader announces
const tVi = tFor('vi')

const session = (id: string, name: string): Session => ({
  id,
  name,
  icon: '💻',
  description: '',
})

// jsdom has no modal dialog
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (
    this: HTMLDialogElement,
  ) {
    this.setAttribute('open', '')
  })
  HTMLDialogElement.prototype.close = vi.fn()
})

describe('the app frame in Vietnamese', () => {
  it('names the session tabs and their buttons', () => {
    renderWithLocale(
      <SessionTabs
        sessions={[session('1', 'api'), session('2', 'web')]}
        activeId="1"
        onSelect={vi.fn()}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
      />,
      'vi',
    )
    expect(screen.getByRole('tablist', { name: 'Phiên' })).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Thêm phiên' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Đóng api' })).toBeInTheDocument()
  })

  it('counts sessions on the mobile chip with one plural form', () => {
    renderWithLocale(
      <SessionSwitcherChip
        session={session('1', 'api')}
        sessionCount={1}
        blockedElsewhere={2}
        connectionState="connected"
        expanded={false}
        onClick={vi.fn()}
      />,
      'vi',
    )
    expect(
      screen.getByRole('button', {
        name: 'Mở danh sách phiên, 2 phiên khác đang chờ bạn',
      }),
    ).toHaveTextContent('1 phiên')
  })

  it('names the toolbar groups, keys and actions', () => {
    renderWithLocale(
      <KeyboardToolbar
        onKey={vi.fn()}
        onCtrlKey={vi.fn()}
        defaultExpanded
        quickActions={{ onSendKey: vi.fn(), onSendText: vi.fn() }}
      />,
      'vi',
    )
    expect(screen.getByRole('group', { name: 'Thao tác' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Di chuyển' })).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Phím khác' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Xóa dòng/ })).toBeInTheDocument()
    // Keycaps keep the keys' own names
    expect(screen.getByRole('button', { name: 'Esc' })).toBeInTheDocument()
  })

  it('names the connection, an agent and the timeline', () => {
    renderWithLocale(
      <>
        <ConnectionIndicator state="error" onRetry={vi.fn()} />
        <AgentStatusBadge status="blocked" />
        <StatusTimeline events={[]} paneKey="p" now={0} />
      </>,
      'vi',
    )
    expect(
      screen.getByRole('button', { name: 'Lỗi kết nối' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('img', { name: 'Agent đang chờ bạn' }),
    ).toBeInTheDocument()
    expect(screen.getByText('Chưa có dữ liệu')).toBeInTheDocument()
  })

  it('names the view menu and its views', () => {
    const views = APP_VIEWS.slice(0, 3).map((v) => ({
      id: v.id,
      Icon: SquareTerminal,
      label: viewLabel(v, tVi),
    }))
    renderWithLocale(
      <ViewMenu views={views} value={views[2].id} onChange={vi.fn()} />,
      'vi',
    )
    expect(
      screen.getByRole('button', { name: 'Cách xem: File' }),
    ).toBeInTheDocument()
  })

  it('asks before closing files with unsaved changes', () => {
    renderWithLocale(<RootCloseDialog count={3} onResolve={vi.fn()} />, 'vi')
    expect(screen.getByText('Đóng 3 file chưa lưu?')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Giữ lại' })).toBeInTheDocument()
  })

  it('creates a group with its own noun', () => {
    renderWithLocale(
      <GroupDialog kind="tmux" onClose={vi.fn()} onCreate={vi.fn()} />,
      'vi',
    )
    expect(screen.getByText('Tạo phiên tmux')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Tạo' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Hãy nhập tên')
  })

  it('words the refusals, the reorder hint and what a close stops', () => {
    expect(groupProblem('exists', 'workspace', tVi)).toBe(
      'Đã có workspace trùng tên',
    )
    expect(moveProblem(new RequestError(409, 'busy', 'x'), tVi)).toBe(
      'Một lần di chuyển khác đang chạy; hãy thử lại',
    )
    expect(reorderPausedHint(tVi, true, true, true)).toBe(
      'Xóa ô tìm, bấm Hiện tất cả và tắt xếp phiên đang chờ lên đầu để sắp xếp lại',
    )
    expect(reorderPausedHint(tVi, false, true)).toBe(
      'Tắt xếp phiên đang chờ lên đầu trong Cài đặt để sắp xếp lại',
    )
    expect(formatRunning(['vim', 'npm'], tVi)).toBe('Đang chạy: vim, npm.')
  })
})
