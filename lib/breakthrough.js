/**
 * lib/breakthrough.js
 * Breakthrough + Tribulation + Stage-Up Engine.
 * Hỗ trợ 9 tiểu tầng (tầng 1-9) trong mỗi đại cảnh giới.
 *
 * Stage-up: tăng tiểu tầng trong cùng cảnh giới (tầng 1→2→...→9)
 * Breakthrough: đột phá lên cảnh giới mới (chỉ khi đạt tầng 9)
 */

const balance = require('../config/balance');

// ── Stage-Up ──

/**
 * Tính tỉ lệ thành công khi tăng tiểu tầng.
 */
function calcStageUpChance(realm, run, linhCan, artifactCount = 0) {
  const su = realm.stageUp;
  if (!su) return { successRate: 0, canAttempt: false, reason: 'Đã đạt đỉnh phong cảnh giới này.' };

  const stage = run.realm_stage || 0;
  if (stage >= 8) return { successRate: 0, canAttempt: false, reason: 'Đã đạt tầng 9 — cần đột phá cảnh giới.' };

  if (run.tu_vi < su.tuViRequired) {
    return { successRate: 0, canAttempt: false, reason: `Cần ${su.tuViRequired} Tu Vi để tăng tầng (hiện ${run.tu_vi}).` };
  }

  const cultivationMod = linhCan?.modifiers?.cultivationSpeed || 1.0;
  let rate = su.baseSuccessRate;
  rate += run.luck * balance.breakthrough.luckBonusRate;
  rate += artifactCount * balance.breakthrough.artifactSuccessBonus * 0.5;
  rate *= cultivationMod;

  return { successRate: Math.min(0.95, rate), canAttempt: true, nextStage: stage + 1 };
}

/**
 * Thực hiện tăng tiểu tầng.
 */
function attemptStageUp(realm, run, linhCan, artifactCount = 0, rng = Math.random) {
  const { successRate, canAttempt, reason, nextStage } = calcStageUpChance(realm, run, linhCan, artifactCount);
  if (!canAttempt) return { success: false, canAttempt: false, reason };

  const success = rng() < successRate;
  const su = realm.stageUp;
  const result = { success, canAttempt: true, cost: { tuVi: su.tuViRequired }, successRate, nextStage };

  if (!success) {
    result.damage = { hp: su.hpLossOnFail || 5 };
    result.message = `Tăng tầng thất bại! Mất ${result.damage.hp} HP.`;
    return result;
  }

  // Áp dụng stage bonus
  const sb = realm.stageBonuses || { hpPerStage: 0, lkPerStage: 0 };
  const newStage = (run.realm_stage || 0) + 1;

  result.hpBonus = sb.hpPerStage;
  result.lkBonus = sb.lkPerStage;
  result.newStage = newStage;
  result.message = `Tăng lên ${realm.name} tầng ${newStage + 1}! HP +${sb.hpPerStage}, CN +${sb.lkPerStage}.`;

  if (newStage >= 8) {
    result.message += ' Đã đạt đỉnh phong! Có thể đột phá cảnh giới.';
  }

  return result;
}

// ── Breakthrough ──

/**
 * Tính tỉ lệ thành công đột phá (CHỈ khi đạt tầng 9).
 */
function calcBreakthroughChance(realm, run, linhCan, artifactCount = 0) {
  const bt = realm.breakthrough;
  if (!bt) return { successRate: 0, canAttempt: false, reason: 'Đã ở cảnh giới tối cao.' };

  const stage = run.realm_stage || 0;
  if (stage < 8) {
    return { successRate: 0, canAttempt: false, reason: `Cần đạt ${realm.name} tầng 9 để đột phá (hiện tầng ${stage + 1}).` };
  }

  if (run.linh_khi < bt.linhKhiRequired) {
    return { successRate: 0, canAttempt: false, reason: `Cần ${bt.linhKhiRequired} Chân Nguyên (hiện ${run.linh_khi}).` };
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
 * Thực hiện đột phá cảnh giới.
 */
function attemptBreakthrough(realm, run, linhCan, artifactCount = 0, rng = Math.random) {
  const { successRate, canAttempt, reason } = calcBreakthroughChance(realm, run, linhCan, artifactCount);
  if (!canAttempt) return { success: false, canAttempt: false, reason };

  const roll = rng();
  const success = roll < successRate;

  const lkCost = realm.breakthrough.linhKhiRequired;
  const result = { success, canAttempt: true, cost: { lk: lkCost }, successRate };

  if (!success) {
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

  result.message = `Đột phá thành công! Chạm tới cảnh giới mới.`;

  if (realm.breakthrough.hasTribulation) {
    const strikes = realm.breakthrough.tribulationStrikes || 3;
    const baseDmg = realm.breakthrough.tribulationDamage || 60;
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

// ── Tribulation ──

function processTribulationStrike(tribulationState, playerHp, artifactCount = 0, rng = Math.random) {
  if (tribulationState.strikesRemaining <= 0) {
    return { survived: true, strikeNumber: tribulationState.strikes, strikesRemaining: 0, damage: 0, playerHpAfter: playerHp };
  }

  const baseDmg = tribulationState.damagePerStrike;
  const variance = 0.8 + rng() * 0.4;
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

function getNextRealm(realmId, realms, realmById) {
  const current = realmById[realmId];
  if (!current) return null;
  return realms.find(r => r.order === current.order + 1) || null;
}

module.exports = {
  calcStageUpChance,
  attemptStageUp,
  calcBreakthroughChance,
  attemptBreakthrough,
  processTribulationStrike,
  getNextRealm
};
