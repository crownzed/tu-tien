/**
 * lib/travel.js
 * Travel / Random Encounter Engine — flag-aware random encounters.
 * Data-driven từ data/travel.json. Hỗ trợ flag conditions cho tính liền mạch.
 */

const balance = require('../config/balance');

/**
 * Lấy flags từ metadata (import từ event-chain để tránh circular dependency).
 */
function getTravelFlags(metadataJson) {
  if (!metadataJson) return {};
  try { return JSON.parse(metadataJson).eventFlags || {}; } catch { return {}; }
}

/**
 * Kiểm tra scenario có thỏa mãn flag conditions không.
 */
function checkTravelConditions(scenario, flags) {
  const cond = scenario.conditions;
  if (!cond) return true;
  if (cond.require_flags && Array.isArray(cond.require_flags)) {
    for (const f of cond.require_flags) {
      if (!flags[f]) return false;
    }
  }
  if (cond.exclude_flags && Array.isArray(cond.exclude_flags)) {
    for (const f of cond.exclude_flags) {
      if (flags[f]) return false;
    }
  }
  return true;
}

/**
 * Chọn loại sự kiện ngẫu nhiên dựa trên weight + luck modifier.
 */
function rollStepType(stepTypes, luck = 0, rng = Math.random) {
  const entries = Object.entries(stepTypes);
  let total = 0;
  const adjusted = entries.map(([type, cfg]) => {
    let w = cfg.weight;
    const isGood = ['treasure', 'npc', 'rest', 'training', 'merchant', 'mysterious', 'alchemy', 'forge'].includes(type);
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
 * Chọn scenario từ pool, có lọc theo flags + loại scenario vừa gặp gần đây.
 * @param {string[]} recentIds - id scenario gặp gần đây (chống lặp liên tục)
 */
function pickScenario(scenarios, type, flags = {}, rng = Math.random, recentIds = []) {
  const pool = scenarios[type];
  if (!pool || pool.length === 0) return null;

  // Lọc theo flag conditions
  let eligible = pool.filter(s => checkTravelConditions(s, flags));
  if (eligible.length === 0) {
    // Fallback: chọn từ pool gốc (bỏ qua conditions)
    return pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))];
  }
  // Loại scenario vừa gặp gần đây để tránh lặp; chỉ áp dụng khi còn lựa chọn khác.
  if (recentIds.length) {
    const fresh = eligible.filter(s => !recentIds.includes(s.id));
    if (fresh.length > 0) eligible = fresh;
  }
  return eligible[Math.min(eligible.length - 1, Math.floor(rng() * eligible.length))];
}

/**
 * Thực hiện 1 bước travel. Hỗ trợ flags + chống lặp scenario gần đây.
 */
function travelStep(stepTypes, scenarios, luck = 0, flags = {}, rng = Math.random, recentIds = []) {
  const stepType = rollStepType(stepTypes, luck, rng);
  const scenario = pickScenario(scenarios, stepType.type, flags, rng, recentIds);
  return { ...stepType, scenario };
}

/**
 * Xử lý kết quả travel step.
 */
function resolveTravelReward(run, scenario, rng = Math.random, realmScale = 1) {
  const result = { message: scenario.text };
  // Scale phần thưởng/trừng phạt TUYỆT ĐỐI theo cảnh giới. Giá trị theo %max (hpPct) tự scale nên giữ nguyên.
  const s = realmScale || 1;

  if (scenario.reward) {
    const r = scenario.reward;
    if (r.spiritStones) {
      if (Array.isArray(r.spiritStones)) {
        const [min, max] = r.spiritStones;
        const stones = Math.round((min + rng() * (max - min + 1)) * s);
        run.spirit_stones += stones;
        result.reward = { spiritStones: stones };
        result.message += ` Nhận ${stones} Linh Thạch.`;
      } else {
        const stones = Math.round(r.spiritStones * s);
        run.spirit_stones += stones;
        result.reward = { spiritStones: stones };
        result.message += ` Nhận ${stones} Linh Thạch.`;
      }
    }
    if (r.item) {
      result.reward = { ...result.reward, item: r.item };
      result.message += ` Nhận ${r.item}.`;
    }
    if (r.tuVi) {
      const tv = Math.round(r.tuVi * s);
      run.tu_vi += tv;
      result.reward = { ...result.reward, tuVi: tv };
      result.message += ` Tu Vi +${tv}.`;
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
      const lk = Math.round(r.linhKhiBonus * s);
      run.linh_khi_max += lk;
      run.linh_khi += lk;
      result.reward = { ...result.reward, linhKhiBonus: lk };
      result.message += ` Linh Khí max +${lk}!`;
    }
    if (r.linhKhiRestore) {
      const lk = Math.round(r.linhKhiRestore * s);
      run.linh_khi = Math.min(run.linh_khi_max, run.linh_khi + lk);
      result.message += ` Linh Khí +${lk}.`;
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
      const drain = Math.round(d.lkDrain * s);
      run.linh_khi = Math.max(0, run.linh_khi - drain);
      result.damage = { ...result.damage, lk: drain };
      result.message += ` Mất ${drain} Linh Khí.`;
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

module.exports = { rollStepType, pickScenario, travelStep, resolveTravelReward, getTravelFlags, checkTravelConditions };
