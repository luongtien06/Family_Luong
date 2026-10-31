# BACKEND ĐỒNG BỘ NGUYÊN KHỐI GITHUB — CLOUDFLARE WORKER (FAMILY_LUONG)

Tài liệu hướng dẫn triển khai và vận hành Backend trung gian bảo mật cho dự án Gia phả **Family_Luong** trên Cloudflare Workers.

---

## 1. TỔNG QUAN KIẾN TRÚC

```
[ Trình duyệt Admin (Web) ]
           │
           │  1. Upload ảnh & Cập nhật form
           │  2. Gửi request Atomic Sync kèm Bearer Token (ADMIN_SECRET)
           ▼
[ Cloudflare Worker Backend ]
     ├── Xác thực Admin (ADMIN_SECRET)
     ├── Kiểm tra định dạng Magic Bytes & Dung lượng (<= 5MB)
     ├── Kiểm tra tính an toàn tên tệp (kebab-case slug)
     ├── Giữ GitHub PAT trong Cloudflare Secrets (không lộ ra ngoài)
     └── Thực thi đồng bộ nguyên khối qua GitHub Git Data API:
           ├── Tạo Git Blobs cho từng ảnh mới
           ├── Kiểm tra & gắn flag sha: null cho ảnh cũ không còn dùng
           ├── Tạo Git Blob cho data.json
           ├── Tạo Git Tree kết hợp ảnh và data.json
           ├── Tạo Git Commit nguyên khối
           └── Cập nhật Branch ref (main) không cho phép xung đột
           │
           ▼
[ GitHub Repository: luongtien06/Family_Luong ]
     ├── Cả ảnh (assets/members/) & data.json cùng nằm trong 1 commit duy nhất
     └── Kích hoạt GitHub Pages tự động Build & Deploy
```

---

## 2. CÁC BƯỚC THIẾT LẬP VÀ TRIỂN KHAI

### Bước 1: Tạo GitHub Personal Access Token (Fine-grained Token)
1. Truy cập GitHub: **Settings** $\rightarrow$ **Developer settings** $\rightarrow$ **Personal access tokens** $\rightarrow$ **Fine-grained tokens**.
2. Nhấn **Generate new token**.
3. Điền thông tin:
   - **Token name:** `Family-Luong-Worker-Sync`
   - **Expiration:** Chọn thời hạn (ví dụ: 90 ngày hoặc 1 năm tùy nhu cầu).
   - **Repository access:** Chọn **Only select repositories** $\rightarrow$ Chọn `luongtien06/Family_Luong`.
   - **Repository permissions:**
     - `Contents`: Chọn **Access: Read and write** (để đọc/ghi ảnh và data.json).
     - `Metadata`: Mặc định **Read-only**.
4. Nhấn **Generate token** và sao chép mã token (bắt đầu bằng `github_pat_...`).

> [!IMPORTANT]
> Token này CHỈ được lưu trong Cloudflare Secrets của Worker. Tuyệt đối KHÔNG dán vào mã nguồn, file HTML, hay commit lên GitHub!

---

### Bước 2: Triển khai Worker lên Cloudflare

#### Cách A: Triển khai qua lệnh Wrangler (Khuyên dùng)
Tại thư mục `worker/`:
```bash
cd worker
npm install

# Đăng nhập Cloudflare nếu chưa đăng nhập
npx wrangler login

# Thiết lập bí mật GitHub PAT
npx wrangler secret put GITHUB_PAT
# Nhập mã github_pat_... vừa tạo ở Bước 1

# Thiết lập Mật khẩu Quản trị viên (ADMIN_SECRET)
npx wrangler secret put ADMIN_SECRET
# Nhập mật khẩu bạn muốn dùng khi đăng nhập Admin trên web

# Triển khai Worker
npx wrangler deploy
```

Sau khi deploy thành công, terminal sẽ in ra URL của Worker, ví dụ:
`https://family-luong-sync-worker.<your-subdomain>.workers.dev`

#### Cách B: Tạo trực tiếp trên Cloudflare Dashboard (Không cần cài Node)
1. Đăng nhập [Cloudflare Dashboard](https://dash.cloudflare.com) $\rightarrow$ Vào **Workers & Pages** $\rightarrow$ **Create Application** $\rightarrow$ **Create Worker**.
2. Đặt tên worker: `family-luong-sync-worker` $\rightarrow$ Nhấn **Deploy**.
3. Nhấn **Edit code** $\rightarrow$ Dán toàn bộ nội dung từ tệp `worker/src/index.js` vào $\rightarrow$ Nhấn **Save and Deploy**.
4. Vào tab **Settings** của Worker $\rightarrow$ **Variables and Secrets**:
   - Thêm secret `GITHUB_PAT`: Giá trị là mã token GitHub ở Bước 1.
   - Thêm secret `ADMIN_SECRET`: Mật khẩu đăng nhập quản trị viên trên web.
   - (Tùy chọn) Thêm environment variable `ALLOWED_ORIGINS`: `https://luongtien06.github.io`.

---

### Bước 3: Cấu hình trên website Family_Luong
1. Mở trang web gia phả $\rightarrow$ Nhấn nút **Admin**.
2. Chọn chế độ: **Cloudflare Worker (Khuyên dùng)**.
3. Điền:
   - **Worker API URL:** `https://family-luong-sync-worker.<your-subdomain>.workers.dev`
   - **Admin Secret:** Mật khẩu bạn đã đặt ở biến `ADMIN_SECRET`.
4. Nhấn **Xác nhận**: Hệ thống sẽ kiểm tra kết nối với Worker và kích hoạt quyền Quản trị viên.

---

## 3. DANH SÁCH ENDPOINTS CỦA WORKER

| Method | Endpoint | Yêu cầu Auth | Mô tả |
| :--- | :--- | :---: | :--- |
| `GET` | `/api` | Không | Kiểm tra trạng thái hoạt động của Worker |
| `POST` | `/api/verify` | Có (Bearer Token) | Kiểm tra tính hợp lệ của ADMIN_SECRET |
| `GET` | `/api/status` | Không | Lấy thông tin commit mới nhất và trạng thái GitHub Pages |
| `POST` | `/api/upload-photo` | Có (Bearer Token) | Tải ảnh đơn lẻ và tạo Git Blob |
| `POST` | `/api/sync` | Có (Bearer Token) | **Master Atomic Sync**: Commit nguyên khối ảnh và `data.json` trong 1 commit duy nhất qua Git Data API |

---

## 4. QUY TRÌNH ROLLBACK KHI CẦN THIẾT

Nếu xảy ra sự cố thao tác nhầm trên giao diện:
1. Bản sao lưu ban đầu luôn được lưu tại tệp `data.backup.json` trên repository.
2. Quản trị viên có thể:
   - Nhấn chức năng **Nhập file** trên website và chọn `data.backup.json` để khôi phục ngay lập tức.
   - Hoặc vào GitHub: **Commit history** $\rightarrow$ Nhấn **Revert** commit mong muốn trên nhánh `main`.
