import { fireEvent, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AboutModal } from '../components/about-modal'
import {
  DevicesSection,
  originLabel,
  validityLabel,
} from '../components/devices-section'
import {
  PairDeviceSheet,
  pairProblem,
  validityNote,
  validityOptionLabel,
} from '../components/pair-device-sheet'
import { SettingsModal } from '../components/settings-modal'
import { browserLabel } from '../components/signins-section'
import type { DevicesState } from '../hooks/use-devices'
import { type PairedDevice, RequestError } from '../hooks/use-mux-api'
import { FIND_EXCLUDES_DEFAULT, type Settings } from '../hooks/use-settings'
import { templateErrorText, templateProblem } from '../utils/prompt-templates'
import { isRefusedChord } from '../utils/shortcuts'
import { userTaskErrorText, userTaskProblem } from '../utils/user-tasks'
import { tFor } from './i18n-context'
import { renderWithLocale } from './test-utils'

// Settings in Vietnamese: a few strings of each group, the dates and the
// accessible names a screen reader announces
const tVi = tFor('vi')

vi.mock('../utils/notify-permission', () => ({
  needsHomeScreenApp: () => false,
  notificationSupport: () => 'default',
  notifyWorkerReady: () => Promise.resolve(true),
  requestNotify: () => Promise.resolve('granted'),
}))

const devicesHook = vi.hoisted(() => ({
  state: null as unknown as DevicesState,
}))
vi.mock('../hooks/use-devices', () => ({
  useDevices: () => devicesHook.state,
}))

const SETTINGS: Settings = {
  herdrLayoutView: true,
  markdownEditLayout: 'split',
  imeSendBehavior: 'send-only',
  pasteSource: 'clipboard',
  toolbarDefaultExpanded: false,
  disableContextMenu: true,
  copyOnSelect: false,
  showSessionTabs: false,
  pollInterval: 5,
  welcomeSeenVersion: 0,
  language: 'auto',
  hasSeenLocalhostNotice: false,
  terminalFont: '',
  uiStyle: 'neutral',
  driveTerminalSize: false,
  sidebarFilter: 'all',
  sortBlockedFirst: false,
  markdownPreview: true,
  tablePreview: true,
  svgPreview: false,
  sidePanelWidth: 440,
  findIncludeIgnored: false,
  findExcludes: FIND_EXCLUDES_DEFAULT,
  searchCase: false,
  searchWord: false,
  searchRegex: false,
  notifyAgents: false,
  stuckMinutes: 10,
  showUsageChip: true,
  editorFontSize: 13,
  editorTabSize: 4,
  editorWrap: false,
  editorVim: false,
  taskHistoryLines: 400,
}

const device = (over: Partial<PairedDevice> = {}): PairedDevice => ({
  id: 'd1',
  name: 'Phone',
  role: 'view',
  createdAt: new Date().toISOString(),
  lastUsedAt: '',
  current: false,
  validUntil: null,
  expired: false,
  pairedBy: 'password',
  ...over,
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

describe('Settings in Vietnamese', () => {
  it('names the sheet, its groups and its rows', () => {
    renderWithLocale(
      <SettingsModal
        isOpen
        onClose={() => {}}
        settings={SETTINGS}
        onUpdateSetting={() => {}}
        onClearHistory={() => {}}
        historyCount={3}
      />,
      'vi',
    )
    expect(screen.getByRole('dialog', { name: 'Cài đặt' })).toBeTruthy()
    expect(
      screen.getByRole('navigation', { name: 'Các nhóm cài đặt' }),
    ).toBeTruthy()
    for (const group of ['Giao diện', 'Bàn phím', 'Terminal', 'Phiên', 'File'])
      expect(screen.getByRole('heading', { name: group })).toBeTruthy()
    expect(screen.getByRole('radio', { name: 'Trung tính' })).toBeTruthy()
    expect(screen.getByRole('radio', { name: 'Chỉ gửi chữ' })).toBeTruthy()
    // The paste buffer's name without one from the backend
    expect(screen.getByRole('radio', { name: 'Buffer của phiên' })).toBeTruthy()
    expect(
      screen.getByRole('switch', { name: 'Phiên đang chờ lên đầu' }),
    ).toBeTruthy()
    expect(
      screen.getByText(
        'Trang tổng quan đánh dấu agent đang chạy mà im lặng quá 10 phút',
      ),
    ).toBeTruthy()
    expect(
      screen.getByText('Bao lâu đồng bộ danh sách phiên một lần (5 giây)'),
    ).toBeTruthy()
    expect(screen.getByRole('option', { name: '2 phút' })).toBeTruthy()
    expect(
      screen.getByRole('button', { name: 'Xóa lịch sử lệnh (3)' }),
    ).toBeTruthy()
  })

  it('says why a folder cannot be excluded', () => {
    renderWithLocale(
      <SettingsModal
        isOpen
        onClose={() => {}}
        settings={SETTINGS}
        onUpdateSetting={() => {}}
      />,
      'vi',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Thêm' }))
    expect(screen.getByRole('alert').textContent).toBe('Hãy nhập tên thư mục')
    expect(screen.getByRole('button', { name: 'Bỏ node_modules' })).toBeTruthy()
  })

  it('lists the devices with the date in Vietnamese', () => {
    devicesHook.state = {
      devices: [device({ current: true, validUntil: '2026-10-17T12:00:00Z' })],
      error: null,
      refresh: vi.fn(async () => {}),
      revoke: vi.fn(async () => []),
      pair: vi.fn(),
    } as unknown as DevicesState
    renderWithLocale(<DevicesSection />, 'vi')
    expect(screen.getByRole('list', { name: 'Thiết bị đã ghép' })).toBeTruthy()
    expect(screen.getByText('Thiết bị này')).toBeTruthy()
    expect(screen.getByText(/^Chỉ xem · ghép /)).toBeTruthy()
    expect(screen.getByText('· Còn hiệu lực đến 17 thg 10, 2026')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Thu hồi Phone' })).toBeTruthy()
  })

  it('names where a device came from and how long it stays', () => {
    expect(validityLabel(device({ expired: true }), tVi, 'vi')).toBe(
      'Đã hết hạn',
    )
    expect(originLabel(device(), tVi)).toBe(
      'Ghép bằng mật khẩu, vẫn giữ khi một trình duyệt đăng xuất',
    )
    expect(
      originLabel(device({ pairedBy: 'd2', pairedByName: 'Laptop' }), tVi),
    ).toBe('Do Laptop ghép')
    expect(validityNote(7 * 86400, tVi)).toBe('đăng nhập được 7 ngày')
    expect(validityNote(3600, tVi)).toBe('đăng nhập được 1 giờ')
    expect(validityOptionLabel(86400, tVi)).toBe('1 ngày')
    expect(validityOptionLabel(null, tVi)).toBe('Không bao giờ hết')
    expect(pairProblem(new RequestError(429, 'too_many_codes', 'x'), tVi)).toBe(
      'Đang có quá nhiều mã chờ dùng. Hãy dùng một mã, hoặc đợi 5 phút',
    )
  })

  it('pairs a device in Vietnamese', () => {
    renderWithLocale(
      <PairDeviceSheet
        isOpen
        onClose={() => {}}
        onPair={vi.fn()}
        canPairFull={false}
      />,
      'vi',
    )
    expect(screen.getByRole('dialog', { name: 'Ghép thiết bị' })).toBeTruthy()
    expect(
      screen.getByText(/^Chỉ xem\. Xem được terminal, Chat và File/),
    ).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Tạo mã' })).toBeTruthy()
  })

  it('names a browser and says why a shortcut is refused', () => {
    expect(
      browserLabel('Mozilla/5.0 (X11; Linux x86_64) Firefox/131.0', tVi),
    ).toBe('Firefox trên Linux')
    expect(browserLabel('', tVi)).toBe('Trình duyệt không rõ')
    expect(tVi(isRefusedChord('Mod+S', false) ?? 'settings.edit')).toBe(
      'Trình sửa đang dùng',
    )
  })

  it('says what keeps a template or a task from being saved', () => {
    expect(templateProblem('', 'x', tVi)?.message).toBe('Hãy đặt tên cho mẫu')
    expect(templateErrorText({ code: 'name_taken' }, tVi)).toBe(
      'Đã có mẫu mang tên này',
    )
    expect(userTaskProblem('a', '', tVi)?.message).toBe('Hãy nhập lệnh')
    expect(userTaskErrorText({ code: 'too_many' }, tVi)).toBe(
      'Tối đa 100 tác vụ',
    )
  })

  it('shows About in Vietnamese', () => {
    renderWithLocale(
      <AboutModal isOpen onClose={() => {}} onCheckUpdates={() => {}} />,
      'vi',
    )
    expect(screen.getByRole('dialog', { name: 'Về Termote' })).toBeTruthy()
    expect(screen.getByText('Tác giả')).toBeTruthy()
    expect(
      screen.getByRole('button', { name: /^Kiểm tra cập nhật/ }),
    ).toBeTruthy()
    expect(screen.getByRole('link', { name: /^Tài liệu/ })).toBeTruthy()
  })
})
