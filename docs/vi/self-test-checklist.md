# Danh Sách Kiểm Tra Trước Phát Hành

Kiểm tra thủ công các tính năng Termote trước khi release.

## Yêu Cầu

- [ ] Đã cài tmux (macOS/Linux)
- [ ] Đã cài `psmux` (Windows)
- [ ] Đã cài herdr (chỉ cần khi test backend Herdr, chế độ native; container đã có sẵn herdr)
- [ ] Go 1.26.9+ (để build native; Go cũ hơn tự tải bản này khi `GOTOOLCHAIN` là `auto`)
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
- [ ] Chọn đúng bản ổn định 1.x mới nhất đã phát hành (không bao giờ chọn bản 0.x, bản thử nghiệm, hay bản nháp mà release-please đã đẩy tag lên)
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
- [ ] Nút font khi công tắc fit đang tắt: cỡ 14 hiển thị như trước; mỗi nấc tăng làm chữ to thêm
      1px, và trên điện thoại kéo được pane to hơn màn hình theo cả hai chiều
- [ ] Bật Settings → Terminal → **Fit herdr pane to this device** (chỉ trên workspace thử):
      `stty size` trong pane báo đúng khổ của PWA ở font đã chọn, và đổi theo font; gõ từ desktop
      vẫn được
- [ ] Ẩn tab PWA thì desktop lấy lại khổ của mình trong vòng một giây; hiện lại thì PWA giành lại
- [ ] Mở Chat view thì desktop lấy lại khổ; một hộp thoại cao của Claude Code (câu multiSelect có
      mô tả) hiện thành một thẻ đứng yên; quay lại terminal thì PWA giành lại khổ
- [ ] Đổi khổ pane trên desktop trong lúc PWA đang giữ khổ, rồi ẩn PWA: PWA hiển thị đúng khổ
      mới của desktop
- [ ] Hai trình duyệt cùng bật công tắc: bên được hiện sau cùng giữ khổ, bên kia hiện thông báo và
      vẫn xem được pane
- [ ] Tắt mạng điện thoại trong lúc nó giữ khổ: desktop lấy lại khổ trong khoảng 30 giây
- [ ] `kill -9` server trong lúc PWA giữ khổ: desktop lấy lại khổ

### Chế Độ Native + Herdr (Windows)

- [ ] `termote start --mux herdr` hoàn thành không lỗi (có `herdr.exe` trong `PATH`)
- [ ] `curl localhost:7690/api/mux/health` trả về `"backend":"herdr"` (kết nối tới `\\.\pipe\` cộng đường dẫn `%APPDATA%\herdr\herdr.sock`)
- [ ] Khi có cả psmux và Herdr, lần `termote start` đầu tiên nhận ra Herdr và hỏi chọn (không có terminal để hỏi thì chọn psmux)
- [ ] Stream, gõ phím, dán, cuộn và huy hiệu trạng thái agent chạy như trên Linux
- [ ] Đổi kích thước pane trong Herdr (chia đôi hoặc phóng to pane) thì `observe` chạy lại theo kích thước mới
- [ ] `observe` khởi động từ Scheduled Task không mở cửa sổ dòng lệnh nào
- [ ] Sau `termote stop`, và sau `Stop-Process -Force` với server,
      `Get-CimInstance Win32_Process -Filter "Name='herdr.exe'"` không còn tiến trình `terminal session observe`
      hay `terminal session control`
- [ ] Dừng một stream đang giữ khổ pane thì desktop lấy lại khổ của mình

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

- [ ] `termote uninstall` dừng dịch vụ, gỡ đăng ký, lệnh `termote`, thư mục cài đặt và ảnh đã
      tải lên, nhưng giữ nguyên cấu hình và log đã lưu (in ra cả hai đường dẫn)
- [ ] `termote uninstall --purge` xóa luôn cấu hình và log; mục Uninstall trong menu hỏi trước
- [ ] Windows: khi `termote uninstall` kết thúc, `%LOCALAPPDATA%\termote` chỉ còn `state\`
      (không còn gì với `--purge`), và không in ra "The system cannot find the path specified."

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
- [ ] Menu "More" (⋯) mở được từ header trên mobile và máy tính
- [ ] Mục `Clear cache & reload` trong menu More hoạt động (hủy SW, xóa cache, kết thúc phiên trên server, tải lại trang)
- [ ] Khi bật đăng nhập, mục `Log out` trong menu More mở trang đăng nhập, và phiên cũ không còn dùng được nữa (tải lại trang thì phải đăng nhập lại); khi tắt đăng nhập (`--no-auth`) thì mục này không hiện

### Chỉ Báo Kết Nối

- [ ] Hiện trạng thái "đang kết nối" (chấm vàng nhấp nháy) khi vừa tải trang
- [ ] Hiện trạng thái "đã kết nối" (chấm xanh, icon Wifi) khi hoạt động
- [ ] Hiện trạng thái "mất kết nối" (chấm đỏ, icon WifiOff) khi server không phản hồi
- [ ] Nhấn được khi mất kết nối — kích hoạt kết nối lại

### Thông Báo Toast

- [ ] Toast hiện khi lỗi bảng nhớ tạm, lỗi dán, có bản cập nhật
- [ ] Tự tắt sau ~4 giây
- [ ] Hiện gần mép trên (không che toolbar), màu theo trạng thái (info, success, warning, danger)

### Cài Đặt

- [ ] Settings mở từ menu More (⋯): bảng toàn màn hình trên điện thoại, hộp thoại hai cột có danh sách nhóm trên máy tính
- [ ] Có đủ các nhóm: Appearance, Keyboard, Terminal, Sessions, Data & help
- [ ] Kiểu giao diện (Neutral, Terminal, Native) áp dụng ngay và giữ nguyên sau khi tải lại
- [ ] Escape đóng Settings, Help & gestures và About
- [ ] Chuyển đổi hành vi gửi IME hoạt động (Gửi text / Gửi + Enter)
- [ ] Chuyển đổi nguồn dán hoạt động (bảng nhớ tạm hệ thống / "tmux buffer" trên tmux, "Session buffer" ở backend khác)
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
- [ ] Theme (Light / Dark / System) chọn được trong menu More
- [ ] Theme nào cũng chạy đúng với mọi kiểu giao diện
- [ ] Khi hệ điều hành bật giảm chuyển động, các hiệu ứng động tắt
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

- [ ] Máy tính: sidebar hiện sẵn; mobile: chip phiên trên header ("Open sessions menu") mở danh sách phiên dưới dạng bảng trượt từ đáy màn hình, có nút "New session"
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
- [ ] Có `caps.groups`: group nào cũng có header kèm menu ⋯, kể cả khi tmux chỉ có một session
- [ ] "New tmux session" (tmux) / "New workspace" (Herdr) mở hộp thoại; nhập tên và thư mục tuyệt
      đối thì group được tạo ở đó (`tmux ls`, `herdr workspace list`) và tab đầu của nó hiện ra
- [ ] Hộp thoại nói lý do khi bị từ chối (thư mục tương đối hoặc không tồn tại, là file, tên đã có)
      và giữ nội dung đã gõ; để trống thư mục thì bắt đầu ở thư mục home
- [ ] Tên có `#(…)` hoặc `#{…}` hiện nguyên văn trong `tmux ls` và không chạy gì
- [ ] Rename trong menu ⋯ sửa tên ngay tại chỗ; session mặc định của tmux không có Rename
- [ ] Close hỏi trước, nêu số tab; với session mặc định của tmux thì nói thêm rằng một session mới,
      rỗng sẽ được tạo và các thiết bị khác bị ngắt, rồi chúng tự kết nối lại vào đó
- [ ] Đóng group đang xem thì màn hình chuyển sang group đầu còn lại
- [ ] Herdr: đóng workspace có worktree liên kết thì hiện thông báo "close it in Herdr"
- [ ] tmux: session tạo ngoài Termote (`tmux new -s x`) hiện thành group và đóng được

### Session Tabs (Desktop)

- [ ] Thanh tab hiện khi cài đặt bật
- [ ] Tab scroll vào view khi chuyển
- [ ] Nhấn tab chuyển session
- [ ] Tab đang chọn được tô sáng

### Dải Pane (tab nhiều pane, chỉ Herdr)

- [ ] Dải pane bị ẩn với tab chỉ có một pane
- [ ] Dải pane hiện với tab có nhiều hơn một pane, mỗi pane có một huy hiệu trạng thái agent
- [ ] Chọn một pane thì đổi luồng terminal mà không đổi focus trong giao diện Herdr trên máy host
- [ ] Nút X cạnh một pane hỏi `Close pane?`; Cancel giữ pane lại, `Close pane` chỉ đóng đúng pane đó
- [ ] Đóng pane đang được truyền luồng thì luồng chuyển sang một pane khác của cùng tab

### Liên Kết Trực Tiếp

- [ ] `<base>/#/s/<group>/<tab>` mở đúng phiên đó sau khi tải xong
- [ ] ID không tồn tại thì giữ phiên hiện tại và hiện toast
- [ ] Mở liên kết không bao giờ gửi phím, tạo hay đóng phiên
- [ ] Chuyển session/tab/pane thì thanh địa chỉ cập nhật, không thêm mục lịch sử
- [ ] "Copy link" trong menu More sao chép liên kết hiện tại

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

## Chat View (Claude Code, Codex)

Chạy trên tmux (Linux/macOS), psmux (Windows) và Herdr (đã chạy `herdr integration install claude`).

### Khi Nào Có Chat

- [ ] Tab đang chạy `claude` có nút chuyển Terminal/Chat; tab không chạy thì không có
- [ ] Thoát Claude Code thì nút chuyển biến mất và app quay về terminal
- [ ] Điện thoại: header chỉ có một nút view (icon của view đang xem) thay cho các tab; nút này mở
      menu các view, view đang xem có dấu chọn, tên session vẫn đủ chỗ
- [ ] Window tmux chia đôi: chat đi theo pane đang có focus; đổi focus giữa chừng không bao giờ gửi
      tin nhắn sang pane shell

### Lịch Sử Hội Thoại

- [ ] Hiện toàn bộ hội thoại: tin nhắn của người dùng (kèm ghi chú khi có ảnh đính kèm), câu trả lời
      dạng markdown, các lần gọi tool thu gọn cùng kết quả
- [ ] Lượt mới hiện trong vòng 2 giây; đã cuộn lên thì vị trí giữ nguyên dù có mục mới
- [ ] Ảnh trong câu trả lời hiện thành link chữ, không tải gì (tab network của trình duyệt không có
      request nào tới origin khác)
- [ ] `/clear` hoặc `/resume` trong terminal: trong vòng 2 giây chat chuyển sang transcript mới,
      không lẫn hai transcript

### Gửi Tin Nhắn

- [ ] Tin nhắn nhiều dòng (có tiếng Việt) tới Claude Code nguyên văn, thành một lượt
- [ ] Khi Claude Code đang làm, đang mở hộp thoại hoặc ô nhập còn bản nháp: lệnh gửi bị từ chối với
      `input not ready` và pane không nhận phím nào
- [ ] Tin nhắn gõ trước khi một client khác chạy `/clear` thì bị từ chối, ô soạn báo hội thoại đã
      đổi
- [ ] `/` ở đầu tin nhắn liệt kê các lệnh (`/exit` đầu tiên, rồi lệnh có sẵn, lệnh và skill của dự
      án và của người dùng kèm nhãn); gõ tiếp để lọc; chạm, Enter hoặc Tab điền `/name` mà không
      gửi; phím mũi tên di chuyển, Escape hoặc dấu cách đóng danh sách
- [ ] Trên điện thoại, danh sách nằm phía trên bàn phím và cuộn được; dòng nào cũng dễ chạm
- [ ] `/model` (có ghi "opens in Terminal") được gửi đi và terminal hiện bảng chọn của lệnh này
- [ ] `/exit` hỏi trước; Cancel không gửi gì, Exit tắt Claude Code và app quay về terminal
- [ ] (Khi đã có quyền chỉ xem, #236) chế độ chỉ xem không có ô soạn và không có nút trả lời; trước
      đó mục này chỉ được unit test kiểm tra

### Hộp Thoại

- [ ] Hộp thoại xin quyền hiện thành thẻ; mỗi nút chọn đúng lựa chọn của nó, Cancel gửi Escape
- [ ] `AskUserQuestion` chọn một (tối đa 9 lựa chọn) hiện các nút chọn đúng lựa chọn; `Type something` được thay bằng
      nút "Other…"
- [ ] `Chat about this` có nút riêng và đưa Claude Code về ô nhập
- [ ] Chuỗi câu hỏi chọn một được trả lời đến cuối, mỗi tab một thẻ: hàng bước đánh dấu tab đang
      mở và các tab đã trả lời, nút "Submit answers" ở tab Submit gửi đi
- [ ] Chuyển sang tab khác trong terminal (hoặc trả lời trên thiết bị khác) trước khi chạm thì không
      gửi gì; thẻ hiện tab đang mở
- [ ] Chạm vào bước khác thì mở tab đó (cả khi lùi lại, và nhảy thẳng tới Submit); bước nào rơi vào
      màn hình khác thì dừng lại và thẻ hiện màn hình đó
- [ ] Câu hỏi hoặc tab multiSelect hiện các nút bật/tắt: mỗi lần chạm đánh dấu hoặc bỏ đánh dấu một
      lựa chọn, "Next" sang bước tiếp, giữ nguyên các lựa chọn và đánh dấu tab đã trả lời
- [ ] "Other…" mở một ô nhập: câu trả lời tiếng Việt gửi từ ô này tới Claude Code thành câu trả lời
      (câu hỏi đơn), hoặc đưa chuỗi câu hỏi sang tab kế; Cancel đóng ô nhập, hộp thoại vẫn còn
- [ ] Ở tab multiSelect, "Other…" thêm đoạn chữ thành một lựa chọn đã đánh dấu, bấm nút của nó thì
      bỏ đánh dấu; "Next" sang bước tiếp cùng lựa chọn đó
- [ ] Con trỏ chọn đang ở `Type something` trong terminal (hoặc đã gõ chữ vào đó và con trỏ vẫn ở
      đó) thì thẻ chỉ xem được; gõ chữ vào đó rồi rời đi thì thẻ không có nút "Other…"
- [ ] Di chuyển con trỏ chọn trong terminal trong lúc đã mở "Other…" mà chưa gửi thì không gửi gì
      hoặc dừng trước khi gõ; thẻ hiện hộp thoại đang có trên màn hình
- [ ] Bỏ qua một tab multiSelect bằng cách chạm sang bước khác thì tab đó vẫn chưa trả lời (Submit
      cảnh báo)
- [ ] Câu hỏi có phần xem trước cho từng lựa chọn hiện mỗi lựa chọn một nút (nhãn không chứa phần
      xem trước, không có nút `Chat about this`); chạm là chọn lựa chọn đó
- [ ] Trên điện thoại, thẻ hộp thoại cao vẫn đứng yên (pane không co lại dưới Chat view)
- [ ] Hai thiết bị cùng trả lời một hộp thoại: chỉ một câu trả lời tới được pane
- [ ] "Open terminal" chuyển sang terminal; luồng terminal vẫn giữ kết nối (không kết nối lại)

### Mobile (iPhone Safari PWA, Android Chrome)

- [ ] Bàn phím ảo không che ô soạn
- [ ] Hội thoại cuộn mượt; nút dễ bấm

### Codex

Chạy trên tmux (Linux/macOS), psmux (Windows) và Herdr (đã chạy `herdr integration install codex`).
Trên psmux, gửi tin từ Chat view chưa được cho đến khi xong #408.

- [ ] Tab chạy `codex --no-daemon` có nút chuyển Terminal/Chat; `codex` chạy thường (daemon dùng
      chung) thì không có
- [ ] Hiện tin nhắn của người dùng và của Codex, các lệnh đã chạy và file đã sửa; lượt mới hiện
      trong vòng 2 giây
- [ ] Tin nhắn có tiếng Việt tới Codex thành một lượt; tin dài hơn 1000 ký tự cũng vậy (Codex hiện
      `[Pasted Content N chars]` trước khi Enter)
- [ ] Khi Codex đang làm hoặc ô soạn của Codex còn bản nháp, lệnh gửi bị từ chối (`Not sent: ...`)
      và pane không nhận phím nào
- [ ] `/` ở đầu tin nhắn không liệt kê lệnh nào
- [ ] tmux: chạy `/new` trong terminal thì Chat view biến mất cho đến khi khởi động lại Codex
- [ ] tmux: hộp thoại xin duyệt (chạy lệnh, sửa file) hiện thành thẻ chỉ xem, kèm dòng `Answer this dialog in the
      terminal.`
- [ ] Herdr: các nút trên thẻ xin duyệt chọn đúng lựa chọn, "Cancel (Esc)" gửi Escape
- [ ] Các hộp thoại khác của Codex (chọn model, ...) chỉ xem được trên cả hai backend
- [ ] Windows: `codex` chạy thường (daemon của nó là tiến trình con `codex.exe app-server`) không có
      Chat view; `codex --no-daemon` có Chat view sau tin nhắn đầu tiên
- [ ] Windows: Codex mở từ PowerShell chạy quyền quản trị không có Chat view; log chỉ có nhiều
      nhất một dòng "holds no single rollout"

### Khởi động agent (Herdr)

Herdr 0.8.2 trở lên, `termote-dev serve --mux herdr` (hoặc `termote start --mux herdr`).

- [ ] Pane đang rảnh có view Chat với hai nút "Claude Code" và "Codex"; pane đang chạy `vim` thì
      không; tmux không có nút nào và `POST …/agent/start` trả 501
- [ ] Claude Code chạy, trạng thái đi từ `starting` sang `ready`, hội thoại hiện ra; tin đầu tiên
      gửi từ view Chat tới nơi
- [ ] Codex chạy bằng `codex --no-daemon`; view Chat nhắc gõ tin đầu tiên trong terminal, sau đó
      hội thoại hiện ra
- [ ] Gõ dở `echo hi` rồi khởi động: chỉ agent chạy. Tương tự ở dấu nhắc tiếp dòng và trong
      `cat <<EOF`
- [ ] Thư mục mới mà Claude Code hỏi tin cậy: PWA mở Terminal kèm dòng "Claude Code is asking
      something in the terminal."
- [ ] `PATH` không có `codex`: sau vài giây trạng thái `exited` và có cảnh báo kèm Open terminal;
      khởi động lại ngay thì báo Herdr còn giữ lần trước (409 `start_pending`, không gõ gì), qua
      30 giây thì chạy được
- [ ] `curl` POST tới pane đang chạy `vim` → 409 `pane_busy`, không gõ gì (màn hình không đổi)
- [ ] Hai thiết bị cùng khởi động: một bên nhận 200, bên kia 409 `starting` và theo dõi cùng lần
      khởi động
- [ ] `curl` với `{"kind":"bash"}` → 400 `invalid_kind`

Windows, Herdr 0.8.2 trở lên, shell của pane là pwsh, `termote start --mux herdr`.

- [ ] Pane pwsh đang rảnh có hai nút "Claude Code" và "Codex"; khởi động tới `ready`, hoặc
      `blocked` ở hộp thoại tin cậy thư mục (PWA mở Terminal)
- [ ] Đang chạy `ping -t 127.0.0.1`, `nvim` hay một `cmd` lồng nhau, rồi
      `curl` POST → 409 `pane_busy` và chương trình vẫn chạy (Ctrl+C không tới nó)
- [ ] `Read-Host` đang chờ, hoặc đang gõ dở, rồi khởi động: dấu nhắc được xóa và chỉ agent chạy
      (`Start-Sleep 60` và vòng lặp `while ($true) {}` cũng vậy)
- [ ] `Start-Job { Start-Sleep 300 }` đang chạy: 409 `pane_busy` (từ chối cho an toàn); sau
      `Remove-Job -Force` pane rảnh trở lại
- [ ] `curl` với `{"kind":"codex"}` chạy `codex --no-daemon`; `caps.agentStartCodex` trong
      snapshot là true

---

## Files và Changes

Chạy trên tmux (Linux/macOS) và Herdr; psmux (Windows) không có hai view này.

### Files

- [ ] Máy tính: nút "Files" và "Changes" trên header mở view trong panel bên, bấm lại thì đóng;
      điện thoại: cả hai nằm trong menu view
- [ ] Cây thư mục bắt đầu từ thư mục gốc của pane (git toplevel, nếu không có thì thư mục của
      pane); Refresh đọc lại
- [ ] Thư mục mở/đóng bằng chuột và bằng phím mũi tên; Enter hoặc nhấn vào file thì mở file
- [ ] File hiện kèm số dòng và kích thước; "Copy path" và "Wrap lines" hoạt động; nút quay lại đưa
      về cây thư mục
- [ ] File nhị phân hoặc lớn hơn 1 MiB hiện
      `Not previewable (binary, special file or larger than 1 MiB)`
- [ ] `.env` (có icon ổ khóa trên cây) hỏi `Show this file?` trước: Cancel quay lại, Show hiện nội
      dung; mở lại thì hỏi lại
- [ ] `.git` không mở được ("This directory can't be shown")
- [ ] `cd` ra ngoài thư mục gốc trong pane rồi bấm Refresh: hiện toast "The pane's directory
      changed" và cây chuyển sang thư mục gốc mới

### Changes

- [ ] Header hiện nhánh git; file được chia nhóm Conflicts, Staged, Changes, Untracked, nhóm nào
      cũng có số lượng, file nào cũng có chữ cái trạng thái
- [ ] File đã `git add` rồi sửa tiếp hiện ở cả Staged và Changes, mỗi chỗ mở diff của riêng phía đó
- [ ] Diff hiện các hunk với dòng thêm/xóa cùng "Staged" hoặc "Not staged"; file đổi tên hiện
      `old → new`
- [ ] Điện thoại có một cột số dòng, máy tính có hai
- [ ] `.env` có thay đổi thì hỏi `Show this file?` trước khi hiện diff
- [ ] Thay đổi làm trong terminal hiện trong vòng 5 giây; commit file đang mở thì hiện `No longer changed`
- [ ] Ngoài repo git: "Not a git repository: <dir>"; không có thay đổi: "No changes"

### Sửa File

- [ ] File văn bản có nút "Edit" (bút chì); bấm vào thì nội dung hiện trong một ô nhập, kèm
      "Cancel editing" và "Save"; file `.md` hiện văn bản gốc kể cả khi đang bật xem trước
- [ ] Trên điện thoại, đổi một dòng trong front matter của `docs/records/*.md` rồi Save: hiện toast
      "Saved", trên máy chỉ đúng dòng đó đổi (`git diff`); file xuống dòng `\r\n` vẫn giữ kiểu đó
- [ ] Nút Save tắt cho tới khi văn bản đổi; Ctrl+S (Cmd+S) để lưu; Cancel hoặc nút quay lại khi còn
      thay đổi thì hỏi "Discard changes?"
- [ ] Bấm Edit, sửa file trong terminal, rồi Save: hiện "The file changed on the host since you
      opened it"; văn bản vẫn còn; "Copy my text" chép văn bản ra, "Reload" hiện bản trên máy
- [ ] Đổi view (hay đóng rồi mở lại panel) khi đang sửa thì văn bản vẫn còn
- [ ] Không có "Edit" cho liên kết mềm, file trộn kiểu xuống dòng, ảnh, file lớn hơn 1 MiB, hay
      file đã `chmod 444` (lưu vào đó thì hiện "The server can't write this file")
- [ ] `.env`: "Edit" chỉ hiện sau khi bấm "Show"; lưu được mà không bị hỏi lại
- [ ] Changes: có "Edit" cho file văn bản đã sửa hoặc chưa được git theo dõi (phía Staged là "Edit
      working copy"), không có cho file đã xoá, ảnh hay diff nhị phân; Save xong thì diff phần chưa
      đưa vào index hiện văn bản mới; sửa file về đúng bản trong index thì danh sách hiện lại kèm
      "No changes left in <file>"
- [ ] Không còn file `.termote-edit-*` nào nằm cạnh file vừa lưu
- [ ] (Khi đã có quyền chỉ xem, #236) chế độ chỉ xem không có "Edit", và `PUT files/content` bị từ
      chối với quyền đó; trước đó mục này chỉ được unit test kiểm tra

### Xem Trước Markdown

- [ ] File `.md` mở ra ở dạng xem trước; nút "Preview" (hình con mắt) chuyển sang mã nguồn và
      ngược lại, lựa chọn này giữ cho file Markdown tiếp theo và sau khi tải lại
- [ ] Link tương đối mở file đó (nút quay lại về file vừa rời); link `#heading` cuộn tới tiêu đề
      đó; link `http(s)` mở trong tab mới; link ra ngoài thư mục gốc của pane chỉ là chữ thường
- [ ] Khối code được tô màu cú pháp, ghi tên ngôn ngữ và có nút "Copy code"
- [ ] HTML thô (`<b>`, `<script>`) hiện nguyên dạng chữ; ảnh hiện thành link "image: ..." và không
      tải gì
- [ ] File Markdown lớn hơn 256 KiB hiện `Too large to preview: shown as source`
- [ ] Changes: nút "Preview" của file `.md` có thay đổi hiện bản hiện tại ở dạng xem trước

### Ảnh

- [ ] PNG, JPEG, GIF và WebP mở ra thành hình kèm "<rộng>×<cao> · <dung lượng>"; file văn bản đổi
      tên thành `.png` hiện `Not previewable (not a PNG, JPEG, GIF, WebP or SVG image)`
- [ ] Ảnh lớn hơn 10 MiB hiện `Larger than 10 MiB`; con trỏ Git LFS hiện
      `Stored in Git LFS: only the pointer is in git`
- [ ] File `.svg` mở ra ở dạng mã nguồn; nút "Image" hiện hình, lựa chọn này giữ cho file SVG
      tiếp theo và sau khi tải lại; mở thẳng `/api/mux/panes/<id>/files/raw?path=<x>.svg` thì
      trình duyệt tải file về và không chạy script nào
- [ ] Tên nhạy cảm (`secrets.png`) hỏi `Show this file?` trước
- [ ] Changes: ảnh đã sửa hiện "Before · Index" và "After · Working tree" (phía Staged thì là
      "HEAD" và "Index"), trên máy tính đặt cạnh nhau, trên điện thoại xếp chồng; ảnh mới hiện "Added",
      ảnh đã xoá hiện "Deleted"; ảnh đổi tên ở phía Staged ghi đường dẫn cũ
- [ ] Changes: thay ảnh trong terminal rồi bấm Refresh thì thấy hình mới; chỉ chờ lượt poll
      5 giây thì hình không đổi

### Panel Bên (Desktop)

- [ ] Kéo cạnh trái của panel để đổi độ rộng, terminal chỉ khớp lại một lần khi thả chuột; nhấp
      đúp đưa về độ rộng mặc định; độ rộng giữ nguyên sau khi tải lại
- [ ] Khi tay nắm kéo có focus, phím mũi tên đổi từng bước, Home/End đưa tới giới hạn
- [ ] Terminal luôn còn ít nhất 360px bên cạnh panel
- [ ] "Maximize panel" phủ lên terminal; "Restore panel" hoặc Escape trả lại như cũ
- [ ] Thu hẹp cửa sổ xuống cỡ điện thoại thì view đang mở chuyển sang vùng chính

---

## Cử Chỉ Mobile

Test trên thiết bị di động thật:

| Cử Chỉ               | Hành Động                                               | Trạng Thái |
| -------------------- | ------------------------------------------------------- | ---------- |
| Vuốt trái            | Ctrl+C                                                  | [ ]        |
| Vuốt phải            | Tab                                                     | [ ]        |
| Kéo lên              | Cuộn xuống theo ngón tay (tmux: mỗi lần vuốt một trang) | [ ]        |
| Kéo xuống            | Cuộn lên theo ngón tay (tmux: mỗi lần vuốt một trang)   | [ ]        |
| Vuốt nhanh lên/xuống | Lịch sử trôi tiếp, chậm dần, dừng khi chạm lại          | [ ]        |
| Nhấn giữ             | Dán                                                     | [ ]        |
| Chụm vào             | Giảm font                                               | [ ]        |
| Chụm ra              | Tăng font                                               | [ ]        |
| Nhấn                 | Focus terminal                                          | [ ]        |

### Scroll & Copy Mode

- [ ] Scroll lên/xuống = Page Up/Down khi bật copy mode
- [ ] Terminal thu lại vừa khoảng phía trên thanh công cụ khi bàn phím mobile mở (các dòng cuối vẫn hiện)
- [ ] Terminal vừa khoảng phía trên thanh công cụ trong chế độ gõ tiếng Việt (IME)
- [ ] Scroll vẫn hoạt động (không bị cử chỉ vuốt chặn mất)

### Sao Chép Chữ (bảng Select text)

- [ ] Android Chrome: nhấn giữ trong bảng thì hiện tay nắm; Copy đưa vùng chọn vào clipboard
- [ ] iOS Safari (PWA): nhấn giữ trong bảng thì hiện tay nắm và menu hệ thống; Copy chạy đúng
- [ ] Bảng có lịch sử (tmux và Herdr), Load more đọc thêm, Copy all chép hết
- [ ] Ký tự đổi chiều chữ hoặc khoảng trắng độ rộng 0 hiện thành `⟨U+XXXX⟩`, dán ra lại đúng ký tự gốc
- [ ] Thiết bị chỉ xem: mở bảng từ thanh View only, chỉ có phần màn hình, không gửi request `/text`
- [ ] Cài đặt > Copy on select: nhả chuột sau khi kéo thì chữ được chép, có toast ngắn; mặc định tắt
- [ ] Mở trang qua HTTP thường trong LAN (không phải secure context): vẫn chép được, hoặc có toast báo lỗi rõ ràng

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

### Hàng Dưới Cùng

- [ ] Thanh công cụ hiển thị trên bàn phím hệ thống
- [ ] Nút bật/tắt bàn phím hoạt động
- [ ] Nút bật/tắt IME hoạt động
- [ ] Phím Esc gửi Escape (tắt Ctrl/Shift nếu đang bật)
- [ ] Phím bổ trợ Ctrl bật/tắt (có chỉ báo khi đang bật)
- [ ] Phím mũi tên lên/xuống hoạt động
- [ ] Phím Enter gửi Enter
- [ ] Phím Tab gửi Tab
- [ ] Nút ⋯ (Extra keys) ghim ở mép phải, nằm ngoài phần cuộn
- [ ] Các nút dùng icon (kích thước đọc được, không dùng ký hiệu chữ)
- [ ] Nhấn giữ nút KHÔNG hiện context menu

### Các Hàng Mở Rộng

- [ ] Nút ⋯ hiện các hàng (Actions trên mobile, Text · Scroll, Navigate) và ẩn lại được
- [ ] Nút Lịch sử mở dropdown lịch sử lệnh và đóng các hàng mở rộng
- [ ] Trên điện thoại, chạm vào ô tìm kiếm lịch sử: ô vẫn nằm trên màn hình, phía trên bàn phím
- [ ] Bật bàn phím ảo thì các hàng mở rộng tự đóng; nhấn ⋯ vẫn mở lại được khi bàn phím đang bật
- [ ] Phím bổ trợ Shift bật/tắt (có chỉ báo khi đang bật); đóng các hàng thì Shift tắt
- [ ] Phím ⇧Tab gửi Shift+Tab
- [ ] Phím mũi tên trái/phải hoạt động
- [ ] Các phím Home, End, Delete, Backspace, Page Up/Down và Insert hoạt động

### Tổ Hợp Ctrl (nổi phía trên thanh công cụ)

- [ ] Ctrl+C (ngắt) hoạt động
- [ ] Ctrl+D (EOF) hoạt động
- [ ] Ctrl+Z (tạm dừng) hoạt động
- [ ] Ctrl+L (xóa màn hình) hoạt động
- [ ] Ctrl+A (đầu dòng) hoạt động
- [ ] Ctrl+E (cuối dòng) hoạt động
- [ ] Ctrl+B (lùi 1 ký tự) hoạt động
- [ ] Ctrl+X (cắt) hoạt động
- [ ] Ctrl+K (xóa đến cuối) hoạt động
- [ ] Ctrl+U (xóa đến đầu) hoạt động
- [ ] Ctrl+W (xóa từ) hoạt động
- [ ] Ctrl+R (tìm ngược) hoạt động
- [ ] Ctrl+P (lệnh trước) hoạt động
- [ ] Ctrl+N (lệnh sau) hoạt động

### Tổ Hợp Ctrl+Shift

- [ ] Bôi đen bằng chuột rồi nhấn Ctrl+Shift+C thì chữ vào clipboard và terminal không nhận gì (Chrome, Firefox, Edge trên Linux/Windows); chưa bôi đen thì phím tới chương trình như cũ
- [ ] Cmd+C trên macOS chép vùng bôi đen bằng chuột
- [ ] Ctrl+Shift+V (dán) hoạt động
- [ ] Ctrl+Shift+Z (làm lại) hoạt động
- [ ] Ctrl+Shift+X (cắt) hoạt động

### Hàng Text · Scroll (hàng mở rộng)

- [ ] Nút bật/tắt tmux copy mode hoạt động
- [ ] Phím chọn chữ: đứng cạnh phím copy mode với tmux, nằm vào chỗ của nó với Herdr
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

## Thao Tác Nhanh (Mobile)

- [ ] Không còn phím ⚡ và bảng Quick actions; nút ⋯ (Extra keys) ghim ở mép phải thanh công cụ
- [ ] Trên mobile, nhấn ⋯ thì hàng Actions (Clear, Cancel, Clear line, Exit) hiện đầu tiên trong các hàng mở rộng
- [ ] Thao tác Clear (gửi 'clear' + Enter)
- [ ] Thao tác Cancel (gửi Ctrl+C)
- [ ] Thao tác `Clear line` (gửi Ctrl+U)
- [ ] Thao tác Exit (gửi Ctrl+D)
- [ ] Phản hồi rung khi thao tác
- [ ] Hàng dưới ở màn 390px: ⌨, 文, Esc, Ctrl, ↑, ↓, Enter, Tab; hàng cuộn ngang được và ⋯ luôn nằm trên màn hình
- [ ] Mép hàng dưới còn phím bị khuất thì mờ dần; đủ chỗ cho mọi phím thì không mờ
- [ ] Bật Ctrl (thu gọn hay mở rộng): các tổ hợp nổi phía trên thanh công cụ, terminal giữ nguyên kích thước
- [ ] ⇧Tab ở hàng Navigate gửi Shift+Tab

---

## Đính Kèm Ảnh (Terminal)

- [ ] Khi server nhận ảnh tải lên, thanh công cụ bàn phím có phím "Attach image" cạnh phím Dán
- [ ] Chọn ảnh PNG, JPEG, GIF hoặc WebP từ phím đó thì ảnh được tải lên, đường dẫn của nó trên máy
      host (đặt trong dấu nháy khi có dấu cách) được gõ vào pane kèm một dấu cách ở cuối, không có
      Enter
- [ ] Dán khi bảng nhớ tạm chỉ chứa ảnh (dán trong terminal, phím Dán, nhấn giữ) cũng tải ảnh lên
      như vậy; bảng nhớ tạm có chữ thì dán chữ
- [ ] Ảnh lớn hơn 10 MB: `Image is larger than 10 MB`; định dạng khác:
      `Only PNG, JPEG, GIF and WebP images can be attached`; HEIC:
      `HEIC images are not supported. Share the photo as JPEG`
- [ ] Tải lên chậm thì hiện "Uploading image…"; đổi pane trước khi tải xong thì hiện "Image
      uploaded: <path>" kèm nút Insert
- [ ] File nằm trong thư mục cache của người dùng (`~/.cache/termote/uploads` trên Linux), tên ngẫu
      nhiên
- [ ] (Khi đã có quyền chỉ xem, #236) chế độ chỉ xem không có phím hay thao tác Attach image; trước
      đó mục này chỉ được unit test kiểm tra

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
- [ ] Bộ giới hạn tần suất chặn cả một dải IPv6 /64 sau 20 lần thất bại/phút (429)
- [ ] Log server có dòng `auth: failed login from <ip>` và `auth: <ip> blocked ...`, không chứa
      username hay mật khẩu đã gửi
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
