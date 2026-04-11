# Bắt đầu với Termote

Điều khiển Claude Code, GitHub Copilot, hoặc bất kỳ công cụ terminal nào từ điện thoại — chỉ trong 5 phút.

## Termote là gì?

Termote (Terminal + Remote) biến trình duyệt thành terminal thân thiện với thiết bị di động. Nó bọc các công cụ CLI hiện có với cử chỉ cảm ứng, bàn phím ảo và quản lý phiên — tất cả qua PWA có thể cài đặt lên màn hình chính.

**Các trường hợp sử dụng:**

- Điều khiển Claude Code từ điện thoại khi rời bàn làm việc
- Giám sát tiến trình chạy lâu từ di động
- Lập trình cặp bằng cách chia sẻ phiên terminal
- Chạy công cụ CLI trên máy chủ từ xa với giao diện cảm ứng

## Cài đặt

> Để xem chi tiết các tùy chọn cài đặt (Container Mode, Native Mode, Windows), xem [Hướng dẫn triển khai](deployment-guide.md).

Bắt đầu nhanh với Container Mode:

```bash
curl -fsSL https://raw.githubusercontent.com/lamngockhuong/termote/main/scripts/termote.sh -o termote.sh
chmod +x termote.sh
./termote.sh install container
```

Termote sẽ chạy tại `http://localhost:7680`. Mở trong trình duyệt.

## Truy cập từ điện thoại

### Mạng nội bộ (LAN)

Để truy cập Termote từ các thiết bị khác trong cùng mạng:

```bash
./termote.sh install container --lan
```

Lệnh này bind vào IP nội bộ (ví dụ: `http://192.168.1.100:7680`). Mở URL đó trên điện thoại.

### Cài đặt dạng PWA

Để có trải nghiệm di động tốt nhất, cài Termote dưới dạng Progressive Web App:

1. Mở Termote trong trình duyệt điện thoại
2. **iOS:** Nhấn Chia sẻ → "Thêm vào Màn hình chính"
3. **Android:** Nhấn menu → "Cài đặt ứng dụng" hoặc "Thêm vào Màn hình chính"

PWA hoạt động offline và giống như ứng dụng gốc.

## Sử dụng Termote

### Phiên làm việc (Sessions)

Termote quản lý **phiên tmux** (hiển thị là "windows" trong giao diện):

- **Tạo mới:** Nhấn nút "+" trong thanh bên
- **Chuyển đổi:** Nhấn tên phiên trong thanh bên
- **Xóa:** Vuốt trái trên phiên (hoặc dùng biểu tượng xóa)

Mỗi phiên độc lập — chạy Claude Code trong phiên này, build process trong phiên khác.

### Cử chỉ cảm ứng

| Cử chỉ     | Hành động                      |
| ---------- | ------------------------------ |
| Vuốt trái  | Gửi `Ctrl+C` (ngắt lệnh)       |
| Vuốt phải  | Gửi `Tab` (tự động hoàn thành) |
| Vuốt lên   | Lệnh trước đó (↑)              |
| Vuốt xuống | Lệnh tiếp theo (↓)             |

### Bàn phím ảo

Thanh công cụ ở dưới cùng cung cấp các phím bổ trợ:

- **Tab** — tự động hoàn thành
- **Ctrl** — giữ để dùng tổ hợp Ctrl+phím
- **Shift** — bật/tắt chữ hoa
- **Esc** — phím escape (hữu ích cho vim)
- **↑ / ↓** — duyệt lịch sử lệnh

## Quy trình làm việc phổ biến

### Chạy Claude Code từ di động

1. Mở một phiên trong Termote
2. Gõ `claude` để khởi động Claude Code
3. Dùng cử chỉ cảm ứng: vuốt lên/xuống cho lịch sử, vuốt phải để tab completion
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

### Terminal hiển thị không đúng

- Dùng trình duyệt hiện đại (Chrome, Safari, Firefox)
- Thử chế độ ngang để terminal rộng hơn
- Nếu chữ quá nhỏ, phóng to rồi tải lại trang

### Mất phiên sau khi khởi động lại

- Phiên được giữ khi tải lại trang nhưng không qua khởi động lại server
- Để tự động khởi tạo phiên, thêm lệnh vào shell profile
- Dùng `termote health` để kiểm tra trạng thái dịch vụ

### Mất kết nối

- Kiểm tra cường độ tín hiệu WiFi
- Nếu dùng qua internet (không phải LAN), cân nhắc reverse proxy với HTTPS
- PWA sẽ tự động kết nối lại khi có mạng trở lại
