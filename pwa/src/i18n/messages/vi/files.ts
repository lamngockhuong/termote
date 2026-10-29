import type en from '../en/files'
import type { Translation } from '../types'

export default {
  'files.trash': 'Thùng rác',
  'files.trash.scope':
    'Ở đây chỉ có những gì đã xoá khi thư mục này là thư mục gốc. Thứ xoá từ thư mục khác (trước khi cd, hay từ một place hoặc repository chứa thư mục này) nằm trong thùng rác của thư mục đó.',
  'files.trash.loading': 'Đang tải…',
  'files.trash.unreadable': 'Không đọc được thùng rác',
  'files.trash.retry': 'Thử lại',
  'files.trash.empty':
    'Thùng rác trống. File trên hệ thống file khác với thùng rác bị xoá vĩnh viễn, nên không bao giờ có ở đây.',
  'files.trash.truncated': 'Đang hiện 500 mục mới nhất',
  'files.trash.list': 'Các mục đã xoá',
  'files.trash.sensitive': 'Nhạy cảm',
  'files.trash.kind.file': 'File',
  'files.trash.kind.dir': 'Thư mục',
  'files.trash.kind.discard': 'Thay đổi đã bỏ',
  'files.trash.removedBy': 'Bị dọn muộn nhất vào {date}',
  'files.trash.discardNote':
    'Khôi phục sẽ ghi đè nội dung hiện tại của file, và chỉ làm được khi file chưa đổi từ lúc bỏ thay đổi',
  'files.trash.restore': 'Khôi phục',
  'files.trash.restoreName': 'Khôi phục {name}',
  'files.trash.restoreDiscard': 'Khôi phục nội dung đã bỏ',
  'files.trash.restoreDiscardName': 'Khôi phục nội dung đã bỏ của {name}',
  'files.trash.deleteForGood': 'Xoá vĩnh viễn',
  'files.trash.deleteForGoodName': 'Xoá vĩnh viễn {name}',
  'files.trash.emptyTrash': 'Dọn sạch thùng rác',
  'files.trash.askSensitive': 'Đây là file nhạy cảm',
  'files.trash.askSensitiveBody':
    '{name} có thể chứa bí mật. Khôi phục file này?',
  'files.trash.askDelete': 'Xoá vĩnh viễn?',
  'files.trash.askDeleteBody': '{name} sẽ bị xoá. Không hoàn tác được.',
  'files.trash.askEmpty': 'Dọn sạch thùng rác?',
  'files.trash.askEmptyBody_other':
    'Cả {count} mục đang hiện sẽ bị xoá. Không hoàn tác được.',
  'files.trash.askEmptyNewest':
    'Chỉ {count} mục mới nhất đang hiện sẽ bị xoá; các mục cũ hơn vẫn còn. Không hoàn tác được.',
  'files.trash.gone': 'Đã được khôi phục hoặc xoá',
  'files.trash.restored': 'Đã khôi phục {name}',
  'files.trash.deleted': 'Đã xoá vĩnh viễn {name}',
  'files.trash.deleteFailed': 'Không xoá được {name}',
  'files.trash.emptied': 'Đã xoá vĩnh viễn {count} mục',
  'files.trash.emptyFailed': '{count} mục chưa xoá được; hãy thử lại',
  'files.trash.emptyError': 'Không dọn được thùng rác',
} satisfies Translation<typeof en>
