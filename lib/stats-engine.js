/**
 * lib/stats-engine.js
 * Core Stats Engine — Tất cả công thức đầu ra (Output Algorithms).
 * Chuyển đổi chỉ số thô (Raw Stats) → chỉ số thực tế trong Gameplay.
 *
 * Dựa trên tài liệu thiết kế: Exponential Scaling Model.
 * Test được bằng node (không phụ thuộc Electron/DOM).
 */

const balance = require('../config/balance');

// ─────────────────────────────────────────────────────
// 1. REALM MULTIPLIER (β_Realm)
// β_Realm = 1 + 0.5 * (2^(RT-1) - 1)
// RT=1 → 1.0, RT=2 → 1.5, RT=3 → 2.5, RT=4 → 4.5, RT=5 → 8.5
// ─────────────────────────────────────────────────────

function calcRealmMultiplier(realmTier) {
  const cfg = balance.realmScaling;
  if (realmTier <= 0) return cfg.base_multiplier;
  return cfg.base_multiplier + cfg.growth_factor * (Math.pow(cfg.exponent_base, realmTier - 1) - 1);
}

// ─────────────────────────────────────────────────────
// 1b. REWARD SCALE (tuyến tính theo cảnh giới)
// rewardScale = 1 + per_realm * (RT - 1)
// Dùng cho giá trị TUYỆT ĐỐI (tuViUp/spiritStones...). Tuyến tính để không vỡ ở RT cao.
// ─────────────────────────────────────────────────────

function calcRewardScale(realmTier) {
  const per = balance.rewardScaling?.per_realm || 0;
  const rt = Math.max(1, realmTier || 1);
  return 1 + per * (rt - 1);
}

// ─────────────────────────────────────────────────────
// 2. SPIRIT ROOT MULTIPLIER (RootM)
// ─────────────────────────────────────────────────────

/**
 * Lấy hệ số Linh Căn từ linhCan definition.
 * @param {object|null} linhCanDef - definition từ data
 * @returns {number} RootM multiplier
 */
function getSpiritRootMultiplier(linhCanDef) {
  if (!linhCanDef) return balance.spiritRoot.chan; // default: Chân Linh Căn

  // Thử match theo id hoặc rarity
  const id = (linhCanDef.id || '').toLowerCase();
  const rarity = (linhCanDef.rarity || '').toLowerCase();

  if (id.includes('thien') || rarity === 'mythic')    return balance.spiritRoot.thien;
  if (id.includes('bien_di') || rarity === 'legendary') return balance.spiritRoot.bien_di;
  if (id.includes('chan') || rarity === 'epic')         return balance.spiritRoot.chan;
  if (id.includes('nguy') || rarity === 'rare')         return balance.spiritRoot.nguy;
  if (id.includes('tap') || rarity === 'common')        return balance.spiritRoot.tap;

  // Fallback: dùng cultivationSpeed modifier nếu có
  const cultSpeed = linhCanDef.modifiers?.cultivationSpeed || 1.0;
  return cultSpeed;
}

// ─────────────────────────────────────────────────────
// 3. MAX HP
// HP_Max = (Base_HP + CON * α_HP) * β_Realm * (1 + %Gear_HP) + FlatGear_HP
// ─────────────────────────────────────────────────────

function calcMaxHP(con, baseHP, realmTier, gearHpPct = 0, gearHpFlat = 0) {
  const alpha = balance.coreAttributes.alpha_con;
  const beta = calcRealmMultiplier(realmTier);
  return Math.floor((baseHP + con * alpha) * beta * (1 + gearHpPct) + gearHpFlat);
}

// ─────────────────────────────────────────────────────
// 4. MAX MP (Linh Lực)
// MP_Max = (Base_MP + SPR * α_MP) * Dantian_Cap * (1 + ln(RootM + 1)) * β_Realm
// ─────────────────────────────────────────────────────

function calcMaxMP(spr, baseMP, dantianCap, rootM, realmTier, gearMpPct = 0, gearMpFlat = 0) {
  const alpha = balance.coreAttributes.alpha_spr;
  const beta = calcRealmMultiplier(realmTier);
  const lnFactor = 1 + Math.log(rootM + 1);
  return Math.floor((baseMP + spr * alpha) * dantianCap * lnFactor * beta * (1 + gearMpPct) + gearMpFlat);
}

// ─────────────────────────────────────────────────────
// 5. RAW ATK (Physical)
// ATK_Raw = (Weapon_ATK + STR * α_STR) * (1 + Buff_ATK%)
// ─────────────────────────────────────────────────────

function calcRawATK(weaponATK, str, buffAtkPct = 0) {
  const alpha = balance.coreAttributes.alpha_str;
  return (weaponATK + str * alpha) * (1 + buffAtkPct);
}

// ─────────────────────────────────────────────────────
// 6. RAW MAGIC ATK
// MATK_Raw = (Weapon_ATK + INT * α_INT) * (1 + Buff_ATK%)
// ─────────────────────────────────────────────────────

function calcRawMATK(weaponATK, int, buffAtkPct = 0) {
  const alpha = balance.coreAttributes.alpha_int;
  return (weaponATK + int * alpha) * (1 + buffAtkPct);
}

// ─────────────────────────────────────────────────────
// 7. ACTUAL DEFENSE (sau Xuyên Giáp)
// DEF_Actual = max(0, (DEF_Target * (1 - PEN_%)) - PEN_Flat)
// ─────────────────────────────────────────────────────

function calcActualDEF(defTarget, penPct = 0, penFlat = 0) {
  return Math.max(0, (defTarget * (1 - penPct)) - penFlat);
}

// ─────────────────────────────────────────────────────
// 8. REALM SUPPRESSION (Ω_Suppress)
// Ω = max(0.1, 1 - (R_Target - R_Attacker) * 0.4)
// Nếu attacker >= defender: Ω = 1.0 (không bị áp chế)
// ─────────────────────────────────────────────────────

function calcRealmSuppress(attackerTier, defenderTier) {
  const cfg = balance.combatV2;
  if (attackerTier >= defenderTier) return 1.0;
  return Math.max(cfg.suppress_floor, 1 - (defenderTier - attackerTier) * cfg.suppress_per_tier);
}

// ─────────────────────────────────────────────────────
// 9. FINAL DAMAGE
// Damage_Final = (ATK² / (ATK + DEF)) * Crit_M * Ω_Suppress
// ─────────────────────────────────────────────────────

function calcFinalDamage(atkRaw, defActual, critMultiplier = 1.0, realmSuppress = 1.0) {
  if (atkRaw <= 0) return 0;
  const mitigated = (atkRaw * atkRaw) / (atkRaw + defActual);
  return Math.max(1, Math.round(mitigated * critMultiplier * realmSuppress));
}

// ─────────────────────────────────────────────────────
// 9b. ELEMENTAL RESISTANCE (§2.3)
// elemMitigation = 1 - ElemRES / (ElemRES + Lvl * elem_res_level_factor)
// Lvl = realmTier * 10. Giảm phần damage đã nhân hệ số nguyên tố.
// ─────────────────────────────────────────────────────

function calcElemMitigation(elemRes, realmTier) {
  const factor = balance.combatV2.elem_res_level_factor;
  const level = realmTier * 10;
  return 1 - elemRes / (elemRes + level * factor);
}

function applyElemResistance(damage, elemRes, realmTier) {
  if (elemRes == null || elemRes <= 0) return damage;
  return Math.max(1, Math.round(damage * calcElemMitigation(elemRes, realmTier)));
}

// ─────────────────────────────────────────────────────
// 10. CRIT RATE & CRIT ROLL
// CritRate = LUK * alpha_luk (capped at 0.8)
// ─────────────────────────────────────────────────────

function calcCritRate(luk) {
  return Math.min(0.8, luk * balance.coreAttributes.alpha_luk);
}

function rollCrit(luk, rng = Math.random) {
  const rate = calcCritRate(luk);
  const isCrit = rng() < rate;
  return {
    isCrit,
    multiplier: isCrit ? balance.combatV2.base_crit_multiplier : 1.0
  };
}

// ─────────────────────────────────────────────────────
// 11. DODGE CHANCE
// DodgeChance = AGI / (AGI + dodge_constant)
// ─────────────────────────────────────────────────────

function calcDodgeChance(agi) {
  const k = balance.coreAttributes.dodge_constant;
  return agi / (agi + k);
}

function rollDodge(agi, rng = Math.random) {
  return rng() < calcDodgeChance(agi);
}

// ─────────────────────────────────────────────────────
// 11b. GLANCING BLOW (§2.2) — đòn sượt qua
// ProbHit = max(hit_floor, min(1, 1 - (AGI_def - AGI_atk)/(AGI_def + glance_constant)))
// roll > ProbHit → đòn sượt: damage * glance_damage_mult, triệt tiêu choáng/đẩy
// ─────────────────────────────────────────────────────

function calcHitProbability(agiAttacker, agiTarget) {
  const cfg = balance.combatV2;
  const raw = 1 - (agiTarget - agiAttacker) / (agiTarget + cfg.glance_constant);
  return Math.max(cfg.glance_hit_floor, Math.min(1, raw));
}

/**
 * Roll xem đòn đánh trúng đầy đủ hay chỉ sượt qua.
 * @returns {{ glancing:boolean, multiplier:number }}
 */
function rollGlance(agiAttacker, agiTarget, rng = Math.random) {
  const probHit = calcHitProbability(agiAttacker, agiTarget);
  const glancing = rng() > probHit;
  return { glancing, multiplier: glancing ? balance.combatV2.glance_damage_mult : 1.0 };
}

// ─────────────────────────────────────────────────────
// 12. EXP REQUIREMENT (Exponential)
// EXP_Req = base_exp * e^(λ * RT) * SubLevel^κ
// ─────────────────────────────────────────────────────

function calcExpRequired(realmTier, subLevel = 1) {
  const cfg = balance.expCurve;
  const sl = Math.max(1, subLevel);
  return Math.floor(cfg.base_exp * Math.exp(cfg.lambda * realmTier) * Math.pow(sl, cfg.kappa));
}

// ─────────────────────────────────────────────────────
// 12b. TRIBULATION LIGHTNING (§5) — sát thương sét theo %HP
// DmgLightning = HPMax * trib_hp_pct * (1 + ωWrath) * (1 - mitigation)
// ωWrath = max(0, wrath_base - LUK * wrath_luk_factor) — Cơ Duyên kém → thiên đạo phẫn nộ hơn
// ─────────────────────────────────────────────────────

function calcWrath(luk) {
  const cfg = balance.combatV2;
  return Math.max(0, cfg.wrath_base - luk * cfg.wrath_luk_factor);
}

function calcTribulationDamage(hpMax, luk, mitigation = 0) {
  const cfg = balance.combatV2;
  const wrath = calcWrath(luk);
  const mit = Math.max(0, Math.min(0.9, mitigation));
  return Math.max(1, Math.round(hpMax * cfg.trib_hp_pct * (1 + wrath) * (1 - mit)));
}

// ─────────────────────────────────────────────────────
// 13. MEDITATION TU VI GAIN (với RootM và INT)
// TuVi/min = (baseTuViPerMin + INT * 0.1) * RootM * β_Realm
// ─────────────────────────────────────────────────────

function calcTuViPerMinute(int, rootM, realmTier) {
  const baseTuVi = 0.5 + realmTier * 0.3;
  const beta = calcRealmMultiplier(realmTier);
  return (baseTuVi + int * 0.1) * rootM * beta;
}

// ─────────────────────────────────────────────────────
// 14. ROLL INITIAL ATTRIBUTES (khi tạo kiếp mới)
// Mỗi thuộc tính = base + random_bonus * linhCan_modifier
// ─────────────────────────────────────────────────────

function rollInitialAttributes(linhCanDef, giaCanhDef, rng = Math.random) {
  const cfg = balance.coreAttributes;
  const rootM = getSpiritRootMultiplier(linhCanDef);

  // Higher rootM → higher stat rolls
  const rollStat = (base) => {
    const bonus = Math.floor(rng() * 10 * rootM);
    return base + bonus;
  };

  // Gia cảnh modifiers (nếu có)
  const gcBonus = giaCanhDef?.statBonuses || {};

  return {
    str: rollStat(cfg.base_str) + (gcBonus.str || 0),
    con: rollStat(cfg.base_con) + (gcBonus.con || 0),
    agi: rollStat(cfg.base_agi) + (gcBonus.agi || 0),
    int: rollStat(cfg.base_int) + (gcBonus.int || 0),
    spr: rollStat(cfg.base_spr) + (gcBonus.spr || 0),
    luk: rollStat(cfg.base_luk) + (gcBonus.luk || 0),
    free_points: 0
  };
}

// ─────────────────────────────────────────────────────
// 15. COMBAT SNAPSHOT (tổng hợp toàn bộ chỉ số chiến đấu)
// ─────────────────────────────────────────────────────

/**
 * Tính toàn bộ chỉ số chiến đấu thực tế từ thuộc tính gốc.
 * @param {object} attrs - { str, con, agi, int, spr, luk }
 * @param {number} realmTier
 * @param {number} rootM
 * @param {object} gearStats - { attackBonus, hpBonus, defenseBonus, ... }
 * @returns {object} computed combat stats
 */
function computeCombatStats(attrs, realmTier, rootM, gearStats = {}) {
  const beta = calcRealmMultiplier(realmTier);
  const baseHP = balance.base.hpMax;
  const baseMP = balance.base.linhKhiMax;
  const dantianCap = balance.combatV2.dantian_base_cap;

  const weaponATK = gearStats.attackBonus || 0;
  const defBonus = gearStats.defenseBonus || 0;

  return {
    maxHP: calcMaxHP(attrs.con, baseHP, realmTier, 0, gearStats.hpBonus || 0),
    maxMP: calcMaxMP(attrs.spr, baseMP, dantianCap, rootM, realmTier),
    physATK: Math.round(calcRawATK(weaponATK, attrs.str)),
    magATK: Math.round(calcRawMATK(weaponATK, attrs.int)),
    defense: Math.round(defBonus + attrs.con * 0.5 * beta),
    dodgeChance: calcDodgeChance(attrs.agi),
    critRate: calcCritRate(attrs.luk),
    critMultiplier: balance.combatV2.base_crit_multiplier,
    moveSpeed: 1.0 + attrs.agi * 0.005,
    realmMultiplier: beta
  };
}

module.exports = {
  calcRealmMultiplier,
  calcRewardScale,
  getSpiritRootMultiplier,
  calcMaxHP,
  calcMaxMP,
  calcRawATK,
  calcRawMATK,
  calcActualDEF,
  calcRealmSuppress,
  calcFinalDamage,
  calcCritRate,
  rollCrit,
  calcDodgeChance,
  rollDodge,
  calcHitProbability,
  rollGlance,
  calcElemMitigation,
  applyElemResistance,
  calcExpRequired,
  calcWrath,
  calcTribulationDamage,
  calcTuViPerMinute,
  rollInitialAttributes,
  computeCombatStats
};
