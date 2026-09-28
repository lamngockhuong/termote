# Bắt đầu với Termote

Điều khiển Claude Code, GitHub Copilot, hoặc bất kỳ công cụ terminal nào từ điện thoại — chỉ trong 5 phút.

## Termote là gì?

Termote (Terminal + Remote) biến trình duyệt thành terminal thân thiện với thiết bị di động. Nó bọc các công cụ CLI hiện có với cử chỉ cảm ứng, bàn phím ảo và quản lý phiên — tất cả qua PWA có thể cài đặt lên màn hình chính.

Từ bản 1.0.0, một tệp thực thi duy nhất là `termote` đảm nhận mọi việc: phục vụ PWA, cung cấp API, xác thực, và tự truyền luồng terminal (PTY trên Unix, ConPTY trên Windows) qua WebSocket `/api/mux/stream` tới xterm.js trong trình duyệt. Termote không còn dùng `ttyd`. CLI cũng nằm trong chính tệp đó — trình cài đặt đưa thẳng `termote` vào `PATH`, nên không còn lớp vỏ trung gian nào để gọi.

**Các trường hợp sử dụng:**

- Điều khiển Claude Code từ điện thoại khi rời bàn làm việc
- Giám sát tiến trình chạy lâu từ di động
- Lập trình cặp bằng cách chia sẻ phiên terminal
- Chạy công cụ CLI trên máy chủ từ xa với giao diện cảm ứng

## Cài đặt

> Để xem các tùy chọn chi tiết (cờ cho chế độ native, chế độ container, Windows, Tailscale), xem [Hướng dẫn triển khai](deployment-guide.md).

Chỉ hai lệnh, trên Linux hoặc macOS:

```bash
curl -fsSL https://termote.ohnice.app/install.sh | sh
termote start
```

Trên Windows (PowerShell):

```powershell
irm https://termote.ohnice.app/install.ps1 | iex
termote start
```

Trình cài đặt chỉ tải bản phát hành đúng hệ điều hành/kiến trúc, kiểm tra checksum rồi đặt vào đúng vị trí — nó không tự khởi động bất cứ thứ gì. `termote start` tạo mật khẩu lần đầu và in ra một lần duy nhất, đăng ký server với hệ điều hành (systemd/launchd/Scheduled Task) để nó tồn tại qua các lần đăng nhập, rồi in URL ngay khi server phản hồi — mở URL đó trong trình duyệt. Xem lại mật khẩu bất cứ lúc nào bằng:

```bash
termote show-password
```

Muốn chạy container thay vì cài native? Chạy `termote container up` (cần podman hoặc docker) thay cho `termote start`; xem [Hướng dẫn triển khai](deployment-guide.md) để biết các cờ của lệnh này.

## Truy cập từ điện thoại

### Mạng nội bộ (LAN)

Để truy cập Termote từ các thiết bị khác trong cùng mạng:

```bash
termote start --lan
```

Lệnh này gắn server vào `0.0.0.0` thay vì `127.0.0.1` (ví dụ: truy cập được qua `http://192.168.1.100:7680`). Mở URL đó trên điện thoại.

Server chỉ chấp nhận request có header `Host` nằm trong danh sách được phép: luôn cho phép chính máy này (`localhost`, `127.0.0.1`, `::1`), và khi dùng `--lan` thì cho phép đúng địa chỉ mà request thực sự gửi tới (nên vẫn hoạt động khi IP LAN đổi), cộng với tên Tailscale khi dùng `--tailscale`. Nếu bạn truy cập bằng một hostname khác (ví dụ tên máy trong mạng nội bộ), hãy thêm nó bằng `--allow-host <name>` (lặp lại được):

```bash
termote start --lan --allow-host mypc.local
```

### Cài đặt dạng PWA

Để có trải nghiệm di động tốt nhất, cài Termote dưới dạng Progressive Web App:

1. Mở Termote trong trình duyệt điện thoại
2. **iOS:** Nhấn Chia sẻ → "Thêm vào Màn hình chính"
3. **Android:** Nhấn menu → "Cài đặt ứng dụng" hoặc "Thêm vào Màn hình chính"

PWA hoạt động offline và giống như ứng dụng gốc.

## Sử dụng Termote

### Phiên làm việc (Sessions)

Termote tổ chức terminal theo ba cấp: **group → tab → pane**. Với tmux (mặc định), mỗi group là một session của tmux và mỗi tab là một cửa sổ tmux:

- **Tạo mới:** Nhấn nút "+" trong thanh bên
- **Chuyển đổi:** Nhấn tên phiên trong thanh bên
- **Xóa:** Vuốt trái trên phiên (hoặc dùng biểu tượng xóa)

Mỗi phiên độc lập — chạy Claude Code trong phiên này, tiến trình build trong phiên khác.

Ở chế độ native, bạn có thể dùng [Herdr](https://herdr.dev/#install) thay cho tmux bằng `termote start --mux herdr`. Khi đó một tab có thể có nhiều pane, và mỗi pane hiện huy hiệu trạng thái của agent lập trình đang chạy trong đó. Herdr không dùng được ở chế độ container.

### Cử chỉ cảm ứng

| Cử chỉ     | Hành động                               |
| ---------- | --------------------------------------- |
| Vuốt trái  | Gửi `Ctrl+C` (ngắt lệnh)                |
| Vuốt phải  | Gửi `Tab` (tự động hoàn thành)          |
| Vuốt lên   | Cuộn xuống (quay lại phần output mới)   |
| Vuốt xuống | Cuộn lên (xem lại phần output trước đó) |

### Bàn phím ảo

Thanh công cụ ở dưới cùng cung cấp các phím bổ trợ:

- **Tab** — tự động hoàn thành
- **Ctrl** — chạm một lần rồi chạm phím khác để gửi Ctrl+phím
- **Shift** — chạm một lần để áp Shift cho phím kế tiếp (Shift+Tab = lùi tab)
- **Esc** — thoát chế độ hiện tại (hữu ích cho `vim`)
- **↑ / ↓** — duyệt lịch sử lệnh

## Quy trình làm việc phổ biến

### Chạy Claude Code từ di động

1. Mở một phiên trong Termote
2. Gõ `claude` để khởi động Claude Code
3. Dùng cử chỉ cảm ứng: vuốt xuống/lên để cuộn output, vuốt phải để tự động hoàn thành bằng Tab
4. Dùng bàn phím ảo cho các phím đặc biệt (Ctrl+C để ngắt)

### Giám sát tiến trình chạy lâu

1. Khởi động tiến trình trong một phiên (ví dụ: `npm run build`)
2. Chuyển sang phiên khác trong khi chờ
3. Quay lại kiểm tra kết quả — phiên vẫn được giữ nguyên

### Quy trình đa phiên

1. **Phiên 1:** Chạy dev server (`npm run dev`)
2. **Phiên 2:** Chạy Claude Code để lập trình với AI
3. **Phiên 3:** Theo dõi log (`tail -f logs/app.log`)
4. Chuyển giữa các phiên bằng thanh bên

## Xử lý sự cố

### Không truy cập được từ điện thoại

- Đảm bảo đã khởi động với cờ `--lan`
- Kiểm tra cả hai thiết bị cùng mạng
- Xác nhận URL khớp với IP nội bộ của máy chủ (`ip addr` hoặc `ifconfig`)
- Kiểm tra tường lửa cho phép cổng 7680
- Nếu nhận lỗi 403 do Host bị từ chối, chạy lệnh `termote start --allow-host <name>` mà thông báo lỗi gợi ý

### Quên mật khẩu

- Chạy `termote show-password` để in lại mật khẩu đã lưu

### Terminal hiển thị không đúng

- Dùng trình duyệt hiện đại (Chrome, Safari, Firefox)
- Thử chế độ ngang để terminal rộng hơn
- Nếu chữ quá nhỏ, phóng to rồi tải lại trang

### Mất phiên sau khi khởi động lại

- Phiên được giữ khi tải lại trang nhưng không qua khởi động lại server
- Để tự động khởi tạo phiên, thêm lệnh vào tệp cấu hình của shell (`~/.bashrc`, `~/.zshrc`)
- Dùng `termote status` để kiểm tra trạng thái dịch vụ

### Mất kết nối

- Kiểm tra cường độ tín hiệu WiFi
- Nếu truy cập từ mạng ngoài (không phải LAN), cân nhắc đặt một proxy ngược có HTTPS phía trước
- PWA sẽ tự động kết nối lại khi có mạng trở lại

## Nếu bạn đang dùng bản 0.x

Không có đường nâng cấp tại chỗ từ 0.x lên 1.0: cấu trúc cài đặt, định dạng cấu hình và CLI đều đã đổi khác. Hãy gỡ bản 0.x trước (xem [tài liệu 0.x đã lưu trữ](https://termote.ohnice.app/0.x/) để biết các bước gỡ riêng của bản đó), rồi cài bản 1.0 từ đầu bằng hai lệnh phía trên.
