/**
 * lib/breakthrough.js
 * Breakthrough + Tribulation Engine (thuật toán #8).
 * Data-driven, không phụ thuộc Electron/DOM. Test được bằng node.
 */

const balance = require('../config/balance');

/**
 * Tính tỉ lệ thành công đột phá.
 * @param {object} realm - realm hiện tại (có .breakthrough)
 * @param {object} run - run row
 * @param {object} linhCan - linh căn của player
 * @param {number} artifactCount - số artifact được dùng
 * @returns {{ successRate:number, canAttempt:boolean, reason?:string }}
 */
function calcBreakthroughChance(realm, run, linhCan, artifactCount = 0) {
  const bt = realm.breakthrough;
  if (!bt) return { successRate: 0, canAttempt: false, reason: 'Đã ở cảnh giới tối cao.' };

  if (run.linh_khi < bt.linhKhiRequired) {
    return { successRate: 0, canAttempt: false, reason: `Cần ${bt.linhKhiRequired} Linh Khí (hiện ${run.linh_khi}).` };
  }
  if (run.tu_vi < bt.tuViRequired) {
    return { successRate: 0, canAttempt: false, reason: `Cần ${bt.tuViRequired} Tu Vi (hiện ${run.tu_vi}).` };
  }

  const cfg = balance.breakthrough;
  const cultivationMod = linhCan?.modifiers?.cultivationSpeed || 1.0;
  const excessLK = run.linh_khi - bt.linhKhiRequired;

  let rate = bt.baseSuccessRate;
  rate += run.luck * cfg.luckBonusRate;
  rate += excessLK * cfg.excessLinhKhiBonus;
  rate *= cultivationMod * cfg.cultivationSpeedMultiplier;
  rate += artifactCount * cfg.artifactSuccessBonus;

  return { successRate: Math.min(0.95, rate), canAttempt: true };
}

/**
 * Thực hiện đột phá. Trả về kết quả.
 * @returns {{ success:boolean, tauHoa:boolean, tribulation?:object, cost:{lk:number}, damage?:{hp:number} }}
 */
function attemptBreakthrough(realm, run, linhCan, artifactCount = 0, rng = Math.random) {
  const { successRate, canAttempt, reason } = calcBreakthroughChance(realm, run, linhCan, artifactCount);
  if (!canAttempt) return { success: false, canAttempt: false, reason };

  const roll = rng();
  const success = roll < successRate;

  // Cost: consume Linh Khí
  const lkCost = realm.breakthrough.linhKhiRequired;
  const result = { success, canAttempt: true, cost: { lk: lkCost }, successRate };

  if (!success) {
    // Check tẩu hỏa nhập ma
    const cfg = balance.breakthrough;
    const tauHoaRisk = linhCan?.modifiers?.tauHoaRisk || 1.0;
    const effectiveRisk = cfg.tauHoaRiskThreshold * tauHoaRisk;
    const tauHoa = (successRate < effectiveRisk) && (rng() < cfg.tauHoaDeathChance * tauHoaRisk);

    result.tauHoa = tauHoa;
    result.damage = {
      hp: tauHoa ? run.hp_max : realm.breakthrough.hpLossOnFail || 20,
      lkLost: realm.breakthrough.lkLossOnFail || 30
    };

    if (tauHoa) {
      result.message = 'TẨU HỎA NHẬP MA! Linh lực mất kiểm soát, kinh mạch đứt đoạn!';
    } else {
      result.message = 'Đột phá thất bại. Linh khí tán loạn, cần thời gian điều tức.';
    }
    return result;
  }

  // Thành công — có thiên kiếp không?
  result.message = `Đột phá thành công! Chạm tới cảnh giới mới.`;

  if (realm.breakthrough.hasTribulation) {
    const strikes = realm.breakthrough.tribulationStrikes || 3;
    const baseDmg = realm.breakthrough.tribulationDamage || 60;
    // Artifact giảm sát thương
    const reduction = 1 - (artifactCount * balance.breakthrough.artifactTribulationReduction);
    const effectiveDmg = Math.floor(baseDmg * Math.max(0.3, reduction));

    result.tribulation = {
      strikes,
      damagePerStrike: effectiveDmg,
      strikesRemaining: strikes,
      totalDamageTaken: 0,
      survived: false
    };
    result.message += ` Nhưng THIÊN KIẾP ập xuống! ${strikes} đạo lôi kiếp.`;
  }

  return result;
}

/**
 * Xử lý 1 đợt thiên kiếp (gọi liên tục cho đến khi hết strike hoặc chết).
 * @returns {{ survived:boolean, strikeNumber:number, strikesRemaining:number, damage:number, playerHpAfter:number }}
 */
function processTribulationStrike(tribulationState, playerHp, artifactCount = 0, rng = Math.random) {
  if (tribulationState.strikesRemaining <= 0) {
    return { survived: true, strikeNumber: tribulationState.strikes, strikesRemaining: 0, damage: 0, playerHpAfter: playerHp };
  }

  // Mỗi đạo lôi kiếp có variance
  const baseDmg = tribulationState.damagePerStrike;
  const variance = 0.8 + rng() * 0.4; // 80-120%
  const damage = Math.floor(baseDmg * variance);

  const newHp = Math.max(0, playerHp - damage);
  tribulationState.strikesRemaining--;
  tribulationState.totalDamageTaken += damage;

  if (newHp <= 0) {
    return { survived: false, strikeNumber: tribulationState.strikes - tribulationState.strikesRemaining, strikesRemaining: tribulationState.strikesRemaining, damage, playerHpAfter: 0 };
  }

  const survived = tribulationState.strikesRemaining <= 0;
  if (survived) tribulationState.survived = true;

  return {
    survived: true,
    tribulationOver: survived,
    strikeNumber: tribulationState.strikes - tribulationState.strikesRemaining,
    strikesRemaining: tribulationState.strikesRemaining,
    damage,
    playerHpAfter: newHp
  };
}

/**
 * Lấy realm tiếp theo.
 */
function getNextRealm(realmId, realms, realmById) {
  const current = realmById[realmId];
  if (!current) return null;
  return realms.find(r => r.order === current.order + 1) || null;
}

module.exports = {
  calcBreakthroughChance,
  attemptBreakthrough,
  processTribulationStrike,
  getNextRealm
};
