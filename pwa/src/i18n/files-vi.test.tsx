import { screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DeleteFileDialog } from '../components/delete-file-dialog'
import { documentErrorText } from '../components/document-message'
import { FileEncodingMenu } from '../components/file-encoding-menu'
import { FileTabBar } from '../components/file-tab-bar'
import { describeOp } from '../components/file-viewer'
import { imageErrorText } from '../components/image-preview'
import { NewFileDialog } from '../components/new-file-dialog'
import { OpenFilesButton } from '../components/open-files-sheet'
import { PdfToolbar } from '../components/pdf-toolbar'
import { TableFindBar } from '../components/table-find-bar'
import { TableRecords } from '../components/table-records'
import { RequestError } from '../hooks/use-mux-api'
import { parseCsv } from '../utils/csv-parse'
import { downloadErrorMessage } from '../utils/download-file'
import { encodingLabel } from '../utils/file-encoding'
import { fileNameProblem, nameProblem } from '../utils/file-name'
import { formatSize } from '../utils/files-format'
import { restoreFailure } from '../utils/restore-failure'
import { fileUploadErrorMessage } from '../utils/upload-file'
import { fileImageErrorMessage } from '../utils/upload-image'
import { tFor } from './i18n-context'
import { renderWithLocale } from './test-utils'

// Files in Vietnamese: a few strings of each part, the sentences the pure
// functions build, and the sizes in the locale's own numbers
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

describe('Files in Vietnamese', () => {
  it('names the tabs and what they hold', () => {
    renderWithLocale(
      <FileTabBar
        tabs={[
          {
            id: 'a',
            name: 'a.md',
            title: 'docs/a.md',
            pinned: false,
            dirty: true,
            missing: true,
          },
        ]}
        activeId="a"
        homeLabel="File"
        onActivate={() => {}}
        onClose={() => {}}
        onPin={() => {}}
      />,
      'vi',
    )
    expect(screen.getByRole('tablist', { name: 'File đang mở' })).toBeTruthy()
    const tab = screen.getAllByRole('tab')[1]
    expect(tab).toHaveTextContent('a.md (xem trước) (không tìm thấy)')
    expect(tab).toHaveAttribute('title', 'docs/a.md — Không tìm thấy file')
    expect(screen.getByText('(có thay đổi chưa lưu)')).toBeTruthy()
    renderWithLocale(<OpenFilesButton count={2} onClick={() => {}} />, 'vi')
    expect(
      screen.getByRole('button', { name: 'File đang mở (2)' }),
    ).toBeTruthy()
  })

  it('asks before a new file and a delete', () => {
    renderWithLocale(
      <NewFileDialog
        paneId="%1"
        root="/r"
        initialPath=""
        onClose={() => {}}
        onCreated={() => {}}
        onRootChanged={() => {}}
        onRefresh={() => {}}
      />,
      'vi',
    )
    expect(screen.getByRole('dialog', { name: 'File mới' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Tạo' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Hủy' })).toBeTruthy()
    renderWithLocale(
      <DeleteFileDialog
        paneId="%1"
        root="/r"
        path="old"
        kind="dir"
        sensitive
        onClose={() => {}}
        onDeleted={() => {}}
        onRootChanged={() => {}}
        onRefresh={() => {}}
      />,
      'vi',
    )
    expect(screen.getByRole('dialog', { name: 'Xóa thư mục?' })).toBeTruthy()
    expect(
      screen.getByText('Thư mục trống sẽ bị gỡ. Hoàn tác sẽ tạo lại nó.'),
    ).toBeTruthy()
    expect(screen.getByText('Đây là file nhạy cảm')).toBeTruthy()
  })

  it('names the encoding menu, a PDF toolbar and a table find', () => {
    renderWithLocale(
      <FileEncodingMenu
        encoding="utf-8"
        bom
        dirty={false}
        onReopen={() => {}}
      />,
      'vi',
    )
    expect(
      screen.getByRole('button', { name: 'Bảng mã: UTF-8 có BOM' }),
    ).toBeTruthy()
    renderWithLocale(
      <PdfToolbar
        page={2}
        pages={9}
        scale={100}
        onZoomIn={() => {}}
        onZoomOut={() => {}}
        onFitWidth={() => {}}
        findOpen={false}
        onFind={() => {}}
      />,
      'vi',
    )
    expect(screen.getByText('Trang 2/9')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Phóng to' })).toBeTruthy()
    renderWithLocale(
      <TableFindBar
        input="x"
        onInput={() => {}}
        flags={{ matchCase: false, wholeCell: false, regex: false }}
        onFlags={() => {}}
        status="ready"
        count={4}
        current={1}
        hidden={1}
        onStep={() => {}}
        onClose={() => {}}
        inputRef={{ current: null }}
      />,
      'vi',
    )
    // <search>: the search role in a browser, though not in jsdom
    expect(document.querySelector('search')).toHaveAttribute(
      'aria-label',
      'Tìm trong bảng',
    )
    expect(screen.getByText('2/4')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Nguyên ô' })).toBeTruthy()
    expect(screen.getByText('Không tìm trong các cột đang ẩn')).toBeTruthy()
  })

  it('counts a record and its hidden columns', () => {
    const text = 'a,b\n1,2\n'
    const parsed = parseCsv(text, ',')
    if (!parsed.ok) throw new Error('not a table')
    renderWithLocale(
      <TableRecords
        text={text}
        table={parsed.table}
        rows={new Int32Array([1])}
        names={['a', 'b']}
        cols={[0]}
        row={undefined}
        onRow={() => {}}
        onOpen={() => {}}
      />,
      'vi',
    )
    expect(
      screen.getByText('Bản ghi 1 / 1 · hàng 2 · 1 cột bị ẩn'),
    ).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Bản ghi sau' })).toBeTruthy()
  })

  it('builds its sentences in Vietnamese', () => {
    expect(nameProblem('a/', tVi)).toBe('Hãy nhập tên file sau dấu / cuối cùng')
    expect(tVi(fileNameProblem('a.') ?? 'files.name.empty')).toBe(
      'Tên không được kết thúc bằng dấu chấm hay khoảng trắng',
    )
    expect(encodingLabel('shift_jis', tVi)).toBe('Shift-JIS')
    expect(
      restoreFailure(
        new RequestError(409, 'changed', 'x'),
        'a.txt',
        undefined,
        tVi,
      ).message,
    ).toBe('a.txt đã thay đổi từ lúc đó; chưa khôi phục')
    expect(
      describeOp(
        { kind: 'delete', row: 2 } as Parameters<typeof describeOp>[0],
        tVi,
      ),
    ).toBe('Xóa hàng 3')
    expect(fileImageErrorMessage('too_many_pixels', tVi)).toBe(
      'Ảnh lớn hơn 40 triệu điểm ảnh',
    )
    expect(fileUploadErrorMessage('too_large', tVi)).toBe('File lớn hơn 100 MB')
    expect(
      downloadErrorMessage(new RequestError(404, '', 'x'), 'a.bin', tVi),
    ).toBe('a.bin không còn nữa')
    expect(
      documentErrorText(new RequestError(413, 'too_large', 'x'), tVi, 'vi'),
    ).toBe('Lớn hơn 30 MiB')
    expect(imageErrorText(new TypeError('offline'), tVi)).toBe(
      'Không tải được ảnh',
    )
  })

  it('writes sizes with the Vietnamese decimal mark', () => {
    expect(formatSize(1536, 'vi')).toBe('1,5 KiB')
    expect(formatSize(1023, 'vi')).toBe('1023 B')
  })
})
