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

### Commands (hiện tại)
- `help` - Danh sách lệnh
- `status` - Full player stats
- `refresh` - Force update Linh Khí
- `inventory` - Xem túi đồ
- `clear` - Xóa terminal
- `test_damage` / `test_heal` - Test HP mechanics

## Roadmap Tiếp Theo

### Phase 1: Core Loop (chưa làm)
- [ ] Character creation (roll Linh Căn + Gia Cảnh)
- [ ] Weighted RNG engine + Pity system
- [ ] Map/Event system (linear events)
- [ ] Basic combat với công thức sát thương

### Phase 2: Progression
- [ ] Đột phá system + Thiên kiếp
- [ ] Crafting (Luyện Đan/Khí/Phù/Trận)
- [ ] Tông Môn system

### Phase 3: Metaprogression
- [ ] Death/Rebirth loop
- [ ] Account Level benefits
- [ ] Endless scaling

## Notes

- **Linh Khí regen**: Hiện tại 1 điểm/phút, auto-update mỗi 10s khi app đang mở, hoặc tính toán khoảng thời gian khi mở lại app
- **Save file**: `save.db` nằm trong thư mục project (có thể chuyển sang AppData sau)
- **DevTools**: Nhấn F12 hoặc chạy `npm run dev`
