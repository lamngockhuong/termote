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
  'dialogs.paneMenu.resize': 'Đổi kích thước',
  'dialogs.paneMenu.resizeLeft': 'Đổi kích thước sang trái',
  'dialogs.paneMenu.resizeRight': 'Đổi kích thước sang phải',
  'dialogs.paneMenu.resizeUp': 'Đổi kích thước lên trên',
  'dialogs.paneMenu.resizeDown': 'Đổi kích thước xuống dưới',
  'dialogs.paneMenu.close': 'Đóng pane',
  'dialogs.paneMenu.rename': 'Đổi tên pane',
  'dialogs.paneRename.title': 'Đổi tên pane',
  'dialogs.paneRename.label': 'Tên',
  'dialogs.paneRename.placeholder': 'ví dụ: api, tests',
  'dialogs.paneRename.hint': 'Để trống để xóa tên',
  'dialogs.paneRename.save': 'Lưu',
  'dialogs.paneRename.tooLong': 'Tối đa {n} byte',
  'dialogs.paneRename.invalid':
    "Tên không được bắt đầu bằng '-', kết thúc bằng ';' hay chứa ký tự điều khiển",
  'dialogs.paneRename.failed': 'Không đổi được tên pane',
  'dialogs.paneLayout.busy': 'Đang bận, hãy thử lại',
  'dialogs.paneLayout.unsupported': 'Không hỗ trợ cho pane này',
  'dialogs.paneLayout.failed': 'Không thay đổi được bố cục pane',
  'dialogs.worktree.invalidName': 'Tên nhánh không hợp lệ',
  'dialogs.worktree.branchExists':
    'Nhánh này đã tồn tại nên được checkout nguyên trạng, không dựa trên nhánh gốc',
  'dialogs.worktree.createFailed':
    'Git từ chối: có thể nhánh đang được checkout ở nơi khác, hoặc thư mục đã tồn tại',
  'dialogs.worktree.openFailed':
    'Đã tạo worktree nhưng không mở được; hãy dùng “Mở worktree”',
  'dialogs.worktree.linkedSource':
    'Hãy mở nó từ workspace của chính repository',
  'dialogs.worktree.changed': 'Worktree này đã đổi; hãy xem lại',
  'dialogs.worktree.ambiguous': 'Có hơn một worktree dùng nhánh này',
  'dialogs.worktree.gone': 'Worktree này không còn nữa; đã làm mới danh sách',
  'dialogs.worktree.busy':
    'Một thay đổi worktree khác vẫn đang chạy; hãy thử lại',
  'dialogs.worktree.unknown':
    'Thay đổi vẫn đang chạy; lát nữa hãy xem lại danh sách',
  'dialogs.worktree.unsupported': 'Backend này không quản lý được worktree',
  'dialogs.worktree.inUse':
    'Một chương trình vẫn đang mở file trong worktree. Các workspace của nó đã đóng và chưa có gì bị xóa; hãy đóng chương trình đó rồi xóa lại',
  'dialogs.upload.tooLarge': 'Ảnh lớn hơn 10 MB',
  'dialogs.upload.heic':
    'Không hỗ trợ ảnh HEIC. Hãy chia sẻ ảnh dưới dạng JPEG',
  'dialogs.upload.storageFull':
    'Máy host đã hết chỗ lưu file tải lên. Hãy thử lại sau',
  'dialogs.upload.unavailable': 'Server này không nhận ảnh tải lên',
  'dialogs.upload.network': 'Không tải lên được: lỗi mạng',
  'dialogs.upload.timeout':
    'Tải lên mất quá lâu. Hãy thử ảnh nhỏ hơn hoặc kết nối tốt hơn',
  'dialogs.upload.tooMany': 'Mỗi tin nhắn chỉ đính kèm được tối đa {max} ảnh.',
  'dialogs.upload.gone': 'Không còn trên máy host',
  'dialogs.startAgent.paneBusy':
    'Pane này đang chạy một chương trình. Hãy khởi động agent trong một pane đang ở dấu nhắc shell.',
  'dialogs.startAgent.codexUnsupported':
    'Server này không khởi động được Codex.',
  'dialogs.startAgent.opencodeUnsupported':
    'Herdr này không khởi động được OpenCode. Hãy cập nhật Herdr.',
  'dialogs.startAgent.herdrUnsupported':
    'Herdr này không khởi động được agent. Hãy cập nhật Herdr lên 0.8.2 trở lên.',
  'dialogs.startAgent.gone': 'Pane này không còn nữa.',
  'dialogs.startAgent.pending':
    'Herdr còn giữ lượt khởi động trước trong pane này (tối đa 30 giây). Hãy thử lại sau giây lát.',
  'dialogs.startAgent.failed': 'Không khởi động được agent.',
  'dialogs.startAgent.lost':
    'Mất dấu quá trình khởi động. Hãy mở terminal để kiểm tra.',
  'dialogs.startAgent.readyElsewhere': '{agent} đã sẵn sàng ở một pane khác.',
  'dialogs.startAgent.askingHere': '{agent} đang hỏi bạn trong terminal.',
  'dialogs.startAgent.askingElsewhere':
    '{agent} đang hỏi bạn trong terminal của một pane khác.',
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
  'dialogs.notify.settings': 'Agent đề xuất thay đổi cài đặt',
  'dialogs.notify.jobReview': 'Việc chờ bạn xem lại',
  'dialogs.notify.jobFallback': 'Có một việc đang chờ bạn xem lại',
} satisfies Translation<typeof en>
