import type en from '../en/tour'
import type { Translation } from '../types'

export default {
  'tour.step': 'Bước {n}/{m}',
  'tour.skip': 'Bỏ qua',
  'tour.chipTitle': 'Phiên và cửa sổ',
  'tour.chipBody':
    'Chạm vào tên phiên để chuyển phiên hay cửa sổ, xem agent nào đang chờ, hoặc mở phiên mới.',
  'tour.viewMenuTitle': 'Một pane, năm cách xem',
  'tour.viewMenuBody': 'Nút này đổi cách xem pane đang mở.',
  'tour.viewTerminal': 'pane đang chạy, cập nhật trực tiếp.',
  'tour.viewChat':
    'phiên của agent dưới dạng tin nhắn; trả lời câu nó hỏi ngay tại đây.',
  'tour.viewFiles': 'duyệt và sửa file trong thư mục của pane.',
  'tour.viewChanges': 'xem diff git và commit.',
  'tour.viewTasks': 'chạy các script của dự án.',
  'tour.toolbarTitle': 'Những phím điện thoại không có',
  'tour.toolbarBody':
    '<kbd>Esc</kbd> <kbd>Ctrl</kbd>, các phím mũi tên và <kbd>Tab</kbd> chỉ cách một lần chạm. <kbd>⋯</kbd> mở thêm các hàng phím: dán, lịch sử, Home/End, PgUp/PgDn.',
  'tour.gesturesTitle': 'Cử chỉ trên terminal',
  'tour.swipeLeft': 'Vuốt trái',
  'tour.swipeRight': 'Vuốt phải',
  'tour.drag': 'Kéo lên / xuống',
  'tour.scroll': 'Cuộn lịch sử',
  'tour.pinch': 'Chụm hai ngón',
  'tour.fontSize': 'Cỡ chữ',
  'tour.gesturesFoot':
    'Danh sách đầy đủ có trong Hướng dẫn sử dụng; muốn xem lại hướng dẫn nhanh này thì vào Cài đặt.',
  'tour.sidebarTitle': 'Các phiên của bạn',
  'tour.sidebarBody':
    'Mọi phiên trên máy này, xếp theo nhóm. Agent nào đang chờ bạn sẽ có dấu hiệu riêng. <kbd>+</kbd> mở phiên mới, còn trang tổng quan agent cho thấy mọi agent cùng lúc.',
  'tour.viewsTitle': 'Các cách xem và panel bên cạnh',
  'tour.viewsPanel':
    '<b>{files}</b> và <b>{changes}</b> mở bên cạnh terminal, để bạn đọc code trong lúc agent đang làm.',
  'tour.panesTitle': 'Cửa sổ và pane',
  'tour.panesBody':
    'Các tab là cửa sổ của phiên này. Dải bên dưới liệt kê mọi pane trong cửa sổ: bấm vào một pane để chuyển sang nó, bấm <kbd>×</kbd> để đóng.',
  'tour.paletteTitle': 'Mọi thao tác, gọi bằng tên',
  'tour.paletteBody':
    'Bảng lệnh chạy được mọi thao tác: chuyển phiên, mở file, chạy tác vụ, đổi cài đặt.',
  'tour.allCommands': 'Mọi lệnh',
  'tour.goToFile': 'Mở nhanh file',
  'tour.paletteFoot':
    'Cài đặt có Hướng dẫn sử dụng, danh sách phím tắt và nút để xem lại hướng dẫn nhanh này.',
} satisfies Translation<typeof en>
