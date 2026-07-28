const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = 3000;
const DATA_FILE = path.join(__dirname, 'data.json');

// Mật khẩu Admin 
const ADMIN_PASSWORD = 'giaphaholuong';

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname)); // Khai báo phục vụ các file tĩnh (HTML, CSS, JS)

// Hàm đọc dữ liệu file json
function readData() {
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ members: [], nextId: 1 }, null, 2));
  }
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

// 1. Lấy dữ liệu (Công khai - Ai cũng xem được)
app.get('/api/data', (req, res) => {
  try {
    const data = readData();
    res.json(data);
  } catch (err) {
    res.status(500).json({ message: 'Lỗi đọc file JSON' });
  }
});

// 2. API Đăng nhập
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    // Trả về token đơn giản
    res.json({ success: true, token: 'token-admin-authenticated' });
  } else {
    res.status(401).json({ success: false, message: 'Mật khẩu không đúng!' });
  }
});

// Middleware xác thực quyền Admin
function authenticate(req, res, next) {
  const token = req.headers['authorization'];
  if (token === 'Bearer token-admin-authenticated') {
    next();
  } else {
    res.status(403).json({ message: 'Bạn không có quyền thao tác! Vui lòng đăng nhập.' });
  }
}

// 3. API Lưu dữ liệu (Bắt buộc ĐĂNG NHẬP)
app.post('/api/data', authenticate, (req, res) => {
  try {
    const { members, nextId } = req.body;
    const payload = { members: members || [], nextId: nextId || 1 };
    fs.writeFileSync(DATA_FILE, JSON.stringify(payload, null, 2), 'utf8');
    res.json({ success: true, message: 'Đã lưu vào data.json' });
  } catch (err) {
    res.status(500).json({ message: 'Lỗi ghi file JSON' });
  }
});

app.listen(PORT, () => {
  console.log(`Server gia phả đang chạy tại: http://localhost:${PORT}`);
});