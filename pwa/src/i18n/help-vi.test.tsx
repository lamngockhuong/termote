import { fireEvent, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HelpModal } from '../components/help-modal'
import { renderWithLocale } from './test-utils'

// The Usage Guide in Vietnamese: words translated, keys as they are typed

// jsdom has no modal dialog
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (
    this: HTMLDialogElement,
  ) {
    this.setAttribute('open', '')
  })
  HTMLDialogElement.prototype.close = vi.fn()
})

const open = (copyModeSupported = true) =>
  renderWithLocale(
    <HelpModal
      isOpen
      onClose={vi.fn()}
      copyModeSupported={copyModeSupported}
    />,
    'vi',
  )

describe('Usage Guide in Vietnamese', () => {
  it('the title, the topics and the close button', () => {
    open()
    expect(
      screen.getByRole('dialog', { name: 'Hướng dẫn sử dụng' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('radiogroup', { name: 'Chủ đề hướng dẫn' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Cử chỉ' })).toBeInTheDocument()
    expect(
      screen.getByRole('radio', { name: 'Thanh phím' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'tmux' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Đóng' })).toBeInTheDocument()
  })

  it('the gestures, named in words', () => {
    open()
    expect(screen.getByText('Cử chỉ chạm')).toBeInTheDocument()
    expect(screen.getByText('Vuốt trái')).toBeInTheDocument()
    expect(screen.getByText('Ngắt (Ctrl+C)')).toBeInTheDocument()
    expect(screen.getByText('Nhấn giữ')).toBeInTheDocument()
  })

  it('the toolbar: keycaps kept, rows by the names the toolbar shows', () => {
    open()
    fireEvent.click(screen.getByRole('radio', { name: 'Thanh phím' }))
    expect(screen.getByText('Esc')).toBeInTheDocument()
    expect(screen.getByText('^⇧C')).toBeInTheDocument()
    expect(
      screen.getByText('Sao chép phần đã chọn, không có thì gửi ^⇧C'),
    ).toBeInTheDocument()
    expect(screen.getByText('Phím tiền tố của tmux')).toBeInTheDocument()
    for (const row of ['Thao tác', 'Chữ · Cuộn', 'Di chuyển', 'Chat']) {
      expect(screen.getByText(row)).toBeInTheDocument()
    }
    expect(
      screen.getByText(
        'Lịch sử, dán, đính kèm ảnh, chọn chữ, chế độ sao chép, lên/xuống một trang',
      ),
    ).toBeInTheDocument()
  })

  it('the agent statuses, named as in Tasks', () => {
    open()
    fireEvent.click(screen.getByRole('radio', { name: 'Thanh phím' }))
    expect(screen.getByText('Trạng thái agent')).toBeInTheDocument()
    expect(
      screen.getByText('Chờ bạn: agent đang đợi bạn trả lời'),
    ).toBeInTheDocument()
    for (const status of ['Đang chạy', 'Xong', 'Rảnh']) {
      expect(screen.getByText(status)).toBeInTheDocument()
    }
  })

  it('the rows a backend without copy mode shows', () => {
    open(false)
    fireEvent.click(screen.getByRole('radio', { name: 'Thanh phím' }))
    expect(screen.getByText('Dán từ clipboard hệ thống')).toBeInTheDocument()
    expect(screen.getByText('Lùi con trỏ một ký tự')).toBeInTheDocument()
    expect(
      screen.getByText('Lịch sử, dán, đính kèm ảnh, chọn chữ, cuộn lên/xuống'),
    ).toBeInTheDocument()
    expect(screen.queryByText('Phím tiền tố của tmux')).not.toBeInTheDocument()
  })

  it('tmux: the prefix and the keys as tmux takes them', () => {
    open()
    fireEvent.click(screen.getByRole('radio', { name: 'tmux' }))
    expect(screen.getByText('Cửa sổ (Ctrl+B, rồi...)')).toBeInTheDocument()
    expect(screen.getByText('%')).toBeInTheDocument()
    expect(screen.getByText('Chia sang phải')).toBeInTheDocument()
    expect(screen.getByText('"')).toBeInTheDocument()
    expect(screen.getByText('Chia xuống dưới')).toBeInTheDocument()
    expect(screen.getByText('Tách khỏi phiên')).toBeInTheDocument()
  })

  it('the documentation link says it opens a new tab', () => {
    open()
    const link = screen.getByRole('link', { name: /^Tài liệu đầy đủ/ })
    expect(link).toHaveTextContent('Tài liệu đầy đủ (mở trong tab mới)')
  })
})
