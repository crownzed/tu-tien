/**
 * lib/event-chain.js
 * Event Chain System — xử lý sự kiện node-based với choices.
 * Data-driven, không phụ thuộc Electron/DOM. Test được bằng node.
 */

const balance = require('../config/balance');

/**
 * Chọn 1 event script phù hợp nodeType từ pool.
 * @param {object} eventScripts - data.eventScripts (object keyed by nodeType)
 * @param {string} nodeType - 'combat', 'elite', 'treasure', 'rest', 'npc', 'event', 'boss'
 * @param {() => number} rng
 * @returns {object|null} event script object hoặc null nếu không có
 */
function pickEventScript(eventScripts, nodeType, rng = Math.random) {
  const scripts = eventScripts[nodeType];
  if (!scripts || !Array.isArray(scripts) || scripts.length === 0) return null;
  return scripts[Math.min(scripts.length - 1, Math.floor(rng() * scripts.length))];
}

/**
 * Xử lý lựa chọn của người chơi.
 * @param {object} script - event script object
 * @param {number} choiceIndex - index lựa chọn (0-based)
 * @param {number} luck - player luck stat
 * @param {() => number} rng
 * @returns {{ ok:boolean, error?:string, result?:object }}
 */
function resolveChoice(script, choiceIndex, luck = 0, rng = Math.random) {
  if (!script.choices || !Array.isArray(script.choices)) {
    return { ok: false, error: 'Script không có choices' };
  }
  if (choiceIndex < 0 || choiceIndex >= script.choices.length) {
    return { ok: false, error: `Choice ${choiceIndex} không hợp lệ (0-${script.choices.length - 1})` };
  }

  const choice = script.choices[choiceIndex];
  const result = { text: script.text, choice: choice.text };

  if (choice.risk === 'none') {
    // Không rủi ro — luôn thành công
    result.outcome = 'success';
    result.outcomeText = choice.success.text;
    result.reward = choice.success.reward || null;
    result.cost = choice.success.cost || null;
    return { ok: true, result };
  }

  // Có rủi ro — roll dựa trên successRate + luck
  const baseRate = choice.successRate || 0.5;
  const luckBonus = luck / 200; // luck giúp tăng tỉ lệ thành công
  const effectiveRate = Math.min(0.95, baseRate + luckBonus);
  const success = rng() < effectiveRate;

  if (success) {
    result.outcome = 'success';
    result.outcomeText = choice.success.text;
    result.reward = choice.success.reward || null;
    result.cost = choice.success.cost || null;
  } else {
    result.outcome = 'failure';
    result.outcomeText = choice.failure.text;
    result.damage = choice.failure.damage || null;
    result.cost = choice.failure.cost || null;
  }

  return { ok: true, result };
}

/**
 * Xử lý node tự động (combat/elite/boss) — không cần choices.
 * @param {string} nodeType
 * @returns {{ type:string, isBoss:boolean, isElite:boolean }}
 */
function classifyCombatNode(nodeType) {
  return {
    type: 'combat',
    isBoss: nodeType === 'boss',
    isElite: nodeType === 'elite'
  };
}

/**
 * Áp dụng reward từ event vào run object (in-place).
 * @param {object} run - run row từ DB (modified in place)
 * @param {object} reward - reward object từ event result
 */
function applyReward(run, reward) {
  if (!reward) return;
  if (reward.spiritStones) run.spirit_stones += reward.spiritStones;
  if (reward.hpRestore) run.hp = Math.min(run.hp_max, run.hp + reward.hpRestore);
  if (reward.fullHpHeal) run.hp = run.hp_max;
  if (reward.linhKhiRestore) run.linh_khi = Math.min(run.linh_khi_max, run.linh_khi + reward.linhKhiRestore);
  if (reward.restHeal) {
    const healPct = balance.map.restHealPercent;
    run.hp = Math.min(run.hp_max, run.hp + Math.floor(run.hp_max * healPct));
    run.linh_khi = Math.min(run.linh_khi_max, run.linh_khi + Math.floor(run.linh_khi_max * healPct));
  }
  if (reward.restFullHeal) {
    run.hp = run.hp_max;
    run.linh_khi = run.linh_khi_max;
  }
  if (reward.tuVi) run.tu_vi += reward.tuVi;
  if (reward.item) {
    // Trả về để caller xử lý inventory
    reward._item = reward.item;
    reward._item2 = reward.item2 || null;
  }
}

/**
 * Áp dụng damage từ event failure vào run object (in-place).
 */
function applyDamage(run, damage) {
  if (!damage) return;
  if (damage.hp) run.hp = Math.max(0, run.hp - damage.hp);
}

/**
 * Áp dụng cost từ event vào run object (in-place).
 */
function applyCost(run, cost) {
  if (!cost) return;
  if (cost.spiritStones) run.spirit_stones = Math.max(0, run.spirit_stones - cost.spiritStones);
  if (cost.tuoiTho) run.tuoi_tho = Math.max(0, run.tuoi_tho - cost.tuoiTho);
}

module.exports = {
  pickEventScript,
  resolveChoice,
  classifyCombatNode,
  applyReward,
  applyDamage,
  applyCost
};
