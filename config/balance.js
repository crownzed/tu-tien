/**
 * config/balance.js
 * Single source of truth cho mọi hằng số cân bằng game.
 * Tách khỏi logic để dễ tweak mà không động vào engine.
 */

module.exports = {
  // --- Base stats (kiếp mới, trước khi cộng tiên thiên) ---
  base: {
    hp: 100,
    hpMax: 100,
    linhKhi: 100,
    linhKhiMax: 100,
    tuVi: 0,
    tuoiTho: 16,        // sinh ra ở tuổi 16
    tuoiThoMax: 120,    // giới hạn thọ nguyên ban đầu
    luck: 0
  },

  // --- Linh Khí regen (Time-Delta) ---
  linhKhi: {
    regenRatePerMinute: 1,    // 1 điểm/phút (passive)
    meditationMultiplier: 2   // x2 khi Tịnh Khí
  },

  // --- RNG / Pity ---
  pity: {
    linhCan: {
      baseRate: 0.01,       // 1% Thiên Linh Căn
      softPityStart: 20,
      hardPity: 50,
      increment: 0.01
    },
    giaCanh: {
      baseRate: 0.005,      // 0.5% Đích Tôn
      softPityStart: 15,
      hardPity: 40,
      increment: 0.015
    }
  },

  // --- Luck modifier (thuật toán #1) ---
  luck: {
    goodDivisor: 100,   // W_good = W_base * (1 + luck/100)
    badDivisor: 200     // W_bad  = W_base * (1 - luck/200)
  },

  // --- Endless scaling (thuật toán #3) ---
  scaling: {
    yearsDivisor: 100,
    yearsExponent: 1.5,
    realmFactor: 0.5
  },

  // --- Combat (thuật toán #5) ---
  combat: {
    variance: { min: 0.85, max: 1.15 },
    elementCounter: 1.5,    // khắc hệ
    elementWeak: 0.5,       // bị khắc
    elementNeutral: 1.0,
    minDamage: 1
  },

  // --- Metaprogression (thuật toán #6) ---
  meta: {
    score: { realmMultiplier: 1000, yearMultiplier: 10 },
    levelCurve: { baseExp: 100, exponent: 1.8 }
  }
};
