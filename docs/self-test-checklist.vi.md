# Danh Sách Kiểm Tra Trước Phát Hành

Kiểm tra thủ công các tính năng Termote trước khi release.

## Yêu Cầu

- [ ] Đã cài tmux
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
- [ ] Thông tin đăng nhập tự sinh hiển thị trong logs: `docker logs termote`

### Chế Độ Native

- [ ] `./scripts/termote.sh install native` hoàn thành không lỗi
- [ ] Các process đang chạy: `ps aux | grep -E 'ttyd|tmux-api'`
- [ ] PWA truy cập được tại <http://localhost:7680>

### Tùy Chọn

- [ ] Flag `--lan` mở truy cập LAN (test từ thiết bị khác)
- [ ] `--no-auth` tắt xác thực
- [ ] `/terminal/` bị chặn khi truy cập trực tiếp URL trên trình duyệt (403)
- [ ] `/terminal/` truy cập được từ trình duyệt mobile qua LAN/Tailscale (không có header Sec-Fetch-Dest)
- [ ] `/terminal/` load được trong iframe PWA với token hợp lệ
- [ ] `--port <port>` đổi port đúng
- [ ] `--tailscale <host>` cấu hình Tailscale HTTPS
- [ ] Biến môi trường `TERMOTE_USER`/`TERMOTE_PASS` hoạt động
- [ ] Biến `WORKSPACE` mount đúng thư mục

### Gỡ Cài Đặt

- [ ] `./scripts/termote.sh uninstall container` xóa container
- [ ] `./scripts/termote.sh uninstall native` dừng các process
- [ ] `./scripts/termote.sh uninstall all` dọn sạch tất cả

### Link/Unlink

- [ ] `./scripts/termote.sh link` tạo symlink (thử /usr/local/bin, fallback ~/.local/bin)
- [ ] `termote help` hoạt động sau khi link
- [ ] `./scripts/termote.sh unlink` xóa symlink và hiện hướng dẫn khôi phục

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
- [ ] Desktop: Danh sách icon hiển thị đúng (không lỗi layout)
- [ ] Trang About đẹp trong dark mode
- [ ] Nút Settings nhấn được trên mobile
- [ ] Nút Clear Cache & Reload hoạt động (hủy SW, xóa cache, reload trang)

### Cài Đặt/Offline

- [ ] PWA cài được vào homescreen (mobile/desktop)
- [ ] Service worker đã đăng ký
- [ ] Chế độ offline hiển thị shell đã cache

### Hướng Dẫn & Tài Liệu

- [ ] Hướng dẫn sử dụng cơ bản truy cập được
- [ ] Các phím tắt tmux thường dùng được ghi chép
- [ ] Danh sách tổ hợp phím hay dùng

---

## Quản Lý Session

### Chuyển Session

- [ ] Sidebar mở (vuốt từ cạnh trái hoặc nhấn icon hamburger)
- [ ] Sidebar scroll được khi có nhiều session
- [ ] Sidebar thu gọn/mở rộng hoạt động (desktop)
- [ ] Sidebar thu gọn chỉ hiện icon với tooltip (desktop)
- [ ] Tạo session mới hoạt động
- [ ] Sửa tên session hoạt động
- [ ] Xóa session hoạt động
- [ ] Nhấn session chuyển terminal
- [ ] Session đang active được highlight trong sidebar
- [ ] Sessions giữ nguyên sau khi refresh trang

### Fullscreen (Desktop)

- [ ] Nút fullscreen hiện trên header (chỉ desktop)
- [ ] Nhấn bật/tắt chế độ toàn màn hình
- [ ] Icon đổi giữa Maximize/Minimize
- [ ] Esc/F11 thoát fullscreen và đồng bộ trạng thái nút

### Thao Tác Session (Mobile)

- [ ] Nút Sửa/Xóa ẩn mặc định
- [ ] Vuốt trái/phải trên session item hiện nút Sửa/Xóa

### tmux Sessions

- [ ] Sessions tạo qua API: `curl localhost:7680/api/tmux/sessions`
- [ ] Chuyển session qua API hoạt động
- [ ] Trạng thái session giữ nguyên sau khi terminal reconnect

---

## Cử Chỉ Mobile

Test trên thiết bị di động thật:

| Cử Chỉ     | Hành Động         | Trạng Thái |
| ---------- | ----------------- | ---------- |
| Vuốt trái  | Ctrl+C            | [ ]        |
| Vuốt phải  | Tab               | [ ]        |
| Vuốt lên   | Lịch sử lên (↑)   | [ ]        |
| Vuốt xuống | Lịch sử xuống (↓) | [ ]        |
| Nhấn giữ   | Dán               | [ ]        |
| Chụm vào   | Giảm font         | [ ]        |
| Chụm ra    | Tăng font         | [ ]        |

### Scroll & Copy Mode

- [ ] Scroll lên/xuống = Page Up/Down khi bật copy mode
- [ ] Terminal scroll được khi bàn phím mobile mở
- [ ] Terminal scroll được trong chế độ gõ tiếng Việt (IME)
- [ ] Scroll vẫn hoạt động (không bị chặn bởi swipe)

### Trường Hợp Đặc Biệt

- [ ] Cử chỉ hoạt động trong chế độ gõ IME
- [ ] Không kích hoạt nhầm khi gõ bình thường

---

## Bàn Phím Ảo

### Chế Độ Thu Gọn (Mặc Định)

- [ ] Thanh công cụ hiển thị trên bàn phím hệ thống
- [ ] Phím Tab gửi Tab
- [ ] Phím Esc gửi Escape
- [ ] Phím Enter gửi Enter
- [ ] Modifier Ctrl bật/tắt (có chỉ báo)
- [ ] Modifier Shift bật/tắt (có chỉ báo)
- [ ] Phím mũi tên (←↑↓→) hoạt động
- [ ] Nút mở rộng hiển thị
- [ ] Các nút dùng icon (kích thước đọc được, không dùng symbol)
- [ ] Nhấn giữ nút KHÔNG hiện context menu

### Chế Độ Mở Rộng

- [ ] Nút mở rộng chuyển sang view đầy đủ
- [ ] Phím Home hoạt động
- [ ] Phím End hoạt động
- [ ] Phím Delete hoạt động
- [ ] Phím Page Up/Down hoạt động
- [ ] Nút A-/A+ tăng giảm font hoạt động
- [ ] Nút thu gọn quay về chế độ minimal

### Tổ Hợp Phím

- [ ] Ctrl+C (ngắt) hoạt động
- [ ] Ctrl+L (xóa màn hình) hoạt động
- [ ] Ctrl+D (EOF) hoạt động
- [ ] Ctrl+Z (tạm dừng) hoạt động
- [ ] Ctrl+Shift+V (dán) hoạt động
- [ ] Ctrl+Shift+C (sao chép) hoạt động

### Hỗ Trợ IME

- [ ] Hỗ trợ gõ tiếng Việt (IME) trên mobile

---

## Xác Thực

### Basic Auth

- [ ] Trình duyệt yêu cầu đăng nhập khi truy cập lần đầu
- [ ] Thông tin đúng cho phép truy cập
- [ ] Thông tin sai bị từ chối (401)
- [ ] Auth giữ nguyên sau khi refresh
- [ ] Logout xóa session

### Chế Độ Không Auth

- [ ] Flag `--no-auth` bỏ qua yêu cầu đăng nhập
- [ ] Truy cập trực tiếp không cần thông tin

---

## API Endpoints

```bash
# Kiểm tra health
curl http://localhost:7680/api/tmux/health

# Liệt kê sessions
curl http://localhost:7680/api/tmux/sessions

# Tạo session
curl -X POST http://localhost:7680/api/tmux/sessions \
  -H 'Content-Type: application/json' \
  -d '{"name":"test"}'

# Chuyển session
curl -X POST http://localhost:7680/api/tmux/switch \
  -H 'Content-Type: application/json' \
  -d '{"session":"test"}'
```

- [ ] Endpoint health trả về 200
- [ ] Endpoint sessions liệt kê tmux sessions
- [ ] Tạo session hoạt động
- [ ] Chuyển session hoạt động
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

### Windows (WSL2)

- [ ] Chế độ container hoạt động trong WSL2
- [ ] Script chạy trong WSL bash

---

## Build & CI/CD

```bash
make build
make test
```

- [ ] PWA build không lỗi: `cd pwa && pnpm build`
- [ ] TypeScript compile: `cd pwa && pnpm tsc --noEmit`
- [ ] Go build không lỗi: `cd tmux-api && go build`
- [ ] Tất cả shell tests pass: `make test`
- [ ] CI pipeline website chạy khi push
- [ ] Website deploy thành công

---

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
-
- ***

  **Người test:** **\*\***\_\_\_**\*\***

  **Ngày:** **\*\***\_\_\_**\*\***

  **Phiên bản:** **\*\***\_\_\_**\*\***
