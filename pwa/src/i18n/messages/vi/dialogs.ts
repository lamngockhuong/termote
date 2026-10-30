import type en from '../en/dialogs'
import type { Translation } from '../types'

export default {
  'dialogs.loadFailed.retry': 'Thử lại',
  'dialogs.pane.fallback': 'Pane {n}',
  'dialogs.paneMenu.label': 'Pane',
  'dialogs.paneMenu.splitRight': 'Chia sang phải',
  'dialogs.paneMenu.splitDown': 'Chia xuống dưới',
  'dialogs.paneMenu.zoom': 'Phóng to',
  'dialogs.paneMenu.swapNext': 'Đổi chỗ với pane kế tiếp',
  'dialogs.paneMenu.resize': 'Đổi cỡ',
  'dialogs.paneMenu.resizeLeft': 'Đổi cỡ sang trái',
  'dialogs.paneMenu.resizeRight': 'Đổi cỡ sang phải',
  'dialogs.paneMenu.resizeUp': 'Đổi cỡ lên trên',
  'dialogs.paneMenu.resizeDown': 'Đổi cỡ xuống dưới',
  'dialogs.paneMenu.close': 'Đóng pane',
  'dialogs.paneLayout.busy': 'Đang bận, hãy thử lại',
  'dialogs.paneLayout.unsupported': 'Không hỗ trợ cho pane này',
  'dialogs.paneLayout.failed': 'Không đổi được các pane',
  'dialogs.worktree.invalidName': 'Tên nhánh không hợp lệ',
  'dialogs.worktree.branchExists':
    'Nhánh này đã có; nó được mở ra nguyên trạng, không có nhánh gốc',
  'dialogs.worktree.createFailed':
    'Git từ chối: nhánh có thể đang được mở ở nơi khác, hoặc thư mục đã có',
  'dialogs.worktree.openFailed':
    'Đã tạo worktree nhưng không mở được; hãy dùng Mở worktree',
  'dialogs.worktree.linkedSource':
    'Hãy mở nó từ workspace của chính repository',
  'dialogs.worktree.changed': 'Worktree này đã đổi; hãy xem lại',
  'dialogs.worktree.ambiguous':
    'Có hơn một worktree dùng nhánh này; hãy mở nó trong Herdr',
  'dialogs.worktree.gone': 'Nó không còn nữa; danh sách đã được làm mới',
  'dialogs.worktree.busy':
    'Một thay đổi worktree khác vẫn đang chạy; hãy thử lại',
  'dialogs.worktree.unknown':
    'Herdr vẫn đang xử lý; lát nữa hãy xem lại danh sách',
  'dialogs.worktree.unsupported':
    'Herdr này không quản lý được worktree (cần bản 0.9.2 trở lên)',
  'dialogs.upload.tooLarge': 'Ảnh lớn hơn 10 MB',
  'dialogs.upload.heic':
    'Không hỗ trợ ảnh HEIC. Hãy chia sẻ ảnh dưới dạng JPEG',
  'dialogs.upload.storageFull':
    'Chỗ chứa file tải lên trên máy host đã đầy. Hãy thử lại sau',
  'dialogs.upload.unavailable': 'Server này không nhận ảnh tải lên',
  'dialogs.upload.network': 'Tải lên không thành công: lỗi mạng',
  'dialogs.upload.timeout':
    'Tải lên quá lâu. Hãy thử ảnh nhỏ hơn hoặc kết nối tốt hơn',
  'dialogs.upload.tooMany': 'Mỗi tin nhắn có tối đa {max} ảnh.',
  'dialogs.upload.gone': 'Không còn trên máy host',
  'dialogs.startAgent.paneBusy':
    'Pane này đang chạy một chương trình. Hãy khởi động agent trong pane chỉ hiện shell.',
  'dialogs.startAgent.codexUnsupported':
    'Server này không khởi động được Codex.',
  'dialogs.startAgent.herdrUnsupported':
    'Herdr này không khởi động được agent. Hãy cập nhật Herdr lên 0.8.2 trở lên.',
  'dialogs.startAgent.gone': 'Pane này không còn nữa.',
  'dialogs.startAgent.pending':
    'Herdr vẫn giữ lần khởi động trước trong pane này tới 30 giây. Lát nữa hãy thử lại.',
  'dialogs.startAgent.failed': 'Không khởi động được agent.',
  'dialogs.startAgent.lost':
    'Không theo dõi được lần khởi động. Hãy mở terminal để kiểm tra.',
  'dialogs.startAgent.readyElsewhere': '{agent} đã sẵn sàng ở một pane khác.',
  'dialogs.startAgent.askingHere': '{agent} đang hỏi gì đó trong terminal.',
  'dialogs.startAgent.askingElsewhere':
    '{agent} đang hỏi gì đó trong terminal của một pane khác.',
  'dialogs.startAgent.notStartedHere':
    '{agent} không khởi động được. Hãy mở terminal để xem lý do.',
  'dialogs.startAgent.notStartedElsewhere':
    '{agent} không khởi động được ở một pane khác.',
  'dialogs.devices.readFailed': 'Không đọc được danh sách thiết bị đã ghép',
  'dialogs.signins.readFailed':
    'Không đọc được danh sách trình duyệt đã đăng nhập',
  'dialogs.notify.blocked': 'Agent cần bạn',
  'dialogs.notify.done': 'Agent đã xong',
  'dialogs.notify.agent': 'Agent',
  'dialogs.notify.fallback': 'Có thể một agent đang cần bạn',
} satisfies Translation<typeof en>
