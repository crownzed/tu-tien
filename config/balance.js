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
    regenRatePerMinute: 3,    // 3 điểm/phút (passive) — đủ để cảm thấy tác dụng
    meditationMultiplier: 2,   // x2 khi Tịnh Khí
    attackCost: 3              // LK tiêu hao mỗi đòn đánh thường
  },

  // --- Run EXP ---
  runExp: {
    combatBase: 50,            // EXP cơ bản mỗi trận thắng
    eliteMultiplier: 2,        // x2 cho elite
    bossMultiplier: 5,         // x5 cho boss
    levelThresholds: [100, 300, 600, 1000, 2000, 4000], // mốc level-up trong kiếp
    hpBonusPerLevel: 15,       // +15 HP mỗi lần level-up trong kiếp
    lkBonusPerLevel: 10        // +10 Linh Khí max mỗi lần level-up trong kiếp
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
  },

  // --- Crafting Quality (§4 QualityScore) ---
  // QualityScore = baseQual + ((INT*intWeight + LUK*lukWeight)/divisor) * synergy
  //   synergy: độ tương hợp ngũ hành nguyên liệu (dao động synergyMin..synergyMax)
  //   Ngưỡng ánh xạ ra 4 bậc phẩm. baseQual đặt cao để phẩm chất với tới được
  //   ở chỉ số khởi điểm (INT~10, LUK~5) mà vẫn có trần Cực Phẩm cho late-game.
  crafting: {
    baseQual: 1.0,
    intWeight: 0.4,
    lukWeight: 0.6,
    divisor: 20,            // spec gốc 100 → quá phẳng; 20 cho đường cong cảm nhận được
    synergyMin: 0.5,
    synergyMax: 1.5,
    // Ngưỡng phẩm: [Hạ < trung], [Trung < thuong], [Thượng < cuc], [>= cuc = Cực]
    tiers: [
      { id: 'ha_pham',    name: 'Hạ Phẩm',    min: 0,   potencyMult: 0.8 },
      { id: 'trung_pham', name: 'Trung Phẩm', min: 1.5, potencyMult: 1.0 },
      { id: 'thuong_pham',name: 'Thượng Phẩm',min: 3.0, potencyMult: 1.25 },
      { id: 'cuc_pham',   name: 'Cực Phẩm',   min: 4.5, potencyMult: 1.6 }
    ]
  },

  // --- Map / Event Chain ---
  map: {
    nodesPerLayer: { min: 2, max: 4 },
    connectionDensity: 0.7,
    treasureDropMultiplier: 1.0,
    restHealPercent: 0.3
  },

  // --- Breakthrough / Tribulation ---
  breakthrough: {
    luckBonusRate: 0.002,       // mỗi luck +0.2% success rate
    excessLinhKhiBonus: 0.001,  // mỗi LK vượt yêu cầu +0.1% success rate
    cultivationSpeedMultiplier: 1.0, // nhân với modifier từ Linh Căn
    artifactSuccessBonus: 0.15,  // mỗi artifact +15% success rate
    artifactTribulationReduction: 0.3, // artifact giảm 30% sát thương thiên kiếp
    tauHoaRiskThreshold: 0.2,    // dưới tỉ lệ này có risk tẩu hỏa
    tauHoaDeathChance: 0.3       // 30% chết nếu tẩu hỏa nhập ma
  },

  // --- Core Attributes (6 thuộc tính gốc) ---
  coreAttributes: {
    // Trọng số alpha: quy đổi thuộc tính thô → chỉ số thực tế
    alpha_str: 2.0,    // STR → ATK_Raw: Weapon_ATK + STR * alpha_str
    alpha_con: 15,     // CON → HP: Base_HP + CON * alpha_con
    alpha_int: 2.0,    // INT → Magic DMG (tương tự STR cho phép thuật)
    alpha_spr: 10,     // SPR → MP: Base_MP + SPR * alpha_spr
    alpha_luk: 0.003,  // LUK → Crit Rate: LUK * alpha_luk

    // Dodge formula: DodgeChance = AGI / (AGI + dodge_constant)
    dodge_constant: 500,

    // Base stats khi tạo kiếp mới (trước khi roll)
    base_str: 10,
    base_con: 10,
    base_agi: 10,
    base_int: 10,
    base_spr: 10,
    base_luk: 5,

    // Điểm thuộc tính tự do mỗi khi tăng tầng (stage up)
    stat_points_per_stage: 3,
    // Điểm thuộc tính khi đột phá cảnh giới
    stat_points_per_realm: 10
  },

  // --- Realm Exponential Scaling ---
  // β_Realm = 1 + 0.5 * (2^(RT-1) - 1)
  // RT=1 → 1.0, RT=2 → 1.5, RT=3 → 2.5, RT=4 → 4.5, RT=5 → 8.5
  realmScaling: {
    base_multiplier: 1.0,
    growth_factor: 0.5,
    exponent_base: 2
  },

  // --- Reward Scaling (Phần thưởng/trừng phạt/đan dược theo cảnh giới) ---
  // Scale tuyến tính: rewardScale = 1 + per_realm * (RT - 1)
  // Dùng cho giá trị TUYỆT ĐỐI (tuViUp, spiritStones...). KHÔNG dùng cho hiệu ứng đã
  // theo %max (healPct...) vì max đã tự tăng theo realm. Tuyến tính để không vỡ ở cảnh giới cao.
  rewardScaling: {
    per_realm: 0.4   // RT=1 → 1.0, RT=5 → 2.6, RT=10 → 4.6, RT=15 → 6.6
  },

  // --- Spirit Root Multiplier (Linh Căn → RootM) ---
  spiritRoot: {
    tap:     0.5,   // Tạp Linh Căn: -50% hiệu suất
    nguy:    0.8,   // Ngụy Linh Căn: -20%
    chan:    1.0,    // Chân Linh Căn: baseline
    bien_di: 1.5,   // Biến Dị Linh Căn: +50%
    thien:   2.5    // Thiên Linh Căn: +150%, bỏ qua bình cảnh cấp thấp
  },

  // --- Exponential EXP Curve (Thuật toán đột phá) ---
  // EXP_Req = base_exp * e^(lambda * RT) * SubLevel^kappa
  expCurve: {
    base_exp: 1000,
    lambda: 0.8,     // Độ dốc hàm mũ cảnh giới
    kappa: 1.5       // Độ dốc tiểu cảnh giới (tầng 1-9)
  },

  // --- Combat V2 (Mitigation + Penetration + Realm Suppression) ---
  combatV2: {
    // Damage_Final = (ATK² / (ATK + DEF)) * Crit_M * Ω_Suppress
    // Ω_Suppress = max(0.1, 1 - (R_Target - R_Attacker) * suppress_per_tier)
    suppress_per_tier: 0.4,
    suppress_floor: 0.1,
    base_crit_multiplier: 1.5,  // Sát thương bạo kích x1.5

    // Dantian capacity (khởi điểm, nâng qua công pháp)
    dantian_base_cap: 1.0,

    // §2.2 Glancing Blow — đòn sượt qua (hai tầng: né hẳn → sượt)
    //   ProbHit = max(hit_floor, min(1, 1 - (AGI_def - AGI_atk)/(AGI_def + glance_constant)))
    //   roll > ProbHit → đòn sượt, damage * glance_damage_mult, triệt tiêu choáng/đẩy
    glance_constant: 200,
    glance_hit_floor: 0.25,
    glance_damage_mult: 0.30,

    // §2.3 Elemental resistance channel — kênh sát thương nguyên tố riêng
    //   elemMitigation = 1 - ElemRES/(ElemRES + LevelTarget * elem_res_level_factor)
    elem_res_level_factor: 10,

    // §3 Poise / Phá Thể
    //   PoiseMax = (base_poise + CON * alpha_poise) * β_Realm
    base_poise: 50,
    alpha_poise: 1.2,             // PoiseMax = base_poise + enemyDefense * alpha_poise
    poise_dmg_attack: 12,         // poise mỗi đòn thường
    poise_dmg_cast: 20,           // poise mỗi lần thi pháp (mạnh hơn)
    stagger_duration_turns: 3,    // số lượt player được bonus sau khi phá thể
    stagger_bonus_damage: 0.5,    // +50% sát thương lên enemy đang Staggered
    stagger_immunity_turns: 5,    // enemy miễn nhiễm phá thể sau khi hồi

    // §5 Tribulation theo %HP
    //   DmgLightning = HPMax * trib_hp_pct * (1 + ωWrath) * (1 - mitigation)
    //   ωWrath = max(0, wrath_base - LUK * wrath_luk_factor)
    trib_hp_pct: 0.25,
    wrath_base: 0.5,
    wrath_luk_factor: 0.002
  }
};

