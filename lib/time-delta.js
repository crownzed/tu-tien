/**
 * lib/time-delta.js
 * Time-Delta Compensation (thuật toán #2).
 *
 * Bug đã sửa so với bản cũ: bản cũ luôn set last_update = now ngay cả khi
 * chưa tích đủ 1 phút (regenAmount = 0). Auto-poll mỗi 10s reset mốc thời gian
 * liên tục => phần lẻ < 1 phút bị vứt đi => Linh Khí gần như không hồi.
 *
 * Cách sửa: chỉ "tiêu thụ" đúng phần thời gian đã quy đổi thành điểm hồi.
 * Phần lẻ (remainder) được giữ lại bằng cách advance last_update theo số
 * nguyên phút đã dùng, KHÔNG nhảy thẳng tới now.
 */

/**
 * @param {object} params
 * @param {number} params.current      - Linh Khí hiện tại
 * @param {number} params.max          - Linh Khí tối đa
 * @param {number} params.lastUpdateMs - timestamp lần cập nhật cuối (ms)
 * @param {number} params.nowMs        - timestamp hiện tại (ms)
 * @param {number} params.regenRate    - điểm/phút
 * @param {number} params.multiplier   - 1 bình thường, 2 khi Tịnh Khí
 * @returns {{ newValue:number, regenAmount:number, newLastUpdateMs:number, minutesConsumed:number }}
 */
function computeLinhKhiRegen({ current, max, lastUpdateMs, nowMs, regenRate = 1, multiplier = 1 }) {
  if (nowMs < lastUpdateMs) {
    // Clock đi lùi (chỉnh giờ hệ thống) -> không hồi, đồng bộ lại mốc.
    return { newValue: current, regenAmount: 0, newLastUpdateMs: nowMs, minutesConsumed: 0 };
  }

  if (current >= max) {
    // Đã đầy: đồng bộ mốc để không tích lũy "nợ" thời gian.
    return { newValue: max, regenAmount: 0, newLastUpdateMs: nowMs, minutesConsumed: 0 };
  }

  const elapsedMinutes = (nowMs - lastUpdateMs) / 60000;
  const perMinute = regenRate * multiplier;
  const potentialRegen = Math.floor(elapsedMinutes * perMinute);

  if (potentialRegen <= 0) {
    // Chưa đủ tích 1 điểm: GIỮ NGUYÊN last_update để phần lẻ không bị mất.
    return { newValue: current, regenAmount: 0, newLastUpdateMs: lastUpdateMs, minutesConsumed: 0 };
  }

  const room = max - current;
  const regenAmount = Math.min(potentialRegen, room);
  const newValue = current + regenAmount;

  // Số phút thực sự "tiêu thụ" để tạo ra regenAmount điểm.
  const minutesConsumed = regenAmount / perMinute;
  // Advance mốc đúng phần đã dùng, giữ lại remainder.
  const newLastUpdateMs = lastUpdateMs + Math.round(minutesConsumed * 60000);

  // Nếu đã đầy sau khi hồi, đồng bộ mốc về now (tránh nợ thời gian khi tiêu Linh Khí sau này).
  const finalLastUpdate = newValue >= max ? nowMs : newLastUpdateMs;

  return {
    newValue,
    regenAmount,
    newLastUpdateMs: finalLastUpdate,
    minutesConsumed
  };
}

module.exports = { computeLinhKhiRegen };
