# RNG Engine Implementation 🎲

Đã implement đầy đủ **Weighted RNG + Pity System** theo GDD.

## Thuật Toán đã Code

### 1. Weighted Random với Luck Modifier
```javascript
// Good events: W_good = W_base × (1 + Luck/100)
// Bad events:  W_bad  = W_base × (1 - Luck/200)
```

**Test Results:**
- No Luck (0): Bad 49.58%, Good 50.42%
- High Luck (50): Bad 33.20%, Good 66.80% ✅

### 2. Pity System (Progressive Guarantee)
- **Base rate**: 1% (Thiên Linh Căn), 0.5% (Đích Tôn)
- **Soft pity**: Starts at roll 20 (Linh Căn) / 15 (Gia Cảnh)
- **Hard pity**: Guaranteed at roll 50 (Linh Căn) / 40 (Gia Cảnh)

**Test Results:**
- Pity 0: 1.5% success ✅
- Pity 20: 21% (soft pity starts)
- Pity 50: 100% (hard pity) ✅

### 3. Linh Căn Roll Distribution (1000 rolls, no luck/pity)
- Thiên Linh Căn: 27 (~2.7%)
- Biến Dị Thánh Thể: 10 (~1%)
- Chân Linh Căn: 294 (~29%)
- Tạp Linh Căn: 669 (~67%) ✅

### 4. Event Roll với Luck Impact
**No Luck (0):**
- Combat (hard+normal): 496
- Treasure: 167
- Good NPCs: 102

**High Luck (50):**
- Combat (hard+normal): 388 (giảm)
- Treasure: 226 (tăng mạnh)
- Good NPCs: 151 (tăng) ✅

## Lệnh Mới trong Game

```bash
roll          # Roll Linh Căn (pity counter tracked)
reroll        # Roll Gia Cảnh (separate pity)
explore       # Roll random event (affected by luck)
pity          # Check current pity counters
```

## Ví dụ Output

```
> roll
=== LINH CĂN ROLL ===
🌟 THIÊN LINH CĂN 🌟 - Thiên tài xuất chúng! [PITY RESET]
Tu luyện tốc độ x2, đột phá Luyện Khí/Trúc Cơ 100%

> pity
=== PITY COUNTERS ===
Linh Căn rolls: 0/50 (Hard pity at 50)
Gia Cảnh rolls: 12/40 (Hard pity at 40)

> explore
=== RANDOM EVENT ===
💎 Phát hiện kho báu ẩn giấu!
```

## Database Integration

Pity counters được lưu vào SQLite:
- Auto-increment mỗi lần roll thất bại
- Auto-reset khi trúng rare item
- Persistent across app restarts

## Next Steps

Với RNG engine hoàn chỉnh, có thể tiếp tục:
1. ✅ Character creation flow (roll Linh Căn + Gia Cảnh)
2. Event chain system (dùng `rollEvent()`)
3. Combat system với damage formula
4. Crafting success/failure rolls
