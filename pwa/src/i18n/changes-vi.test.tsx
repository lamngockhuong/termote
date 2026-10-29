import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeRowButton } from '../components/change-status'
import { ChangesView } from '../components/changes-view'
import { CommitView } from '../components/commit-view'
import { DiffBody } from '../components/diff-viewer'
import { DiscardChangeDialog } from '../components/discard-change-dialog'
import {
  LineCommentBar,
  LineGutterButton,
} from '../components/line-comment-bar'
import { ReviewCommentSheet } from '../components/review-comment-sheet'
import { ReviewControl } from '../components/review-panel'
import {
  WorktreeDialog,
  WorktreeRemoveDialog,
} from '../components/worktree-dialog'
import { ThemeProvider } from '../contexts/theme-context'
import { resetFilesStores } from '../hooks/use-files'
import { resetGitChangesStores } from '../hooks/use-git-changes'
import type { ChangeEntry, FileDiff, WorktreeList } from '../hooks/use-mux-api'
import type { Session } from '../types/session'
import {
  addReviewComment,
  type ReviewComment,
  resetReviewDrafts,
} from '../utils/review-draft'
import { lineText, reviewMessage, sourceText } from '../utils/review-message'
import { formatDateTime } from './format'
import { tFor } from './i18n-context'
import { renderWithLocale } from './test-utils'

// Changes, review and the git dialogs in Vietnamese; what a review sends
// to the agent stays in English
const tVi = tFor('vi')

const mockChanges = vi.fn()
const mockDiff = vi.fn()
const mockLastCommit = vi.fn()
const mockSend = vi.fn()

vi.mock('../hooks/use-mux-api', async (orig) => ({
  ...(await orig<typeof import('../hooks/use-mux-api')>()),
  fetchGitChanges: (...a: unknown[]) => mockChanges(...a),
  fetchFileDiff: (...a: unknown[]) => mockDiff(...a),
  fetchLastCommit: (...a: unknown[]) => mockLastCommit(...a),
}))
vi.mock('../utils/send-to-agent', () => ({
  sendToAgent: (...a: unknown[]) => mockSend(...a),
}))

const entry = (
  path: string,
  staged: string,
  unstaged: string,
  over: Partial<ChangeEntry> = {},
): ChangeEntry => ({ path, staged, unstaged, sensitive: false, ...over })

const DIFF: FileDiff = {
  root: '/r',
  path: 'src/a.ts',
  truncated: false,
  hunks: [
    {
      id: 'h1',
      header: '@@ -1 +1 @@',
      lines: [
        { kind: 'del', old: 1, text: 'one' },
        { kind: 'add', new: 1, text: 'two', noNewline: true },
      ],
    },
  ],
}

const comment = (over: Partial<ReviewComment> = {}): ReviewComment => ({
  id: 'c1',
  root: '/r',
  path: 'src/a.ts',
  source: 'unstaged',
  start: 12,
  end: 18,
  quote: '+x',
  text: 'Tại sao?',
  at: 1,
  ...over,
})

const settle = () => act(() => new Promise((r) => setTimeout(r, 5)))

beforeEach(() => {
  resetGitChangesStores()
  resetFilesStores()
  mockChanges.mockReset()
  mockDiff.mockReset()
  mockLastCommit.mockReset()
  mockSend.mockReset()
  HTMLDialogElement.prototype.showModal = vi.fn(function (
    this: HTMLDialogElement,
  ) {
    this.setAttribute('open', '')
  })
  HTMLDialogElement.prototype.close = vi.fn()
})
afterEach(() => {
  sessionStorage.clear()
  resetReviewDrafts()
})

describe('Changes in Vietnamese', () => {
  it('groups the list and names each button', async () => {
    mockChanges.mockResolvedValue({
      root: '/r',
      isRepo: true,
      branch: 'main',
      truncated: false,
      entries: [
        entry('src/a.ts', 'M', 'M'),
        entry('new.md', '', '?'),
        entry('merge.go', '', '', { conflict: true }),
        entry('.env', 'A', '', { sensitive: true }),
      ],
    })
    mockDiff.mockResolvedValue(DIFF)
    renderWithLocale(
      <ThemeProvider>
        <ChangesView
          mux={{
            backend: 'tmux',
            caps: {
              clientSideSelect: false,
              copyMode: true,
              files: true,
              trash: true,
            },
          }}
          session={{
            id: '1',
            name: 'Shell',
            icon: '',
            description: '',
            paneId: '%1',
          }}
          readOnly={false}
          isMobile={false}
          notify={vi.fn()}
          showView={vi.fn()}
        />
      </ThemeProvider>,
      'vi',
    )
    await settle()
    for (const name of [
      'Xung đột',
      'Đã vào index',
      'Thay đổi',
      'Chưa theo dõi',
    ])
      expect(screen.getByRole('region', { name })).toBeTruthy()
    const staged = within(screen.getByRole('region', { name: 'Đã vào index' }))
    expect(
      staged.getByRole('button', { name: 'Bỏ a.ts khỏi index' }),
    ).toBeTruthy()
    expect(staged.getAllByText('Đã sửa:', { exact: false }).length).toBe(1)
    expect(staged.getByTitle('Có thể chứa bí mật')).toBeTruthy()
    const changed = within(screen.getByRole('region', { name: 'Thay đổi' }))
    expect(
      changed.getByRole('button', { name: 'Đưa a.ts vào index' }),
    ).toBeTruthy()
    expect(
      changed.getByRole('button', { name: 'Bỏ thay đổi của a.ts' }),
    ).toBeTruthy()

    // The unstaged side's diff
    fireEvent.click(changed.getByText('a.ts'))
    await settle()
    expect(screen.getByText('Chưa vào index')).toBeTruthy()
    expect(
      screen.getAllByRole('button', { name: 'Quay lại Thay đổi' }).length,
    ).toBeGreaterThan(0)
    expect(
      screen.getByRole('button', { name: 'Đưa cả file vào index' }),
    ).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Bỏ thay đổi 1' })).toBeTruthy()
    expect(
      screen.getByText('(cuối file không có ký tự xuống dòng)'),
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Dòng đã xóa 1' }))
    expect(screen.getAllByText('Dòng đã xóa 1').length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: 'Bình luận' })).toBeTruthy()
  })

  it('says what a diff cannot show', () => {
    renderWithLocale(
      <DiffBody
        diff={{ ...DIFF, binary: true, conflict: true, truncated: true }}
        wrap={false}
        oneColumn={false}
      />,
      'vi',
    )
    expect(screen.getByText('File nhị phân đã đổi')).toBeTruthy()
    expect(screen.getByText('Diff bị cắt ở 1 MiB')).toBeTruthy()
    expect(
      screen.getByText('Xung đột chưa giải quyết: file như hiện tại'),
    ).toBeTruthy()
  })

  it('marks a file that may hold secrets', () => {
    renderWithLocale(
      <ChangeRowButton code="?" path="a/.env" sensitive onOpen={() => {}} />,
      'vi',
    )
    expect(screen.getByText('Chưa theo dõi:', { exact: false })).toBeTruthy()
    expect(screen.getByText('Nhạy cảm')).toBeTruthy()
  })

  it('asks before discarding a change', () => {
    renderWithLocale(
      <DiscardChangeDialog
        paneId="%1"
        root="/r"
        entry={entry('src/a.ts', '', 'M')}
        hunk={DIFF.hunks?.[0]}
        onClose={() => {}}
        onDiscarded={() => {}}
        onRootChanged={() => {}}
        onRefresh={() => {}}
      />,
      'vi',
    )
    expect(screen.getByText('Bỏ thay đổi này?')).toBeTruthy()
    expect(
      screen.getByText(
        'File hiện tại được chuyển vào thùng rác của Termote; Hoàn tác sẽ đưa nó về chỗ cũ.',
      ),
    ).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Hủy' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Bỏ thay đổi' })).toBeTruthy()
  })

  it('shows the last commit with its date in the locale', async () => {
    mockLastCommit.mockResolvedValue({
      root: '/r',
      isRepo: true,
      commit: {
        hash: 'a'.repeat(40),
        parents: ['b'.repeat(40), 'c'.repeat(40)],
        author: 'Ada',
        time: 1_700_000_000,
        message: '',
        files: [],
        truncated: false,
      },
    })
    renderWithLocale(
      <CommitView
        paneId="%1"
        isMobile={false}
        canReveal
        onBack={() => {}}
        onRootChanged={() => {}}
      />,
      'vi',
    )
    await settle()
    expect(screen.getByText('Commit cuối')).toBeTruthy()
    expect(screen.getByText('(không có thông điệp)')).toBeTruthy()
    expect(screen.getByText('Không file nào thay đổi')).toBeTruthy()
    expect(
      screen.getByText('Merge: thay đổi so với commit cha đầu tiên'),
    ).toBeTruthy()
    expect(
      screen.getByText(formatDateTime(1_700_000_000_000, 'vi')),
    ).toBeTruthy()
  })
})

describe('the git dialogs in Vietnamese', () => {
  const LIST: WorktreeList = {
    repoName: 'repo',
    branches: ['main'],
    worktrees: [
      {
        path: '/wt/repo/feat-x',
        branch: 'feat/x',
        linked: true,
        openable: true,
        groupId: 'w2',
      },
    ],
  }

  it('names the fields of a new worktree and what is missing', async () => {
    renderWithLocale(
      <WorktreeDialog
        mode="new"
        groupId="w1"
        onClose={() => {}}
        onCreate={async () => {}}
        onOpen={async () => {}}
        onShow={() => {}}
        load={async () => LIST}
      />,
      'vi',
    )
    await act(async () => {})
    expect(screen.getByText('Tạo worktree')).toBeTruthy()
    expect(
      screen.getByLabelText('Nhánh (tạo mới, hoặc dùng nhánh đã có)'),
    ).toBeTruthy()
    expect(
      screen.getByRole('button', { name: 'Nhánh gốc: HEAD hiện tại' }),
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Tạo' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Hãy nhập tên nhánh')
  })

  it('lists the worktrees to open', async () => {
    renderWithLocale(
      <WorktreeDialog
        mode="open"
        groupId="w1"
        onClose={() => {}}
        onCreate={async () => {}}
        onOpen={async () => {}}
        onShow={() => {}}
        load={async () => LIST}
      />,
      'vi',
    )
    expect(screen.getByText('Đang đọc các worktree…')).toBeTruthy()
    await act(async () => {})
    expect(screen.getByText('Mở worktree')).toBeTruthy()
    expect(screen.getByText('đang mở')).toBeTruthy()
  })

  it('names the checkout a removal deletes', async () => {
    renderWithLocale(
      <WorktreeRemoveDialog
        groupId="w2"
        onConfirm={() => {}}
        onCancel={() => {}}
        load={async () => LIST}
      />,
      'vi',
    )
    await act(async () => {})
    expect(screen.getByText('Xóa worktree "feat/x"?')).toBeTruthy()
    expect(screen.getByText('feat/x').parentElement).toHaveTextContent(
      'Nhánh feat/x',
    )
    expect(screen.getByText('/wt/repo/feat-x').parentElement).toHaveTextContent(
      'Xóa /wt/repo/feat-x và đóng workspace này.',
    )
  })

  it('asks a second time before removing changes', () => {
    renderWithLocale(
      <WorktreeRemoveDialog
        groupId="w2"
        force={{ path: '/wt/repo/feat-x', branch: 'feat/x' }}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
      'vi',
    )
    expect(screen.getByText('Vẫn xóa worktree "feat/x"?')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Vẫn xóa' })).toBeTruthy()
  })
})

describe('review comments in Vietnamese', () => {
  it('names the lines and where they were read', () => {
    expect(lineText({ start: 4, end: 4 }, tVi)).toBe('dòng 4')
    expect(lineText({ start: 12, end: 18 }, tVi)).toBe('dòng 12-18')
    expect(
      lineText(
        { start: 1, end: 1, removedOnly: true, removed: { start: 3, end: 5 } },
        tVi,
      ),
    ).toBe('dòng đã xóa 3-5')
    expect(sourceText(comment({ source: 'staged' }), tVi)).toBe(
      'diff đã vào index',
    )
    expect(sourceText(comment({ source: 'file', unsaved: true }), tVi)).toBe(
      'file (có thay đổi chưa lưu)',
    )
  })

  it('picks lines and writes a comment', () => {
    renderWithLocale(
      <>
        <LineGutterButton line={7} commented onPress={() => {}}>
          7
        </LineGutterButton>
        <LineCommentBar
          label="Dòng 7"
          onComment={() => {}}
          onClear={() => {}}
        />
      </>,
      'vi',
    )
    expect(screen.getByRole('button', { name: 'Dòng 7' })).toHaveAttribute(
      'title',
      'Đã có bình luận',
    )
    expect(
      screen.getByRole('button', { name: 'Bỏ chọn các dòng' }),
    ).toBeTruthy()
    renderWithLocale(
      <ReviewCommentSheet
        target={{ ...comment(), sensitive: true }}
        onSave={() => {}}
        onClose={() => {}}
      />,
      'vi',
    )
    expect(screen.getByText('Thêm bình luận')).toBeTruthy()
    expect(screen.getByText('dòng 12-18')).toBeTruthy()
    expect(
      screen.getByText('Không trích các dòng: có thể chứa bí mật'),
    ).toBeTruthy()
    fireEvent.change(screen.getByRole('textbox', { name: 'Bình luận' }), {
      target: { value: 'x'.repeat(4608) },
    })
    expect(screen.getByText('Quá dài: 4,5/4 KiB')).toBeTruthy()
  })

  it('shows the review in Vietnamese but sends it to the agent in English', async () => {
    const own: Session = {
      id: 'here',
      name: 'Tab',
      icon: '',
      description: '',
      groupId: 'g',
      paneId: '%1',
      hasAgent: true,
      agentName: 'claude',
    }
    const notify = vi.fn()
    addReviewComment('%1', comment())
    addReviewComment(
      '%1',
      comment({ id: 'c2', source: 'staged', start: 3, end: 3 }),
    )
    const sent = reviewMessage([
      comment(),
      comment({ id: 'c2', source: 'staged', start: 3, end: 3 }),
    ]).text
    mockSend.mockResolvedValue({ queued: false })
    renderWithLocale(
      <ReviewControl
        paneId="%1"
        session={own}
        sessions={[own]}
        canSend
        notify={notify}
        onOpenComment={() => {}}
      />,
      'vi',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Review, 2 bình luận' }))
    expect(screen.getByText('Review (2)')).toBeTruthy()
    expect(screen.getByText('· diff chưa vào index')).toBeTruthy()
    expect(screen.getByText('· diff đã vào index')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Gửi cho Claude Code' }))
    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1))
    expect(mockSend).toHaveBeenCalledWith('%1', sent)
    expect(sent).toMatch(/^Review of my changes in \/r \(2 comments\)\./)
    expect(sent).toContain('lines 12-18 (unstaged diff)')
    expect(sent).toContain('line 3 (staged diff)')
    expect(sent).not.toMatch(/dòng|bình luận/)
    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        'Đã gửi cho Claude Code',
        expect.objectContaining({ variant: 'success' }),
      ),
    )
  })
})
