# Danh Sách Kiểm Tra Trước Phát Hành

Kiểm tra thủ công các tính năng Termote trước khi release.

## Yêu Cầu

- [ ] Đã cài tmux (macOS/Linux)
- [ ] Đã cài psmux (Windows)
- [ ] Đã cài ttyd
- [ ] Go 1.21+ (để build native)
- [ ] Node.js 18+ & pnpm (để build PWA)
- [ ] Docker hoặc Podman (cho container mode)
- [ ] Thiết bị di động thật (để test gesture)

---

## Cài Đặt

### Chế Độ Container

- [ ] `./scripts/termote.sh install container` hoàn thành không lỗi
- [ ] Container đang chạy: `docker ps | grep termote`
- [ ] PWA truy cập được tại <http://localhost:7680>
- [ ] Thông tin đăng nhập tự sinh hiển thị trong logs

### Chế Độ Native (macOS/Linux)

- [ ] `./scripts/termote.sh install native` hoàn thành không lỗi
- [ ] Các process đang chạy: `ps aux | grep -E 'ttyd|tmux-api'`
- [ ] PWA truy cập được tại <http://localhost:7680>

### Chế Độ Native (Windows)

- [ ] `.\scripts\termote.ps1 install native` hoàn thành không lỗi
- [ ] psmux + ttyd + tmux-api đang chạy
- [ ] PWA truy cập được tại <http://localhost:7690>

### Tùy Chọn

- [ ] Flag `--lan` mở truy cập LAN (test từ thiết bị khác)
- [ ] `--no-auth` tắt xác thực
- [ ] `/terminal/` bị chặn khi truy cập trực tiếp URL trên trình duyệt (403)
- [ ] `/terminal/` truy cập được từ trình duyệt mobile qua LAN/Tailscale (không có header Sec-Fetch-Dest)
- [ ] `/terminal/` load được trong iframe PWA với token hợp lệ
- [ ] `--port <port>` đổi port đúng
- [ ] `--tailscale <host>` cấu hình Tailscale HTTPS
- [ ] `--fresh` buộc tạo mật khẩu mới (bỏ qua config đã lưu)
- [ ] Biến môi trường `TERMOTE_USER`/`TERMOTE_PASS` hoạt động
- [ ] Biến `WORKSPACE` mount đúng thư mục

### Lưu Trữ Cấu Hình

- [ ] Mật khẩu mã hóa AES-256-CBC + PBKDF2 (macOS/Linux)
- [ ] Mật khẩu mã hóa DPAPI (Windows)
- [ ] File config chmod 600
- [ ] Config đã lưu được tái sử dụng khi cài lại (mode, LAN, auth, port, Tailscale)

### Gỡ Cài Đặt

- [ ] `./scripts/termote.sh uninstall all` dọn sạch tất cả (dừng dịch vụ, xóa config)

### Link/Unlink

- [ ] `./scripts/termote.sh link` tạo symlink (thử /usr/local/bin, fallback ~/.local/bin)
- [ ] `termote help` hoạt động sau khi link
- [ ] `./scripts/termote.sh unlink` xóa symlink và hiện hướng dẫn khôi phục

### Cập Nhật

- [ ] `./scripts/termote.sh update` cập nhật lên bản mới nhất
- [ ] `./scripts/termote.sh update --version X.Y.Z` cố định phiên bản
- [ ] `./scripts/termote.sh update --force` cài lại phiên bản hiện tại
- [ ] Cập nhật giữ nguyên cấu hình đã lưu
- [ ] Cập nhật tái tạo symlink nếu đã có
- [ ] Từ chối chạy từ git repo (chặn dev mode)
- [ ] Cảnh báo khi hạ phiên bản, bỏ qua nếu đã đúng version

### Lệnh CLI Khác

- [ ] `./scripts/termote.sh health` kiểm tra trạng thái dịch vụ
- [ ] `./scripts/termote.sh logs` xem log dịch vụ
- [ ] `./scripts/termote.sh version` hiển thị phiên bản

---

## Tính Năng PWA

### Cơ Bản

- [ ] PWA load không có lỗi console
- [ ] Terminal iframe kết nối WebSocket thành công
- [ ] Terminal hiển thị đúng
- [ ] Gõ phím gửi input vào terminal
- [ ] Output hiển thị trong terminal
- [ ] Màu terminal phù hợp dark mode
- [ ] Màu terminal phù hợp light mode
- [ ] Chuyển theme không reload terminal (không ngắt/kết nối lại)
- [ ] Theme terminal đúng sau khi reload trang (F5)
- [ ] Desktop: Danh sách icon hiển thị đúng (không lỗi layout)
- [ ] Trang About đẹp trong dark mode
- [ ] Nút Settings nhấn được trên mobile
- [ ] Nút Clear Cache & Reload hoạt động (hủy SW, xóa cache, xóa session cookie, reload trang)

### Chỉ Báo Kết Nối

- [ ] Hiện trạng thái "đang kết nối" (chấm vàng nhấp nháy) khi vừa load
- [ ] Hiện trạng thái "đã kết nối" (chấm xanh, icon Wifi) khi hoạt động
- [ ] Hiện trạng thái "mất kết nối" (chấm đỏ, icon WifiOff) khi server không phản hồi
- [ ] Nhấn được khi mất kết nối — kích hoạt reconnect iframe

### Thông Báo Toast

- [ ] Toast hiện khi lỗi clipboard, lỗi dán, có bản cập nhật
- [ ] Tự tắt sau ~4 giây
- [ ] Vị trí dưới giữa, phía trên toolbar

### Tùy Chỉnh (Settings Modal)

- [ ] Modal Preferences mở từ menu Settings
- [ ] Chuyển đổi hành vi gửi IME hoạt động (Gửi text / Gửi + Enter)
- [ ] Chuyển đổi nguồn dán hoạt động (Clipboard hệ thống / tmux buffer)
- [ ] Chuyển đổi toolbar mở rộng mặc định hoạt động
- [ ] Chuyển đổi tắt context menu hoạt động
- [ ] Chuyển đổi hiện session tabs hoạt động (desktop)
- [ ] Chọn khoảng thời gian polling hoạt động (3 giây đến 5 phút)
- [ ] Nút kiểm tra cập nhật hoạt động
- [ ] Xem hướng dẫn cử chỉ có sẵn (mobile)
- [ ] Nút xóa lịch sử hoạt động
- [ ] Tùy chỉnh giữ nguyên sau khi reload trang

### Giao Diện

- [ ] Giao diện sáng (bảng màu GitHub)
- [ ] Giao diện tối (bảng màu Monokai)
- [ ] Chế độ Hệ thống (theo OS)
- [ ] Nút chuyển theme trong menu settings
- [ ] Theme giữ nguyên sau reload

### Cài Đặt/Offline

- [ ] PWA cài được vào homescreen (mobile/desktop)
- [ ] Service worker đã đăng ký
- [ ] Chế độ offline hiển thị shell đã cache

### Hướng Dẫn & Tài Liệu

- [ ] Modal Help mở với 3 tab: Cử chỉ, Toolbar, tmux
- [ ] Tab Cử chỉ hiện các thao tác vuốt/chụm/nhấn giữ
- [ ] Tab Toolbar hiện tất cả phím và tổ hợp
- [ ] Tab tmux hiện lệnh window/pane/copy-mode

### Giới Thiệu

- [ ] Hiện phiên bản, tác giả, giấy phép
- [ ] Link GitHub, changelog, issues hoạt động
- [ ] Link tài trợ (MoMo, GitHub Sponsors, Buy Me a Coffee)

---

## Quản Lý Session

### Sidebar Session

- [ ] Sidebar mở (vuốt từ cạnh trái hoặc nhấn icon hamburger)
- [ ] Sidebar scroll được khi có nhiều session
- [ ] Sidebar thu gọn/mở rộng hoạt động (desktop)
- [ ] Sidebar thu gọn chỉ hiện icon với tooltip (desktop)
- [ ] Tạo session mới hoạt động
- [ ] Sửa tên session hoạt động
- [ ] Sửa icon session qua icon picker (emoji)
- [ ] Sửa mô tả session hoạt động
- [ ] Xóa session hoạt động
- [ ] Nhấn session chuyển terminal
- [ ] Session đang active được highlight trong sidebar
- [ ] Sessions giữ nguyên sau khi refresh trang
- [ ] Double-click để sửa session (desktop)

### Session Tabs (Desktop)

- [ ] Thanh tab hiện khi cài đặt bật
- [ ] Tab scroll vào view khi chuyển
- [ ] Nhấn tab chuyển session
- [ ] Tab đang active được highlight

### Thanh Điều Hướng Dưới (Mobile)

- [ ] Thanh nav dưới chỉ hiện trên mobile
- [ ] Hiện nút toggle sidebar, nút thêm, và 5 icon session đầu tiên
- [ ] Nhấn icon session chuyển session

### Fullscreen (Desktop)

- [ ] Nút fullscreen hiện trên header (chỉ desktop)
- [ ] Nhấn bật/tắt chế độ toàn màn hình
- [ ] Icon đổi giữa Maximize/Minimize
- [ ] Esc/F11 thoát fullscreen và đồng bộ trạng thái nút

### Thao Tác Session (Mobile)

- [ ] Nút Sửa/Xóa ẩn mặc định
- [ ] Vuốt trái/phải trên session item hiện nút Sửa/Xóa

### tmux Sessions

- [ ] Sessions tạo qua API: `curl localhost:7680/api/tmux/windows`
- [ ] Chuyển session qua API hoạt động
- [ ] Trạng thái session giữ nguyên sau khi terminal reconnect

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
- [ ] Terminal scroll được khi bàn phím mobile mở
- [ ] Terminal scroll được trong chế độ gõ tiếng Việt (IME)
- [ ] Scroll vẫn hoạt động (không bị chặn bởi swipe)

### Hướng Dẫn Cử Chỉ

- [ ] Người dùng mobile lần đầu thấy overlay hướng dẫn cử chỉ
- [ ] Overlay tắt được
- [ ] Không hiện lại sau khi tắt (lưu qua settings)
- [ ] Có thể xem lại từ Settings (Gesture hints viewer)

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
- [ ] Modifier Ctrl bật/tắt (chỉ báo màu xanh khi active)
- [ ] Modifier Shift bật/tắt (chỉ báo màu cam khi active)
- [ ] Phím mũi tên (←↑↓→) hoạt động
- [ ] Nút mở rộng hiển thị
- [ ] Các nút dùng icon (kích thước đọc được, không dùng symbol)
- [ ] Nhấn giữ nút KHÔNG hiện context menu

### Chế Độ Mở Rộng

- [ ] Nút mở rộng chuyển sang view đầy đủ
- [ ] Phím Home hoạt động
- [ ] Phím End hoạt động
- [ ] Phím Delete hoạt động
- [ ] Phím Backspace hoạt động
- [ ] Phím Page Up/Down hoạt động
- [ ] Phím Insert hoạt động
- [ ] Nút thu gọn quay về chế độ minimal

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
- [ ] Ctrl+Shift+Z (redo) hoạt động
- [ ] Ctrl+Shift+X (cắt) hoạt động

### Phím Tiện Ích

- [ ] Nút bật/tắt tmux copy mode hoạt động
- [ ] Nút Dán hoạt động (từ nguồn đã cấu hình)
- [ ] Nút Scroll lên/xuống hoạt động

### Cỡ Chữ

- [ ] Cỡ chữ điều chỉnh được (phạm vi 6–24px)
- [ ] Cỡ chữ mặc định 14px
- [ ] Cỡ chữ giữ nguyên sau reload

### Hỗ Trợ IME

- [ ] Hỗ trợ gõ tiếng Việt (IME) trên mobile
- [ ] Hành vi gửi IME tuân theo cài đặt (gửi text / gửi + enter)

---

## Menu Thao Tác Nhanh (Mobile)

- [ ] Nút FAB hiện trên mobile
- [ ] Nhấn FAB mở menu thao tác
- [ ] Thao tác Clear (gửi 'clear' + Enter)
- [ ] Thao tác Cancel (gửi Ctrl+C)
- [ ] Thao tác Clear line (gửi Ctrl+U)
- [ ] Thao tác Exit (gửi Ctrl+D)
- [ ] FAB kéo thả được (kéo để đổi vị trí)
- [ ] Vị trí FAB giữ nguyên sau reload
- [ ] FAB giới hạn trong viewport
- [ ] Phản hồi rung khi thao tác

---

## Lịch Sử Lệnh

- [ ] Dropdown lịch sử mở từ nút toolbar
- [ ] Tìm kiếm được (không phân biệt hoa thường)
- [ ] Điều hướng bàn phím (mũi tên lên/xuống, Enter chọn, Esc đóng)
- [ ] Highlight mục đang chọn với auto-scroll
- [ ] Xóa từng lệnh (icon thùng rác)
- [ ] Nút xóa tất cả
- [ ] Tối đa 100 lệnh
- [ ] Lịch sử giữ nguyên sau reload

---

## Xác Thực

### Basic Auth

- [ ] Trình duyệt yêu cầu đăng nhập khi truy cập lần đầu
- [ ] Thông tin đúng cho phép truy cập
- [ ] Thông tin sai bị từ chối (401)
- [ ] Auth giữ nguyên sau khi refresh (session cookie)
- [ ] Session cookie ngăn hỏi auth lại trên mobile iframe
- [ ] Clear Cache & Reload xóa session cookie (yêu cầu đăng nhập lại)

### Chống Brute-Force

- [ ] Rate limiter chặn sau 5 lần thất bại/phút mỗi IP (429)
- [ ] So sánh mật khẩu constant-time

### Bảo Mật Server

- [ ] ReadHeaderTimeout đã set (chống Slowloris)
- [ ] Giới hạn body request (8KB cho send-keys)
- [ ] Lỗi nội bộ chỉ log server-side, trả message chung cho client

### Chế Độ Không Auth

- [ ] Flag `--no-auth` bỏ qua yêu cầu đăng nhập
- [ ] Truy cập trực tiếp không cần thông tin

---

## API Endpoints

```bash
# Kiểm tra health
curl http://localhost:7680/api/tmux/health

# Liệt kê windows
curl http://localhost:7680/api/tmux/windows

# Tạo window
curl -X POST 'http://localhost:7680/api/tmux/new?name=test'

# Chọn window
curl -X POST http://localhost:7680/api/tmux/select/1

# Đổi tên window
curl -X POST 'http://localhost:7680/api/tmux/rename/1?name=newname'

# Xóa window
curl -X DELETE http://localhost:7680/api/tmux/kill/1

# Gửi phím
curl -X POST http://localhost:7680/api/tmux/send-keys \
  -H 'Content-Type: application/json' \
  -d '{"target":"1","keys":"ls"}'

# Lấy terminal token
curl http://localhost:7680/api/tmux/terminal-token
```

- [ ] Endpoint health trả về 200
- [ ] Endpoint windows liệt kê tmux windows
- [ ] Tạo window hoạt động
- [ ] Chọn window hoạt động
- [ ] Đổi tên window hoạt động
- [ ] Xóa window hoạt động
- [ ] Gửi phím hoạt động
- [ ] Endpoint terminal token trả token dùng 1 lần (TTL 30 giây)
- [ ] Request không hợp lệ trả về lỗi đúng

---

## WebSocket Proxy

- [ ] WebSocket kết nối qua tmux-api (không trực tiếp đến ttyd)
- [ ] Proxy xử lý reconnect tốt
- [ ] Không có lỗi CORS trong console
- [ ] Kết nối ổn định khi sử dụng lâu

---

## Đa Nền Tảng

### Linux

- [ ] Chế độ container hoạt động
- [ ] Chế độ native hoạt động
- [ ] Script nhận diện đúng kiến trúc (x86_64/aarch64)

### macOS

- [ ] Chế độ container hoạt động (Docker Desktop hoặc Podman)
- [ ] Chế độ native hoạt động
- [ ] Cross-compile cho Linux container hoạt động
- [ ] Fallback `ipconfig getifaddr en0` hoạt động cho LAN IP

### Windows

- [ ] Chế độ container hoạt động (Docker Desktop)
- [ ] Chế độ native hoạt động (psmux + ttyd + tmux-api)
- [ ] PowerShell script xử lý mã hóa DPAPI
- [ ] Link/Unlink tạo global command
- [ ] `termote.ps1` flags: `-Lan`, `-NoAuth`, `-Port`, `-Tailscale`, `-Fresh`

---

## Build & CI/CD

```bash
make build
make test
```

- [ ] PWA build không lỗi: `cd pwa && pnpm build`
- [ ] TypeScript compile: `cd pwa && pnpm tsc --noEmit`
- [ ] Lint pass: `cd pwa && pnpm biome check .`
- [ ] Go build không lỗi: `cd tmux-api && go build`
- [ ] Tất cả shell tests pass: `make test`
- [ ] Tất cả Go tests pass: `cd tmux-api && go test ./...`
- [ ] CI pipeline website chạy khi push
- [ ] Website deploy thành công

---

## Unit Tests

```bash
cd pwa && pnpm test
```

- [ ] Tất cả Vitest unit tests pass (hooks, utils, contexts)

## E2E Tests

```bash
cd pwa && pnpm test:e2e
```

- [ ] Tất cả Playwright tests pass
- [ ] Tests chạy headless
- [ ] Tests chạy với flag `--ui`

---

## Ghi Chú

_Thêm các vấn đề hoặc quan sát trong quá trình test:_

-
- ***

  **Người test:** **\*\***\_\_\_**\*\***

  **Ngày:** **\*\***\_\_\_**\*\***

  **Phiên bản:** **\*\***\_\_\_**\*\***
