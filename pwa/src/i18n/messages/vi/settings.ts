import type en from '../en/settings'
import type { Translation } from '../types'

export default {
  'settings.language': 'Ngôn ngữ của màn chào và hướng dẫn',
  'settings.languageDesc': 'Tự động theo ngôn ngữ trình duyệt',
  'settings.languageAuto': 'Tự động',
  'settings.takeTour': 'Xem hướng dẫn nhanh',
  'settings.showWelcome': 'Hiện màn chào',
  'settings.groups': 'Các nhóm cài đặt',
  'settings.group.appearance': 'Giao diện',
  'settings.group.keyboard': 'Bàn phím',
  'settings.group.shortcuts': 'Phím tắt',
  'settings.group.sessions': 'Phiên',
  'settings.group.devices': 'Thiết bị',
  'settings.group.signins': 'Trình duyệt đã đăng nhập',
  'settings.group.templates': 'Mẫu prompt',
  'settings.group.updates': 'Cập nhật',
  'settings.group.data': 'Dữ liệu và trợ giúp',

  'settings.style': 'Kiểu giao diện',
  'settings.styleDesc': 'Đổi ngay khi chọn. Chế độ màu vẫn nằm trong menu ⋯.',
  'settings.style.neutral': 'Trung tính',
  'settings.style.terminal': 'Terminal',
  'settings.style.native': 'Gốc',

  'settings.ime': 'Khi gửi chữ từ ô nhập',
  'settings.ime.sendOnly': 'Chỉ gửi chữ',
  'settings.ime.sendOnlyDesc': 'Gửi chữ vào terminal, không nhấn Enter',
  'settings.ime.sendEnter': 'Gửi + Enter',
  'settings.ime.sendEnterDesc': 'Gửi chữ rồi tự nhấn Enter',
  'settings.paste': 'Nút dán lấy từ đâu',
  'settings.paste.clipboard': 'Clipboard hệ thống',
  'settings.paste.clipboardDesc':
    'Dán từ clipboard của thiết bị (Ctrl+Shift+V)',
  'settings.paste.bufferDesc': 'Dán từ buffer của chế độ sao chép',
  'settings.toolbarExpanded': 'Mở sẵn toàn bộ thanh phím',
  'settings.toolbarExpandedDesc':
    'Hiện đủ các phím ngay khi thanh phím hiện ra',

  'settings.font': 'Phông chữ terminal',
  'settings.fontDesc':
    'Một phông đã cài trên thiết bị này (ví dụ Nerd Font). Biểu tượng Nerd Font vẫn hiện được khi không có.',
  'settings.contextMenu': 'Tắt menu chuột phải',
  'settings.contextMenuDesc': 'Không mở menu ngữ cảnh trên vùng terminal',
  'settings.copyOnSelect': 'Chọn là sao chép',
  'settings.copyOnSelectDesc':
    'Chữ bôi đen bằng chuột được sao chép ngay khi nhả nút',
  'settings.fitPane': 'Chỉnh pane herdr vừa thiết bị này',
  'settings.fitPaneDesc':
    'Khi terminal đang hiện; cỡ pane trên máy tính cũng đổi theo, cho tới khi trang này bị ẩn hoặc đóng, mở cách xem khác, hay thiết bị khác giành quyền',
  'settings.layoutView': 'Hiện các pane herdr cạnh nhau',
  'settings.layoutViewDesc':
    'Trên máy tính, tab có 2 đến 4 pane hiện các pane theo đúng bố cục của herdr; khi tắt, hoặc khi chữ sẽ quá nhỏ để đọc, mỗi lần một pane',

  'settings.tabs': 'Hiện tab phiên',
  'settings.tabsDesc': 'Thanh tab để chuyển phiên nhanh (máy tính)',
  'settings.blockedFirst': 'Phiên đang chờ lên đầu',
  'settings.blockedFirstDesc':
    'Phiên nào đang chờ bạn thì xếp lên đầu nhóm của nó',
  'settings.notify': 'Báo khi agent cần tôi',
  'settings.notify.homeScreen':
    'iPhone/iPad: chỉ chạy khi mở từ app trên màn hình chính (iOS 16.4 trở lên)',
  'settings.notify.denied': 'Đã bị chặn trong cài đặt trình duyệt',
  'settings.notify.reload': 'Tải lại trang để bật',
  'settings.notify.desc':
    'Khi có hộp thoại đang chờ hoặc một lượt vừa xong. Trên điện thoại, cần app đã cài',
  'settings.stuck': 'Agent bị kẹt',
  'settings.stuckDesc':
    'Trang tổng quan đánh dấu agent đang chạy mà im lặng quá {minutes} phút',
  'settings.stuckAfter': 'Agent bị coi là kẹt sau',
  'settings.minutes': '{n} phút',
  'settings.usage': 'Mức dùng của agent trên thanh tiêu đề',
  'settings.usageDesc':
    'Cho biết context của agent trong pane đang mở đã đầy bao nhiêu, và hạn mức Codex của nó',
  'settings.poll': 'Chu kỳ cập nhật danh sách phiên',
  'settings.pollDesc': 'Bao lâu đồng bộ danh sách phiên một lần ({interval})',
  'settings.pollSeconds': '{n} giây',
  'settings.pollMinutes': '{n} phút',

  'settings.excluded': 'Thư mục bỏ qua',
  'settings.excludedDesc':
    'Không bao giờ tìm file bị git bỏ qua trong các thư mục này, và không tìm trong chúng khi ở ngoài repository. File git theo dõi thì luôn được tìm.',
  'settings.excluded.list': 'Các thư mục không bao giờ tìm',
  'settings.excluded.remove': 'Bỏ {name}',
  'settings.excluded.placeholder': 'Tên thư mục',
  'settings.excluded.add': 'Thêm',
  'settings.excluded.reset': 'Về mặc định',
  'settings.excluded.listed': 'Đã có trong danh sách',
  'settings.excluded.max': 'Tối đa {max} thư mục',
  'settings.excluded.empty': 'Hãy nhập tên thư mục',
  'settings.excluded.notName': 'Không phải tên thư mục',
  'settings.excluded.path': 'Chỉ một tên thư mục, không phải đường dẫn',
  'settings.excluded.pattern': 'Một cái tên, không phải mẫu tìm kiếm',
  'settings.excluded.tooLong': 'Tên quá dài',
  'settings.wrap': 'Xuống dòng tự động',
  'settings.wrapDesc':
    'Mở file là dòng dài tự xuống dòng, trên máy tính cũng vậy',
  'settings.fontSize': 'Cỡ chữ của trình sửa',
  'settings.fontSizeDesc':
    'Trình sửa trên máy tính (điện thoại sửa trong ô chữ thường)',
  'settings.px': '{n} px',
  'settings.tabSize': 'Độ rộng tab',
  'settings.tabSizeDesc':
    'Trình sửa trên máy tính: số cột của một tab và của một mức thụt lề',
  'settings.vim': 'Chế độ Vim',
  'settings.vimDesc': 'Trình sửa trên máy tính: phím Vim; :w để lưu',

  'settings.taskHistory': 'Lịch sử đọc khi gửi cho agent',
  'settings.taskHistoryDesc':
    'Số dòng trong tab của tác vụ được dò để tìm output của lần chạy; chỉ phần output của chính lần chạy đó được gửi',
  'settings.taskLines': '{n} dòng',

  'settings.clearHistory': 'Xóa lịch sử lệnh ({count})',

  'settings.edit': 'Sửa',
  'settings.editName': 'Sửa {name}',
  'settings.delete': 'Xóa',
  'settings.deleteName': 'Xóa {name}',
  'settings.deleteTitle': 'Xóa {name}?',
  'settings.deleteAgain': 'Đã bị đổi trên thiết bị khác: vẫn xóa?',
  'settings.deleted': 'Đã xóa {name}',
  'settings.deleteBody': 'Mọi thiết bị của server này sẽ mất {name}.',
  'settings.name': 'Tên',
  'settings.save': 'Lưu',
  'settings.changedElsewhere': 'Đã bị đổi trên thiết bị khác',
  'settings.deletedElsewhere': 'Đã bị xóa trên thiết bị khác',
  'settings.loadTheirs': 'Lấy bản kia',
  'settings.keepMine': 'Giữ bản của tôi',
  'settings.saveAsNew': 'Lưu thành bản mới',
  'settings.nameTooLong': 'Tên dài quá {max} ký tự',
  'settings.nameHidden': 'Tên chứa ký tự ẩn ({code})',
  'settings.notSaved': 'Chưa lưu: {message}',
  'settings.viewOnly': 'Thiết bị này chỉ được xem',
  'settings.tooLarge': 'Quá lớn, không lưu được',
  'settings.used': 'dùng {ago}',
  'settings.paired': 'ghép {ago}',
  'settings.copied': 'Đã sao chép',
  'settings.securityModel': 'Mô hình bảo mật',
  'settings.newTab': '(mở trong tab mới)',

  'settings.devices.intro':
    'Thiết bị đã ghép đăng nhập mà không cần mật khẩu. Đổi mật khẩu (termote start --fresh) sẽ thu hồi tất cả.',
  'settings.devices.full': 'Toàn quyền',
  'settings.devices.viewOnly': 'Chỉ xem',
  'settings.devices.byPassword':
    'Ghép bằng mật khẩu, vẫn giữ khi một trình duyệt đăng xuất',
  'settings.devices.unknownOrigin': 'Không rõ nguồn',
  'settings.devices.fromSignin': 'Ghép từ một trình duyệt đã đăng nhập ({id})',
  'settings.devices.pairedBy': 'Do {name} ghép',
  'settings.devices.byRemoved': 'Thiết bị ghép nó đã bị xóa',
  'settings.devices.expired': 'Đã hết hạn',
  'settings.devices.validUntil': 'Còn hiệu lực đến {date}',
  'settings.devices.revoked': 'Đã thu hồi {name}',
  'settings.devices.revokedAlso':
    'Đã thu hồi {name} cùng các thiết bị nó đã ghép: {names}',
  'settings.devices.revokeFailed': 'Không thu hồi được {name}. Hãy thử lại',
  'settings.devices.none': 'Chưa có thiết bị nào được ghép.',
  'settings.devices.list': 'Thiết bị đã ghép',
  'settings.devices.thisDevice': 'Thiết bị này',
  'settings.devices.revoke': 'Thu hồi',
  'settings.devices.revokeName': 'Thu hồi {name}',
  'settings.devices.pair': 'Ghép thiết bị',
  'settings.devices.confirmTitle': 'Thu hồi thiết bị này?',
  'settings.devices.confirmCurrent':
    'Đây là thiết bị bạn đang dùng: nó bị đăng xuất ngay.',
  'settings.devices.confirmOther':
    '{name} bị đăng xuất ở lần gửi yêu cầu tiếp theo, và các terminal nó đang mở sẽ đóng.',
  'settings.devices.confirmPaired':
    'Các thiết bị nó đã ghép cũng bị thu hồi theo: {names}.',
  'settings.devices.confirmFull':
    'Thiết bị toàn quyền có thể đã mở terminal trên máy này. Để chắc chắn không còn gì nó để lại, hãy chạy thêm <code>termote start --fresh</code>.',

  'settings.signins.intro':
    'Đăng xuất sẽ hủy cookie của trình duyệt đó. Nếu mật khẩu có thể đã lộ, hãy chạy <code>termote start --fresh</code>.',
  'settings.signins.viaForm': 'Trang đăng nhập',
  'settings.signins.viaBasic': 'Basic auth',
  'settings.signins.viaLink': 'Link từ CLI',
  'settings.signins.browserOn': '{browser} trên {system}',
  'settings.signins.aBrowserOn': 'Một trình duyệt trên {system}',
  'settings.signins.unknown': 'Trình duyệt không rõ',
  'settings.signins.signedOutOthers_other':
    'Đã đăng xuất {count} trình duyệt khác',
  'settings.signins.signedOut': 'Đã đăng xuất {name}',
  'settings.signins.keptOthers':
    'Đã đăng xuất các trình duyệt khác, nhưng không thu hồi được các thiết bị ghép từ chúng. Hãy thu hồi trong Thiết bị',
  'settings.signins.keptOne':
    'Đã đăng xuất {name}, nhưng không thu hồi được các thiết bị ghép từ nó. Hãy thu hồi trong Thiết bị',
  'settings.signins.failedOthers':
    'Không đăng xuất được các trình duyệt khác. Hãy thử lại',
  'settings.signins.failedOne': 'Không đăng xuất được {name}. Hãy thử lại',
  'settings.signins.none': 'Chưa có trình duyệt nào đăng nhập bằng mật khẩu.',
  'settings.signins.thisBrowser': 'Trình duyệt này',
  'settings.signins.signOut': 'Đăng xuất',
  'settings.signins.signOutName': 'Đăng xuất {name}',
  'settings.signins.signOutCurrent': 'Đăng xuất {name} (trình duyệt này)',
  'settings.signins.signOutOthers': 'Đăng xuất mọi trình duyệt khác',
  'settings.signins.confirmOthersTitle': 'Đăng xuất mọi trình duyệt khác?',
  'settings.signins.confirmTitle': 'Đăng xuất trình duyệt này?',
  'settings.signins.confirmOthers_other':
    '{count} trình duyệt bị đăng xuất ở lần gửi yêu cầu tiếp theo, và các terminal chúng đang mở sẽ đóng. Các thiết bị ghép từ chúng cũng bị thu hồi. Trình duyệt này vẫn đăng nhập.',
  'settings.signins.confirmCurrent':
    'Đây là trình duyệt bạn đang dùng: nó bị đăng xuất ngay.',
  'settings.signins.confirmCurrentDevices':
    'Đây là trình duyệt bạn đang dùng: nó bị đăng xuất ngay. Các thiết bị ghép từ nó cũng bị thu hồi.',
  'settings.signins.confirmOther':
    '{name} bị đăng xuất ở lần gửi yêu cầu tiếp theo, và các terminal nó đang mở sẽ đóng. Các thiết bị ghép từ nó cũng bị thu hồi.',

  'settings.updates.howRelease':
    'Chạy trong một terminal trên máy chủ (terminal của Termote cũng được):',
  'settings.updates.howContainer':
    'Chạy trên máy chủ, không chạy trong container này (container dựng từ một checkout thì: git pull, rồi termote container up --build):',
  'settings.updates.howCheckout':
    'Server này chạy từ một git checkout: hãy pull, build lại và khởi động lại ở đó.',
  'settings.updates.howUnknown': 'Hãy cập nhật theo cách đã dùng để cài nó.',
  'settings.updates.failed':
    'Không kết nối được GitHub để kiểm tra bản cập nhật.',
  'settings.updates.checkingFor': 'Đang kiểm tra bản cập nhật…',
  'settings.updates.available': 'Đã có phiên bản {version}.',
  'settings.updates.newest': 'Bạn đang dùng phiên bản mới nhất.',
  'settings.updates.running': 'Đang chạy v{version}',
  'settings.updates.checked': 'Mới nhất v{version} · kiểm tra {ago}',
  'settings.updates.notChecked': 'Chưa kiểm tra',
  'settings.updates.checking': 'Đang kiểm tra…',
  'settings.updates.check': 'Kiểm tra cập nhật',
  'settings.updates.stale': 'Trang này là v{page}; tải lại để dùng v{server}.',
  'settings.updates.reloading': 'Đang tải lại…',
  'settings.updates.reload': 'Tải lại',
  'settings.updates.copy': 'Sao chép',
  'settings.updates.commandCopied': 'Đã sao chép lệnh',
  'settings.updates.notes': 'Ghi chú phát hành v{version}',
  'settings.star.prompt':
    'Đã cập nhật lên v{version}. Nếu Termote có ích với bạn, một ngôi sao trên GitHub giúp người khác tìm thấy nó.',
  'settings.star.link': 'Gắn sao trên GitHub',
  'settings.star.decline': 'Không, cảm ơn',

  'settings.shortcuts.intro':
    'Lưu trên thiết bị này. Phím mà trình duyệt xử lý trước (như {key}) sẽ không tới được app.',
  'settings.shortcuts.filter': 'Lọc phím tắt',
  'settings.shortcuts.filterPlaceholder': 'Lọc theo tên hoặc phím',
  'settings.shortcuts.resetAll': 'Đặt lại mọi phím tắt',
  'settings.shortcuts.none': 'Không có phím tắt nào khớp',
  'settings.shortcuts.resetAllTitle': 'Đặt lại mọi phím tắt?',
  'settings.shortcuts.resetAllConfirm': 'Đặt lại tất cả',
  'settings.shortcuts.resetAllBody': 'Mọi lệnh trở về phím mặc định.',
  'settings.shortcuts.useMod': 'Hãy dùng {mod} kèm một phím',
  'settings.shortcuts.unusable': 'Không dùng được phím này',
  'settings.shortcuts.browserKeeps': 'Trình duyệt giữ phím này',
  'settings.shortcuts.usedByEditor': 'Trình sửa đang dùng',
  'settings.shortcuts.usedByTerminal': 'Terminal đang dùng',
  'settings.shortcuts.usedForText': 'Dùng để sửa chữ',
  'settings.shortcuts.alsoUsedBy': '{name} cũng dùng phím này',
  'settings.shortcuts.replacedBy': 'Đã nhường cho phím tắt bạn đặt cho {name}',
  'settings.shortcuts.noKey': 'Không có phím',
  'settings.shortcuts.change': 'Đổi',
  'settings.shortcuts.changeName': 'Đổi phím của {name}',
  'settings.shortcuts.pressKeys': 'Nhấn phím…',
  'settings.shortcuts.remove': 'Bỏ',
  'settings.shortcuts.removeName': 'Bỏ phím của {name}',
  'settings.shortcuts.reset': 'Đặt lại',
  'settings.shortcuts.resetName': 'Đặt lại phím của {name}',
  'settings.shortcuts.inTerminalName': '{name}: chạy cả trong terminal',
  'settings.shortcuts.terminalUses': 'Terminal dùng phím này',
  'settings.shortcuts.inTerminal': 'Chạy cả trong terminal',
  'settings.shortcuts.recording': 'Nhấn phím mới cho {name}, hoặc Escape',

  'settings.templates.intro':
    'Lưu trên server này, mọi thiết bị đăng nhập vào nó đều dùng chung. Chèn từ Chat bằng nút Mẫu, danh sách / hoặc Bảng lệnh.',
  'settings.templates.viewOnly':
    'Thiết bị này chỉ được xem: có thể đọc và xuất các mẫu.',
  'settings.templates.newer':
    'Một bản Termote mới hơn đã lưu chúng; hãy cập nhật để sửa mẫu.',
  'settings.templates.readFailed': 'Không đọc được các mẫu',
  'settings.templates.none': 'Chưa có mẫu nào.',
  'settings.templates.new': 'Mẫu mới',
  'settings.templates.import': 'Nhập…',
  'settings.templates.export': 'Xuất',
  'settings.templates.exportFirst':
    'Hãy xuất trước để giữ một bản: nhập rồi thì không hoàn tác được.',
  'settings.templates.file': 'File mẫu cần nhập',
  'settings.templates.deleteFailed': 'Không xóa được mẫu',
  'settings.templates.exportFailed': 'Không xuất được các mẫu',
  'settings.templates.fileTooLarge': 'File lớn hơn {size} MB',
  'settings.templates.readFileFailed': 'Không đọc được file',
  'settings.templates.imported': 'Đã nhập: thêm {added}, thay {replaced}',
  'settings.templates.at': 'Mẫu {n}: {problem}',
  'settings.templates.importTitle': 'Nhập các mẫu?',
  'settings.templates.importConfirm': 'Nhập',
  'settings.templates.added': 'Mới',
  'settings.templates.replaced': 'Thay mẫu đang có',
  'settings.templates.listCount': '{title} ({count})',
  'settings.templates.noUndo': 'Nhập rồi thì không hoàn tác được.',
  'settings.templates.newTitle': 'Mẫu prompt mới',
  'settings.templates.text': 'Nội dung',
  'settings.templates.size': '{used} KB / {max} KB',
  'settings.templates.insertVariable': 'Chèn biến',
  'settings.templates.insert': 'Chèn {token}: {hint}',
  'settings.templates.filledIn': 'Được điền khi chèn mẫu vào Chat: {list}.',
  'settings.templates.varFile': 'file đang mở trong File',
  'settings.templates.varSelection': 'đoạn chữ chọn gần nhất',
  'settings.templates.varBranch': 'nhánh git',
  'settings.templates.varInput': 'gõ vào lúc chèn',
  'settings.templates.nameIt': 'Hãy đặt tên cho mẫu',
  'settings.templates.empty': 'Mẫu đang trống',
  'settings.templates.tooLarge': 'Mẫu lớn hơn {max} KB',
  'settings.templates.textHidden':
    'Mẫu chứa ký tự ẩn ({code} ở ký tự thứ {index})',
  'settings.templates.notJson': 'Đây không phải file JSON',
  'settings.templates.notTemplates': 'Đây không phải file mẫu',
  'settings.templates.otherVersion':
    'File này do một phiên bản Termote khác tạo',
  'settings.templates.fileEmpty': 'File không có mẫu nào',
  'settings.templates.fileTooMany': 'File có {count} mẫu: tối đa {max}',
  'settings.templates.noNameOrText': 'Mẫu {n} thiếu tên hoặc nội dung',
  'settings.templates.sameNameAt': 'Mẫu {n}: trùng tên với một mẫu khác',
  'settings.templates.nameTaken': 'Đã có mẫu mang tên này',
  'settings.templates.tooMany': 'Tối đa {max} mẫu',
  'settings.templates.duplicateName': 'Hai mẫu trong file trùng tên nhau',
  'settings.templates.newerFormat':
    'Một bản Termote mới hơn đã lưu chúng; hãy cập nhật để sửa mẫu',
  'settings.templates.unavailable': 'Server này không có mẫu prompt',
  'settings.templates.busy': 'Các mẫu đang được sửa ở nơi khác; hãy thử lại',
  'settings.templates.importChanged':
    'Các mẫu đã thay đổi từ lúc kiểm tra; hãy kiểm tra lại',
  'settings.templates.saveFailed': 'Không lưu được các mẫu',

  'settings.tasks.intro':
    'Lưu trên server này, mọi thiết bị dùng chung. Mỗi tác vụ chạy từ phần Tác vụ của một pane, trong một tab mở ở thư mục của pane đó.',
  'settings.tasks.newer':
    'Một bản Termote mới hơn đã lưu chúng; hãy cập nhật để sửa tác vụ.',
  'settings.tasks.readFailed': 'Không đọc được các tác vụ',
  'settings.tasks.none': 'Chưa có tác vụ nào.',
  'settings.tasks.new': 'Tác vụ mới',
  'settings.tasks.command': 'Lệnh',
  'settings.tasks.commandHint':
    'Chạy trong shell của một tab mở ở thư mục của pane (bash, zsh, sh, fish hoặc pwsh), như thể gõ ở đó.',
  'settings.tasks.nameIt': 'Hãy đặt tên cho tác vụ',
  'settings.tasks.enterCommand': 'Hãy nhập lệnh',
  'settings.tasks.oneLine': 'Lệnh phải nằm trên một dòng',
  'settings.tasks.commandTooLarge': 'Lệnh lớn hơn {max} byte',
  'settings.tasks.commandHidden': 'Lệnh chứa ký tự ẩn ({code})',
  'settings.tasks.nameTaken': 'Đã có tác vụ mang tên này',
  'settings.tasks.tooMany': 'Tối đa {max} tác vụ',
  'settings.tasks.newerFormat':
    'Một bản Termote mới hơn đã lưu chúng; hãy cập nhật để sửa tác vụ',
  'settings.tasks.unavailable': 'Server này không có tác vụ',
  'settings.tasks.busy': 'Các tác vụ đang được sửa ở nơi khác; hãy thử lại',
  'settings.tasks.saveFailed': 'Không lưu được các tác vụ',

  'settings.pair.viewHint':
    'Xem được terminal, Chat và File; không thay đổi được gì.',
  'settings.pair.fullHint':
    'Làm được mọi thứ thiết bị này làm được: gõ phím, file, agent, thiết bị.',
  'settings.pair.days_other': '{count} ngày',
  'settings.pair.never': 'Không bao giờ hết',
  'settings.pair.noLimit': 'đăng nhập không giới hạn thời gian',
  'settings.pair.forDays_other': 'đăng nhập được {count} ngày',
  'settings.pair.forHours_other': 'đăng nhập được {count} giờ',
  'settings.pair.tooManyCodes':
    'Đang có quá nhiều mã chờ dùng. Hãy dùng một mã, hoặc đợi 5 phút',
  'settings.pair.invalidName': 'Hãy dùng tên ngắn hơn, không có ký tự đặc biệt',
  'settings.pair.viewOnly': 'Thiết bị này chỉ được xem',
  'settings.pair.fullNeedsPassword':
    'Thiết bị toàn quyền phải được ghép từ một lần đăng nhập bằng mật khẩu hoặc từ CLI',
  'settings.pair.creatorGone': 'Thiết bị này không còn ghép được thiết bị khác',
  'settings.pair.invalidValidity':
    'Hãy chọn thiết bị mới được đăng nhập trong bao lâu',
  'settings.pair.failed': 'Không tạo được mã ghép. Hãy thử lại',
  'settings.pair.nameTooLong': 'Tên tối đa {max} ký tự',
  'settings.pair.expired': 'Mã này đã hết hạn. Hãy tạo mã mới.',
  'settings.pair.howTo':
    'Trên thiết bị mới, quét mã hoặc mở link. Trong app đã cài, dùng “Have a pairing code?” ở trang đăng nhập.',
  'settings.pair.code': 'Mã ghép',
  'settings.pair.qr': 'Mã QR của link ghép',
  'settings.pair.expires': 'Hết hạn sau {left} · dùng một lần',
  'settings.pair.validFor': 'Thiết bị mới {note}.',
  'settings.pair.copyLink': 'Sao chép link',
  'settings.pair.newCode': 'Mã mới',
  'settings.pair.role': 'Quyền',
  'settings.pair.viewOnlyOnly':
    'Chỉ xem. {hint} Thiết bị toàn quyền được ghép từ một lần đăng nhập bằng mật khẩu hoặc bằng <code>termote pair --role full</code>.',
  'settings.pair.trust':
    'Thiết bị toàn quyền làm được mọi thứ tài khoản người dùng của bạn làm được; thiết bị chỉ xem thấy mọi thứ hiện ra.',
  'settings.pair.validity': 'Được đăng nhập trong',
  'settings.pair.outlast': 'Không lâu hơn thời hạn của thiết bị này',
  'settings.pair.name': 'Tên (không bắt buộc; thiết bị mới tự đặt được)',
  'settings.pair.namePlaceholder': 'Điện thoại',
  'settings.pair.make': 'Tạo mã',

  'settings.about.title': 'Về {name}',
  'settings.about.description':
    'Terminal + Remote: điều khiển công cụ CLI từ bất cứ đâu',
  'settings.about.author': 'Tác giả',
  'settings.about.available': 'Đã có v{version}',
  'settings.about.docs': 'Tài liệu',
  'settings.about.changelog': 'Nhật ký thay đổi',
  'settings.about.issue': 'Báo lỗi',
  'settings.about.support': 'Ủng hộ dự án',
  'settings.about.sponsor': 'Tài trợ',
  'settings.about.coffee': 'Cà phê',
} satisfies Translation<typeof en>
