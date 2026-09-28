# Danh Sách Kiểm Tra Trước Phát Hành

Kiểm tra thủ công các tính năng Termote trước khi release.

## Yêu Cầu

- [ ] Đã cài tmux (macOS/Linux)
- [ ] Đã cài `psmux` (Windows)
- [ ] Đã cài herdr (chỉ cần khi test backend Herdr, chế độ native; container đã có sẵn herdr)
- [ ] Go 1.26+ (để build native)
- [ ] Node.js 22.22+ hoặc 24.15+ & pnpm (để build PWA)
- [ ] Docker hoặc Podman (cho container mode)
- [ ] Thiết bị di động thật (để test gesture)

---

## Cài Đặt

### Trình cài đặt

- [ ] `curl -fsSL https://termote.ohnice.app/install.sh | sh` hoàn thành không lỗi (Linux/macOS)
- [ ] `irm https://termote.ohnice.app/install.ps1 | iex` hoàn thành không lỗi (Windows)
- [ ] Chỉ cần curl/tar/sha256sum (hoặc PowerShell trên Windows); không hỏi sudo/quyền quản trị
- [ ] Kiểm tra `.sha256` của gói tải về; một bản tải hỏng bị từ chối, không được cài
- [ ] Chọn đúng tag ổn định 1.x mới nhất (không bao giờ chọn tag 0.x hay bản thử nghiệm)
- [ ] `TERMOTE_VERSION=X.Y.Z` (hoặc `-rc.N`) cố định/khôi phục đúng phiên bản đó
- [ ] Chạy lại trình cài đặt trên một bản đã cài in ra `termote update` và không đổi gì cả
- [ ] Trình cài đặt không bao giờ tự khởi động server; nó chỉ in ra `termote start`

### Chế Độ Native (macOS/Linux)

- [ ] `termote start` hoàn thành không lỗi
- [ ] Dịch vụ được đăng ký (systemd user unit trên Linux có systemd người dùng, tiến trình tách
      rời + file PID trên WSL2 không có systemd, launchd agent trên macOS)
- [ ] Tiến trình đang chạy: `pgrep -f "termote serve"`
- [ ] PWA truy cập được tại <http://localhost:7680>
- [ ] `termote stop` rồi đăng nhập lại (hoặc `loginctl enable-linger`/khởi động lại máy) làm nó chạy lại

### Chế Độ Native (Windows)

- [ ] `termote start` hoàn thành không lỗi
- [ ] Scheduled Task `Termote` được đăng ký, chạy ẩn qua `wscript` (không hỏi quyền quản trị)
- [ ] `psmux` + termote đang chạy
- [ ] PWA truy cập được tại <http://localhost:7690>

### Chế Độ Native + Herdr (Linux)

- [ ] `termote start --mux herdr` hoàn thành không lỗi (có herdr trong `PATH`)
- [ ] `curl localhost:7680/api/mux/health` trả về `"backend":"herdr"`
- [ ] `--mux herdr --no-auth` bị từ chối nếu không kèm `--allow-herdr-no-auth`
- [ ] PWA liệt kê đúng các workspace/tab/pane như `herdr pane list`
- [ ] Chọn tab/pane trên PWA không làm đổi tab đang focus trong giao diện Herdr trên máy host
- [ ] Huy hiệu trạng thái agent đổi trong vòng một `pollInterval` sau khi `herdr` báo trạng thái mới
- [ ] Gõ từ PWA vào pane của Herdr giữ đúng thứ tự (không bị xen lẫn)

### Chế Độ Native + Herdr (Windows)

- [ ] `termote start --mux herdr` hoàn thành không lỗi (có `herdr.exe` trong `PATH`)
- [ ] `curl localhost:7690/api/mux/health` trả về `"backend":"herdr"` (kết nối tới `\\.\pipe\` cộng đường dẫn `%APPDATA%\herdr\herdr.sock`)
- [ ] Khi có cả psmux và Herdr, lần `termote start` đầu tiên nhận ra Herdr và hỏi chọn (không có terminal để hỏi thì chọn psmux)
- [ ] Stream, gõ phím, dán, cuộn và huy hiệu trạng thái agent chạy như trên Linux
- [ ] Đổi kích thước pane trong Herdr (chia đôi hoặc phóng to pane) thì `observe` chạy lại theo kích thước mới
- [ ] `observe` khởi động từ Scheduled Task không mở cửa sổ dòng lệnh nào
- [ ] Sau `termote stop`, và sau `Stop-Process -Force` với server,
      `Get-CimInstance Win32_Process -Filter "Name='herdr.exe'"` không còn tiến trình `terminal session observe`

### Chế Độ Container

- [ ] `termote container up` hoàn thành không lỗi
- [ ] Container đang chạy: `docker ps | grep termote` (hoặc `podman ps`)
- [ ] PWA truy cập được tại <http://localhost:7680>
- [ ] Lần `container up` đầu tiên không có `--mux`: có terminal thì hỏi tmux/herdr, không có thì dùng tmux
- [ ] `container up --mux herdr`: PWA hiện workspace `main`; gõ phím, đổi kích thước, tạo/đổi tên/đóng tab đều chạy
- [ ] `container up` không kèm flag giữ backend đã lưu; `--mux tmux` chuyển lại tmux
- [ ] `container up --mux herdr --no-auth` bị từ chối nếu không kèm `--allow-herdr-no-auth`
- [ ] Khi Claude Code chạy trong một pane của container, huy hiệu trạng thái agent đổi theo
- [ ] Mật khẩu và danh sách Host được phép tới container qua giá trị `-e` lấy từ môi trường của
      chính CLI (`docker inspect termote` không cho thấy `--env-file`/tệp bí mật được mount)
- [ ] Podman ở chế độ không cần quyền `root` chạy với `--userns=keep-id`; Docker ở chế độ đó chạy không kèm `--user`
- [ ] `--workspace <dir>` mount đúng thư mục vào `/workspace` bằng `--mount`
- [ ] `container up --build` (từ một checkout) build `termote:local` thay vì kéo image có sẵn
- [ ] Khi một server native đã chiếm cổng, `container up` từ chối kèm gợi ý
- [ ] `container down` / `container logs [-f]` / `container status` hoạt động
- [ ] Đặt mật khẩu mới bằng `--fresh` ở một phía cũng cập nhật mật khẩu đã lưu ở phía kia
- [ ] `--no-auth` vẫn giữ nguyên mật khẩu chung đã lưu (không xóa nó)

### Tùy Chọn (`start` và `container up`)

- [ ] Cờ `--lan` mở truy cập LAN (test từ thiết bị khác); địa chỉ mà request thực sự gửi tới
      vẫn được chấp nhận kể cả khi IP LAN đổi
- [ ] `--no-auth` tắt xác thực
- [ ] `--port <port>` đổi port đúng
- [ ] `--tailscale <host[:port]>` cấu hình Tailscale HTTPS và thêm tên đó vào danh sách Host
      được phép, áp dụng mà không cần `sudo`
- [ ] Một cổng HTTPS đã phục vụ thứ khác (ví dụ chế độ còn lại) bị từ chối
- [ ] `--fresh` buộc tạo mật khẩu mới (bỏ qua config đã lưu)
- [ ] `--allow-host <name>` thêm tên vào danh sách Host được phép (có lưu lại); request có header
      `Host` không nằm trong danh sách nhận 403 kèm gợi ý đúng cờ đó
- [ ] `--remove-host <name>` xóa một tên đã cho phép trước đó
- [ ] Request từ hostname/IP LAN lạ bị từ chối (403) cho tới khi được thêm bằng
      `--allow-host`
- [ ] Không có cờ `--ttyd` và không có tham số PowerShell dạng `-Flag` nào trong bản 1.0

### Lưu Trữ Cấu Hình

- [ ] Mật khẩu: AES-256-CBC kèm HMAC, khóa lấy từ tệp `secret` ngẫu nhiên theo từng bản cài, quyền 0600 (Unix)
- [ ] Mật khẩu mã hóa DPAPI (Windows)
- [ ] File config có quyền 600 (`chmod 600`, Unix)
- [ ] Cấu hình đã lưu được tái sử dụng khi khởi động lại (port, LAN, auth, mux, danh sách Host được phép, Tailscale, workspace)
- [ ] `show-password` in ra mật khẩu đã lưu

### Gỡ Cài Đặt

- [ ] `termote uninstall` dừng dịch vụ, gỡ đăng ký, lệnh `termote` và thư mục cài đặt, nhưng
      giữ nguyên cấu hình và log đã lưu (in ra cả hai đường dẫn)

### Link/Unlink

- [ ] `termote link` tạo lệnh trong `~/.local/bin` (đã được trình cài đặt thêm vào PATH)
- [ ] `termote help` hoạt động sau khi link
- [ ] `termote unlink` xóa lệnh đó

### Cập Nhật

- [ ] `termote update` cập nhật lên bản ổn định 1.x mới nhất
- [ ] `termote update --version X.Y.Z` cố định phiên bản
- [ ] `termote update --force` cài lại phiên bản hiện tại
- [ ] Cập nhật giữ nguyên cấu hình đã lưu (port, LAN, auth, mux, danh sách Host được phép, Tailscale)
- [ ] Kiểm tra sức khỏe trên phiên bản mới thành công thì giữ nguyên; thất bại thì chuyển
      `current` về phiên bản trước đó và khởi động lại nó
- [ ] Từ chối chạy từ git checkout, và với một tệp thực thi không do trình cài đặt tạo ra
- [ ] Cảnh báo khi hạ phiên bản, bỏ qua nếu đã đúng phiên bản đích
- [ ] Chỉ giữ lại phiên bản hiện tại và phiên bản trước đó trong `versions/`
- [ ] Gõ `termote update` ngay trong một pane của Termote vẫn hoàn tất được (không tự kết thúc pane của chính nó)

### Lệnh CLI Khác

- [ ] `termote status` (bí danh `health`) báo đúng những gì server đang chạy trả về
- [ ] `termote logs` xem log dịch vụ
- [ ] `termote version` hiển thị phiên bản đã cài

---

## Tính Năng PWA

### Cơ Bản

- [ ] PWA tải lên không có lỗi trong bảng điều khiển của DevTools
- [ ] Terminal kết nối qua WebSocket `/api/mux/stream`
- [ ] Terminal hiển thị đúng
- [ ] Gõ phím thì ký tự được gửi vào terminal
- [ ] Output hiển thị trong terminal
- [ ] Màu terminal phù hợp giao diện tối
- [ ] Màu terminal phù hợp giao diện sáng
- [ ] Chuyển theme không làm terminal kết nối lại
- [ ] Theme terminal đúng sau khi tải lại trang (F5)
- [ ] Đổi kích thước cửa sổ/khung thì PTY đổi theo (`stty size` trong terminal khớp)
- [ ] Kết thúc tiến trình dòng lệnh đang chạy trong terminal thì hiện khung báo đã thoát và cách kết nối lại
- [ ] Kết nối lại sau khi rớt mạng thì quay về đúng pane cũ, không mất phần lịch sử cuộn mà
      backend còn giữ trong bộ đệm
- [ ] Máy tính: Danh sách icon hiển thị đúng (không vỡ bố cục)
- [ ] Trang About hiển thị đẹp ở giao diện tối
- [ ] Nút Settings nhấn được trên mobile
- [ ] Nút Clear Cache & Reload hoạt động (hủy SW, xóa cache, xóa session cookie, tải lại trang)

### Chỉ Báo Kết Nối

- [ ] Hiện trạng thái "đang kết nối" (chấm vàng nhấp nháy) khi vừa tải trang
- [ ] Hiện trạng thái "đã kết nối" (chấm xanh, icon Wifi) khi hoạt động
- [ ] Hiện trạng thái "mất kết nối" (chấm đỏ, icon WifiOff) khi server không phản hồi
- [ ] Nhấn được khi mất kết nối — kích hoạt kết nối lại

### Thông Báo Toast

- [ ] Toast hiện khi lỗi bảng nhớ tạm, lỗi dán, có bản cập nhật
- [ ] Tự tắt sau ~4 giây
- [ ] Vị trí dưới giữa, phía trên toolbar

### Tùy Chỉnh (Settings Modal)

- [ ] Modal Preferences mở từ menu Settings
- [ ] Chuyển đổi hành vi gửi IME hoạt động (Gửi text / Gửi + Enter)
- [ ] Chuyển đổi nguồn dán hoạt động (bảng nhớ tạm hệ thống / tmux buffer)
- [ ] Chuyển đổi toolbar mở rộng mặc định hoạt động
- [ ] Chuyển đổi tắt context menu hoạt động
- [ ] Chuyển đổi hiện session tabs hoạt động (máy tính)
- [ ] Chọn chu kỳ làm mới hoạt động (3 giây đến 5 phút)
- [ ] Nút kiểm tra cập nhật hoạt động
- [ ] Xem hướng dẫn cử chỉ có sẵn (mobile)
- [ ] Nút xóa lịch sử hoạt động
- [ ] Tùy chỉnh giữ nguyên sau khi tải lại trang

### Giao Diện

- [ ] Giao diện sáng (bảng màu GitHub)
- [ ] Giao diện tối (bảng màu Monokai)
- [ ] Chế độ Hệ thống (theo OS)
- [ ] Nút chuyển theme trong menu settings
- [ ] Theme giữ nguyên sau khi tải lại

### Cài Đặt/Offline

- [ ] PWA cài được ra màn hình chính (điện thoại/máy tính)
- [ ] Service worker đã đăng ký
- [ ] Chế độ offline hiển thị khung ứng dụng đã cache

### Hướng Dẫn & Tài Liệu

- [ ] Modal Help mở với 3 tab: Cử chỉ, Toolbar, tmux
- [ ] Tab Cử chỉ hiện các thao tác vuốt/chụm/nhấn giữ
- [ ] Tab Toolbar hiện tất cả phím và tổ hợp
- [ ] Tab tmux hiện lệnh window/pane/copy-mode

### Giới Thiệu

- [ ] Hiện phiên bản, tác giả, giấy phép
- [ ] Link GitHub, changelog, trang issue hoạt động
- [ ] Link tài trợ (MoMo, GitHub Sponsors, Buy Me a Coffee)

---

## Quản Lý Session (3 cấp: group → tab → pane)

### Sidebar Session (group)

- [ ] Sidebar mở (vuốt từ cạnh trái hoặc nhấn icon menu ba gạch)
- [ ] Sidebar scroll được khi có nhiều group
- [ ] Sidebar thu gọn/mở rộng hoạt động (máy tính)
- [ ] Sidebar thu gọn chỉ hiện icon, rê chuột thấy chú thích (máy tính)
- [ ] Tạo session (tab) mới hoạt động
- [ ] Sửa tên session hoạt động
- [ ] Sửa icon session qua bộ chọn icon (biểu tượng cảm xúc)
- [ ] Sửa mô tả session hoạt động
- [ ] Xóa session hoạt động
- [ ] Nhấn session chuyển terminal
- [ ] Session đang chọn được tô sáng trong sidebar
- [ ] Session giữ nguyên sau khi tải lại trang
- [ ] Nhấp đúp để sửa session (máy tính)

### Session Tabs (Desktop)

- [ ] Thanh tab hiện khi cài đặt bật
- [ ] Tab scroll vào view khi chuyển
- [ ] Nhấn tab chuyển session
- [ ] Tab đang chọn được tô sáng

### Dải Pane (tab nhiều pane, chỉ Herdr)

- [ ] Dải pane bị ẩn với tab chỉ có một pane
- [ ] Dải pane hiện với tab có nhiều hơn một pane, mỗi pane có một huy hiệu trạng thái agent
- [ ] Chọn một pane thì đổi luồng terminal mà không đổi focus trong giao diện Herdr trên máy host

### Thanh Điều Hướng Dưới (Mobile)

- [ ] Thanh điều hướng dưới chỉ hiện trên mobile
- [ ] Hiện nút toggle sidebar, nút thêm, và 5 icon session đầu tiên
- [ ] Nhấn icon session chuyển session

### Fullscreen (Desktop)

- [ ] Nút fullscreen hiện trên header (chỉ trên máy tính)
- [ ] Nhấn bật/tắt chế độ toàn màn hình
- [ ] Icon đổi giữa Maximize/Minimize
- [ ] Esc/F11 thoát fullscreen và đồng bộ trạng thái nút

### Thao Tác Session (Mobile)

- [ ] Nút Sửa/Xóa ẩn mặc định
- [ ] Vuốt trái/phải trên session item hiện nút Sửa/Xóa

### Session Qua API

- [ ] Liệt kê session qua API: `curl localhost:7680/api/mux/snapshot`
- [ ] Chuyển session qua API hoạt động
- [ ] Trạng thái session giữ nguyên sau khi terminal kết nối lại

---

## Cử Chỉ Mobile

Test trên thiết bị di động thật:

| Cử Chỉ     | Hành Động      | Trạng Thái |
| ---------- | -------------- | ---------- |
| Vuốt trái  | Ctrl+C         | [ ]        |
| Vuốt phải  | Tab            | [ ]        |
| Vuốt lên   | Scroll xuống   | [ ]        |
| Vuốt xuống | Scroll lên     | [ ]        |
| Nhấn giữ   | Dán            | [ ]        |
| Chụm vào   | Giảm font      | [ ]        |
| Chụm ra    | Tăng font      | [ ]        |
| Nhấn       | Focus terminal | [ ]        |

### Scroll & Copy Mode

- [ ] Scroll lên/xuống = Page Up/Down khi bật copy mode
- [ ] Terminal thu lại vừa khoảng phía trên thanh công cụ khi bàn phím mobile mở (các dòng cuối vẫn hiện)
- [ ] Terminal vừa khoảng phía trên thanh công cụ trong chế độ gõ tiếng Việt (IME)
- [ ] Scroll vẫn hoạt động (không bị cử chỉ vuốt chặn mất)

### Hướng Dẫn Cử Chỉ

- [ ] Người dùng mobile lần đầu thấy overlay hướng dẫn cử chỉ
- [ ] Overlay tắt được
- [ ] Không hiện lại sau khi tắt (lưu qua settings)
- [ ] Có thể xem lại từ Settings (`Show Gesture Hints`)

### Trường Hợp Đặc Biệt

- [ ] Cử chỉ hoạt động trong chế độ gõ IME
- [ ] Không kích hoạt nhầm khi gõ bình thường

---

## Bàn Phím Ảo

### Chế Độ Thu Gọn (Mặc Định)

- [ ] Thanh công cụ hiển thị trên bàn phím hệ thống
- [ ] Nút bật/tắt bàn phím hoạt động
- [ ] Nút bật/tắt IME hoạt động
- [ ] Nút Lịch sử mở dropdown lịch sử lệnh
- [ ] Phím Tab gửi Tab
- [ ] Phím Esc gửi Escape
- [ ] Phím Enter gửi Enter
- [ ] Phím bổ trợ Ctrl bật/tắt (chỉ báo màu xanh khi đang bật)
- [ ] Phím bổ trợ Shift bật/tắt (chỉ báo màu cam khi đang bật)
- [ ] Phím mũi tên (←↑↓→) hoạt động
- [ ] Nút mở rộng hiển thị
- [ ] Các nút dùng icon (kích thước đọc được, không dùng ký hiệu chữ)
- [ ] Nhấn giữ nút KHÔNG hiện context menu

### Chế Độ Mở Rộng

- [ ] Nút mở rộng chuyển sang view đầy đủ
- [ ] Phím Home hoạt động
- [ ] Phím End hoạt động
- [ ] Phím Delete hoạt động
- [ ] Phím Backspace hoạt động
- [ ] Phím Page Up/Down hoạt động
- [ ] Phím Insert hoạt động
- [ ] Nút thu gọn quay về chế độ tối giản

### Tổ Hợp Ctrl (Thu Gọn)

- [ ] Ctrl+C (ngắt) hoạt động
- [ ] Ctrl+D (EOF) hoạt động
- [ ] Ctrl+Z (tạm dừng) hoạt động
- [ ] Ctrl+L (xóa màn hình) hoạt động
- [ ] Ctrl+A (đầu dòng) hoạt động
- [ ] Ctrl+E (cuối dòng) hoạt động

### Tổ Hợp Ctrl (Mở Rộng)

- [ ] Ctrl+B (lùi 1 ký tự) hoạt động
- [ ] Ctrl+X (cắt) hoạt động
- [ ] Ctrl+K (xóa đến cuối) hoạt động
- [ ] Ctrl+U (xóa đến đầu) hoạt động
- [ ] Ctrl+W (xóa từ) hoạt động
- [ ] Ctrl+R (tìm ngược) hoạt động
- [ ] Ctrl+P (lệnh trước) hoạt động
- [ ] Ctrl+N (lệnh sau) hoạt động

### Tổ Hợp Ctrl+Shift

- [ ] Ctrl+Shift+C (sao chép) hoạt động
- [ ] Ctrl+Shift+V (dán) hoạt động
- [ ] Ctrl+Shift+Z (làm lại) hoạt động
- [ ] Ctrl+Shift+X (cắt) hoạt động

### Phím Tiện Ích

- [ ] Nút bật/tắt tmux copy mode hoạt động
- [ ] Nút Dán hoạt động (từ nguồn đã cấu hình)
- [ ] Nút Scroll lên/xuống hoạt động

### Cỡ Chữ

- [ ] Cỡ chữ điều chỉnh được (phạm vi 6–24px)
- [ ] Cỡ chữ mặc định 14px
- [ ] Cỡ chữ giữ nguyên sau khi tải lại

### Hỗ Trợ IME

- [ ] Hỗ trợ gõ tiếng Việt (IME) trên mobile
- [ ] Hành vi gửi IME tuân theo cài đặt (gửi text / gửi + enter)

---

## Menu Thao Tác Nhanh (Mobile)

- [ ] Nút FAB hiện trên mobile
- [ ] Nhấn FAB mở menu thao tác
- [ ] Thao tác Clear (gửi 'clear' + Enter)
- [ ] Thao tác Cancel (gửi Ctrl+C)
- [ ] Thao tác `Clear line` (gửi Ctrl+U)
- [ ] Thao tác Exit (gửi Ctrl+D)
- [ ] FAB kéo thả được (kéo để đổi vị trí)
- [ ] Vị trí FAB giữ nguyên sau khi tải lại
- [ ] FAB giới hạn trong viewport
- [ ] Phản hồi rung khi thao tác

---

## Lịch Sử Lệnh

- [ ] Dropdown lịch sử mở từ nút toolbar
- [ ] Tìm kiếm được (không phân biệt hoa thường)
- [ ] Điều hướng bàn phím (mũi tên lên/xuống, Enter chọn, Esc đóng)
- [ ] Mục đang chọn được tô sáng và tự cuộn vào tầm nhìn
- [ ] Xóa từng lệnh (icon thùng rác)
- [ ] Nút xóa tất cả
- [ ] Tối đa 100 lệnh
- [ ] Lịch sử giữ nguyên sau khi tải lại

---

## Xác Thực & Chặn Request

### Basic Auth

- [ ] Trình duyệt yêu cầu đăng nhập khi truy cập lần đầu
- [ ] Thông tin đúng cho phép truy cập
- [ ] Thông tin sai bị từ chối (401)
- [ ] Auth giữ nguyên sau khi tải lại trang (session cookie)
- [ ] Session cookie ngăn hỏi auth lại trên mobile
- [ ] Clear Cache & Reload xóa session cookie (yêu cầu đăng nhập lại)
- [ ] Mật khẩu đã lưu rỗng không còn tắt auth — chạy `start` trên cấu hình như vậy sẽ sinh và
      lưu mật khẩu mới

### Danh Sách Host Được Phép

- [ ] Request có header `Host` lạ nhận 403 (không phụ thuộc Sec-Fetch)
- [ ] Loopback (`localhost`, `127.0.0.1`, `::1`) luôn được phép
- [ ] Địa chỉ mà request thực sự gửi tới tự động được phép khi khởi động với `--lan`
- [ ] Tên Tailscale tự động được phép khi khởi động với `--tailscale`
- [ ] Tên thêm bằng `--allow-host` được phép và vẫn giữ sau khi khởi động lại
- [ ] Không có giá trị `*`/wildcard nào tắt được lớp kiểm tra này

### Chặn Ghi / CSRF

- [ ] POST cross-site (`Sec-Fetch-Site: cross-site`) tới `/api/mux/*` bị từ chối
- [ ] POST `text/plain` tới `/api/mux/panes/{id}/keys` bị từ chối (415)
- [ ] `/api/mux/stream` từ chối Origin cross-site
- [ ] `/api/mux/stream` từ chối stream token bị thiếu, hết hạn hoặc đã dùng

### Chống Brute-Force

- [ ] Bộ giới hạn tần suất chặn sau 5 lần thất bại/phút mỗi IP (429)
- [ ] So sánh mật khẩu trong thời gian không đổi

### Bảo Mật Server

- [ ] ReadHeaderTimeout đã set (chống Slowloris)
- [ ] Giới hạn kích thước thân request (8KB cho các request ghi tới `/api/mux/*`)
- [ ] Lỗi nội bộ chỉ ghi log phía server, client chỉ nhận thông báo chung

### Chế Độ Không Auth

- [ ] Cờ `--no-auth` bỏ qua yêu cầu đăng nhập
- [ ] Truy cập trực tiếp không cần thông tin
- [ ] `--mux herdr --no-auth` bị từ chối nếu không kèm `--allow-herdr-no-auth`

---

## API Endpoints

```bash
# Kiểm tra health
curl http://localhost:7680/api/mux/health

# Snapshot (group → tab → pane)
curl http://localhost:7680/api/mux/snapshot

# Tạo tab
curl -X POST http://localhost:7680/api/mux/tabs \
  -H 'Content-Type: application/json' \
  -d '{"groupId":"main","name":"test"}'

# Chọn tab
# Mọi request ghi đều cần Content-Type JSON, kể cả khi không có body (nếu không sẽ nhận 415)
curl -X POST http://localhost:7680/api/mux/tabs/<id>/select \
  -H 'Content-Type: application/json'

# Đổi tên tab
curl -X PATCH http://localhost:7680/api/mux/tabs/<id> \
  -H 'Content-Type: application/json' \
  -d '{"name":"newname"}'

# Đóng tab
curl -X DELETE http://localhost:7680/api/mux/tabs/<id> \
  -H 'Content-Type: application/json'

# Gửi phím tới một pane
curl -X POST http://localhost:7680/api/mux/panes/<id>/keys \
  -H 'Content-Type: application/json' \
  -d '{"keys":"ls\n"}'

# Lấy token cho luồng terminal
curl http://localhost:7680/api/mux/stream-token
```

- [ ] Endpoint health trả về 200 kèm `apiVersion` và `backend`
- [ ] Endpoint snapshot liệt kê group/tab/pane
- [ ] Tạo tab hoạt động
- [ ] Chọn tab hoạt động (tmux; Herdr trả về 501 vì PWA tự chọn ở phía client)
- [ ] Đổi tên tab hoạt động
- [ ] Đóng tab hoạt động
- [ ] Gửi phím hoạt động
- [ ] Endpoint stream token trả token hợp lệ dùng 1 lần (TTL 30 giây)
- [ ] Request không hợp lệ trả về lỗi đúng (400/404/405/415)
- [ ] `/api/tmux/*` và `/terminal/` trả về 404/410, không bao giờ trả phản hồi hoạt động được

---

## Đa Nền Tảng

### Linux

- [ ] Chế độ container hoạt động
- [ ] Chế độ native hoạt động (backend tmux và Herdr)
- [ ] CLI nhận diện đúng kiến trúc (x86_64/aarch64)

### macOS

- [ ] Chế độ container hoạt động (Docker Desktop hoặc Podman)
- [ ] Chế độ native hoạt động
- [ ] Cross-compile cho Linux container hoạt động
- [ ] Nhận diện IP LAN hoạt động

### Windows

- [ ] Chế độ container hoạt động (Docker Desktop)
- [ ] Chế độ native hoạt động (`psmux` + termote)
- [ ] Mã hóa DPAPI cho mật khẩu hoạt động
- [ ] Link/Unlink tạo lệnh `termote` dùng được ở mọi nơi
- [ ] Các cờ của `termote` dùng chung cú pháp Go như trên Unix (`--lan`, `--no-auth`,
      `--port`, `--tailscale`, `--fresh`, `--mux`, `--allow-host`, `--allow-herdr-no-auth`)

---

## Build & CI/CD

```bash
make build
make test
```

- [ ] PWA build không lỗi: `pnpm --filter termote build`
- [ ] TypeScript biên dịch không lỗi: `pnpm --filter termote exec tsc --noEmit`
- [ ] Lint pass: `pnpm --filter termote lint:ci`
- [ ] Go build không lỗi: `cd server && go build .`
- [ ] Go tests pass trên Linux, macOS và Windows: `cd server && go test ./...`
- [ ] Tất cả test viết bằng Bash đều qua: `make test`
- [ ] CI pipeline của website chạy khi đẩy code lên
- [ ] Website deploy thành công

---

## Unit Tests

```bash
pnpm --filter termote test
```

- [ ] Tất cả Vitest unit tests pass (hooks, utils, contexts)

## E2E Tests

```bash
pnpm --filter termote test:e2e
```

- [ ] Tất cả Playwright tests pass
- [ ] Test chạy được ở chế độ không giao diện
- [ ] Test chạy được với cờ `--ui`

---

## Ghi Chú

_Thêm các vấn đề hoặc quan sát trong quá trình test:_

-

---

**Người test:** **\*\***\_\_\_**\*\***

**Ngày:** **\*\***\_\_\_**\*\***

**Phiên bản:** **\*\***\_\_\_**\*\***
