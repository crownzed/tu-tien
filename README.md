# Hacker Tu Tiên 🔱

**Text-based Roguelite Cultivation Game** với giao diện Terminal/Cyberpunk.

## Stack

- **Electron**: Desktop app framework
- **better-sqlite3**: SQLite database cho save data
- **HTML/CSS/JS**: Terminal UI với Glassmorphism + Scanline effects

## Cấu trúc Project

```
hacker-tu-tien/
├── main.js                 # Electron Main Process (backend logic)
├── preload.js              # IPC bridge (security layer)
├── package.json
├── save.db                 # SQLite database (auto-created)
└── renderer/
    ├── index.html          # Terminal UI structure
    ├── style.css           # Glassmorphism + Cyberpunk styling
    └── renderer.js         # Frontend game logic
```

## Chạy Game

```bash
cd hacker-tu-tien
npm start
```

Hoặc development mode (mở DevTools):

```bash
npm run dev
```

## Tính năng đã Implement

### Database Schema (SQLite)
- ✅ `player_state`: HP, Linh Khí, Tu Vi, Tuổi Thọ, FSM state, Luck
- ✅ `metaprogression`: Account Level, Total EXP, Lifetimes
- ✅ `pity_counters`: Roll counters cho Linh Căn/Gia Cảnh
- ✅ `inventory`: Vật phẩm với metadata JSON

### Core Mechanics
- ✅ **Time-Delta Compensation**: Linh Khí hồi phục theo thời gian thực (1 điểm/phút), tính toán khi mở game bằng timestamp
- ✅ **FSM (Finite State Machine)**: Quản lý trạng thái (IDLE, COMBAT, CRAFTING, etc.)
- ✅ **IPC Architecture**: Main process ↔ Renderer process isolation

### UI/UX
- ✅ Terminal Cyberpunk aesthetic
- ✅ Glassmorphism container với backdrop blur
- ✅ CRT scanlines overlay
- ✅ Stats bar real-time
- ✅ Color-coded values (HP đỏ khi thấp, Linh Khí cyan, etc.)
- ✅ Command-line interface với help system

### Commands (Hiện Tại)
- `help` - Hiện danh sách lệnh khả dụng
- `start` - Khởi đầu kiếp sống mới (Roll Linh Căn, Gia Cảnh)
- `status` - Xem trạng thái chi tiết của nhân vật và tài khoản
- `map` / `enter` / `next` / `choose` - Các lệnh tương tác khám phá bản đồ
- `attack` / `cast` / `flee` / `forbidden_art` - Các lệnh chiến đấu trong Combat
- `breakthrough` / `endure` - Đột phá cảnh giới và chống đỡ Thiên Kiếp
- `craft` - Chế tạo vật phẩm (Luyện Đan, Luyện Khí, Phù, Trận)
- `sect` - Hệ thống Tông Môn (Gia nhập, Cống hiến)
- `shop` - Cửa hàng Luân Hồi (Mua buff vĩnh viễn bằng Điểm Luân Hồi)
- `inventory` / `account` / `history` / `pity` - Tra cứu thông tin
- `clear` - Xóa màn hình terminal

## Roadmap Tiếp Theo (Phase 4)

### Phase 1: Core Loop (✅ Đã Hoàn Thành)
- [x] Character creation (roll Linh Căn + Gia Cảnh)
- [x] Weighted RNG engine + Pity system
- [x] Map/Event system (linear events)
- [x] Basic combat với công thức sát thương

### Phase 2: Progression (✅ Đã Hoàn Thành)
- [x] Đột phá system + Thiên kiếp
- [x] Crafting (Luyện Đan/Khí/Phù/Trận)
- [x] Tông Môn system

### Phase 3: Metaprogression (✅ Đã Hoàn Thành)
- [x] Death/Rebirth loop
- [x] Account Level benefits
- [x] Endless scaling

### Phase 4: Expansion & Polish (Đang triển khai)
- [ ] Nâng cấp UX/UI (Command History, Auto-complete)
- [ ] Âm thanh và Hiệu ứng Visual (Typewriter, CRT, ASCII Art)
- [ ] Hệ thống Trang Bị (Equip Pháp Bảo/Khải Giáp)
- [ ] Hệ thống Linh Thú (Pets) & Thành Tựu (Achievements)

## Notes

- **Linh Khí regen**: Hiện tại 1 điểm/phút, auto-update mỗi 10s khi app đang mở, hoặc tính toán khoảng thời gian khi mở lại app
- **Save file**: `save.db` nằm trong thư mục project (có thể chuyển sang AppData sau)
- **DevTools**: Nhấn F12 hoặc chạy `npm run dev`
