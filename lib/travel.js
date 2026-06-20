/**
 * lib/travel.js
 * Travel / Random Encounter Engine — đi và gặp sự kiện ngẫu nhiên.
 * Data-driven từ data/travel.json. Test được bằng node.
 */

const balance = require('../config/balance');

/**
 * Chọn loại sự kiện ngẫu nhiên dựa trên weight + luck modifier.
 * @param {object} stepTypes - travel.json stepTypes
 * @param {number} luck
 * @param {() => number} rng
 * @returns {{ type:string, icon:string, desc:string }}
 */
function rollStepType(stepTypes, luck = 0, rng = Math.random) {
  const entries = Object.entries(stepTypes);
  // Luck modifier: tăng treasure/npc/rest/training/merchant, giảm combat/hazard
  let total = 0;
  const adjusted = entries.map(([type, cfg]) => {
    let w = cfg.weight;
    const isGood = ['treasure', 'npc', 'rest', 'training', 'merchant', 'mysterious'].includes(type);
    const isBad = ['combat', 'hazard'].includes(type);
    if (isGood) w = cfg.weight * (1 + luck / 150);
    if (isBad) w = cfg.weight * (1 - luck / 250);
    w = Math.max(1, w);
    total += w;
    return { type, icon: cfg.icon, desc: cfg.desc, weight: w };
  });
  let roll = rng() * total;
  for (const entry of adjusted) {
    roll -= entry.weight;
    if (roll <= 0) return entry;
  }
  return adjusted[adjusted.length - 1];
}

/**
 * Chọn scenario từ pool dựa trên type.
 * @param {object} scenarios - travel.json scenarios
 * @param {string} type - step type
 * @param {() => number} rng
 * @returns {object|null}
 */
function pickScenario(scenarios, type, rng = Math.random) {
  const pool = scenarios[type];
  if (!pool || pool.length === 0) return null;
  return pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))];
}

/**
 * Thực hiện 1 bước travel.
 * @returns {{ type, icon, desc, scenario }}
 */
function travelStep(stepTypes, scenarios, luck = 0, rng = Math.random) {
  const stepType = rollStepType(stepTypes, luck, rng);
  const scenario = pickScenario(scenarios, stepType.type, rng);
  return { ...stepType, scenario };
}

/**
 * Xử lý kết quả travel step (reward/damage áp dụng vào run).
 */
function resolveTravelReward(run, scenario, rng = Math.random) {
  const result = { message: scenario.text };

  if (scenario.reward) {
    const r = scenario.reward;
    if (r.spiritStones) {
      const [min, max] = r.spiritStones;
      const stones = Math.floor(min + rng() * (max - min + 1));
      run.spirit_stones += stones;
      result.reward = { spiritStones: stones };
      result.message += ` Nhận ${stones} Linh Thạch.`;
    }
    if (r.item) {
      result.reward = { ...result.reward, item: r.item };
      result.message += ` Nhận ${r.item}.`;
    }
    if (r.tuVi) {
      run.tu_vi += r.tuVi;
      result.reward = { ...result.reward, tuVi: r.tuVi };
      result.message += ` Tu Vi +${r.tuVi}.`;
    }
    if (r.fullHeal) {
      run.hp = run.hp_max;
      run.linh_khi = run.linh_khi_max;
      result.message += ' Hồi phục hoàn toàn!';
    }
    if (r.luckBoost) {
      run.luck += r.luckBoost;
      result.message += ` Luck +${r.luckBoost}!`;
    }
    if (r.attackBonus) {
      result.reward = { ...result.reward, attackBonus: r.attackBonus };
      result.message += ` Sát thương +${r.attackBonus}!`;
    }
    if (r.linhKhiBonus) {
      run.linh_khi_max += r.linhKhiBonus;
      run.linh_khi += r.linhKhiBonus;
      result.reward = { ...result.reward, linhKhiBonus: r.linhKhiBonus };
      result.message += ` Linh Khí max +${r.linhKhiBonus}!`;
    }
    if (r.linhKhiRestore) {
      run.linh_khi = Math.min(run.linh_khi_max, run.linh_khi + r.linhKhiRestore);
      result.message += ` Linh Khí +${r.linhKhiRestore}.`;
    }
    if (r.karma) {
      run.luck += 3;
      result.reward = { ...result.reward, luck: 3 };
      result.message += ' Cảm thấy may mắn hơn (Luck +3).';
    }
  }

  if (scenario.damage) {
    const d = scenario.damage;
    if (d.hpPct) {
      const hpLoss = Math.floor(run.hp_max * d.hpPct);
      run.hp = Math.max(1, run.hp - hpLoss);
      result.damage = { hp: hpLoss };
      result.message += ` Mất ${hpLoss} HP.`;
    }
    if (d.lkDrain) {
      run.linh_khi = Math.max(0, run.linh_khi - d.lkDrain);
      result.damage = { ...result.damage, lk: d.lkDrain };
      result.message += ` Mất ${d.lkDrain} Linh Khí.`;
    }
  }

  if (scenario.healPct) {
    const heal = Math.floor(run.hp_max * scenario.healPct);
    run.hp = Math.min(run.hp_max, run.hp + heal);
    run.linh_khi = Math.min(run.linh_khi_max, run.linh_khi + Math.floor(run.linh_khi_max * scenario.healPct * 0.5));
    result.message += ` Hồi ${heal} HP.`;
    if (scenario.tuViBonus) {
      run.tu_vi += scenario.tuViBonus;
      result.message += ` Tu Vi +${scenario.tuViBonus}.`;
    }
  }

  if (scenario.cost) {
    if (scenario.cost.spiritStones) run.spirit_stones = Math.max(0, run.spirit_stones - scenario.cost.spiritStones);
    if (scenario.cost.tuoiTho) run.tuoi_tho = Math.max(0, run.tuoi_tho - scenario.cost.tuoiTho);
  }

  return result;
}

module.exports = { rollStepType, pickScenario, travelStep, resolveTravelReward };
