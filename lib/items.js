/**
 * lib/items.js
 * Item Effect System — sử dụng vật phẩm, equip/unequip, tính combat bonuses.
 * Data-driven từ data/items.json. Test được bằng node.
 *
 * Hỗ trợ 20+ loại hiệu ứng vật phẩm tiêu hao và 8+ loại chỉ số trang bị.
 */

const balance = require('../config/balance');

/**
 * Tách composite id "baseId@qualityId" → { baseId, qualityId }.
 * Item không có phẩm chất: qualityId = null.
 */
function parseItemId(itemId) {
  const at = itemId.indexOf('@');
  if (at === -1) return { baseId: itemId, qualityId: null };
  return { baseId: itemId.slice(0, at), qualityId: itemId.slice(at + 1) };
}

/** Tìm tier phẩm chất theo id; null nếu không khớp. */
function getQualityTier(qualityId) {
  if (!qualityId) return null;
  return balance.crafting.tiers.find(t => t.id === qualityId) || null;
}

/**
 * Lấy item definition từ dictionary. Chấp nhận composite id (strip @quality).
 * Nếu có phẩm chất, đính kèm .quality và giữ id gốc (composite) để addressing.
 */
function getItemDef(itemDefs, itemId) {
  const { baseId, qualityId } = parseItemId(itemId);
  const def = itemDefs[baseId];
  if (!def) return null;
  const tier = getQualityTier(qualityId);
  const out = { id: itemId, baseId, ...def };
  if (tier) {
    out.quality = { id: tier.id, name: tier.name, potencyMult: tier.potencyMult };
    out.name = `${def.name} (${tier.name})`;
  }
  return out;
}

/**
 * Sử dụng consumable item. Trả về effect đã áp dụng.
 * @param {object} itemDef - từ data/items.json (đã merge id)
 * @param {object} run - run row (modified in place)
 * @param {object} [context] - combat context nếu dùng trong combat
 * @returns {{ ok:boolean, error?:string, effect?:object, message?:string }}
 */
function useItem(itemDef, run, context = null, realmScale = 1) {
  if (!itemDef) return { ok: false, error: 'Vật phẩm không tồn tại.' };
  if (itemDef.type !== 'consumable') return { ok: false, error: `"${itemDef.name}" không phải vật phẩm tiêu hao.` };

  const eff = itemDef.effect;
  if (!eff) return { ok: false, error: 'Vật phẩm không có hiệu ứng.' };

  // Phẩm chất nhân hiệu lực định lượng (potencyMult). Đan không phẩm chất: m = 1.
  const m = itemDef.quality?.potencyMult || 1;
  // mFlat: hiệu lực cho giá trị TUYỆT ĐỐI (tuViUp/hpMaxUp...) — nhân thêm rewardScale theo cảnh giới.
  // healPct/lkHealPct vẫn dùng m (đã theo %max nên không cần scale realm).
  const mFlat = m * (realmScale || 1);

  const result = { ok: true, effect: {}, message: '' };
  const parts = [];

  // ── Hồi phục ──
  if (eff.healPct) {
    const healed = Math.floor(run.hp_max * eff.healPct * m);
    const before = run.hp;
    run.hp = Math.min(run.hp_max, run.hp + healed);
    result.effect.hpHealed = run.hp - before;
    parts.push(`+${result.effect.hpHealed} Khí Huyết`);
  }

  if (eff.healOverTime) {
    result.effect.healOverTime = eff.healOverTime;
    result.effect._needsCombatTick = true;
    parts.push(`hồi ${Math.floor(eff.healOverTime.pct * 100)}% HP mỗi lượt (${eff.healOverTime.ticks} lượt)`);
  }

  if (eff.lkHealPct) {
    const healed = Math.floor(run.linh_khi_max * eff.lkHealPct * m);
    run.linh_khi = Math.min(run.linh_khi_max, run.linh_khi + healed);
    result.effect.lkHealed = healed;
    parts.push(`+${healed} Chân Nguyên`);
  }

  if (eff.fullHeal) {
    const hpGain = run.hp_max - run.hp;
    const lkGain = run.linh_khi_max - run.linh_khi;
    run.hp = run.hp_max;
    run.linh_khi = run.linh_khi_max;
    result.effect.hpHealed = hpGain;
    result.effect.lkHealed = lkGain;
    parts.push('hồi đầy Khí Huyết & Chân Nguyên');
  }

  // ── Tăng vĩnh viễn ──
  if (eff.linhKhiMaxUp) {
    const up = Math.round(eff.linhKhiMaxUp * mFlat);
    run.linh_khi_max += up;
    run.linh_khi += up;
    result.effect.linhKhiUp = up;
    parts.push(`Chân Nguyên vĩnh viễn +${up}`);
  }

  if (eff.hpMaxUp) {
    const up = Math.round(eff.hpMaxUp * mFlat);
    run.hp_max += up;
    run.hp += up;
    result.effect.hpUp = up;
    parts.push(`Khí Huyết vĩnh viễn +${up}`);
  }

  if (eff.tuoiThoUp) {
    const up = Math.round(eff.tuoiThoUp * mFlat);
    run.tuoi_tho_max += up;
    run.tuoi_tho = Math.min(run.tuoi_tho + up, run.tuoi_tho_max);
    result.effect.tuoiThoUp = up;
    parts.push(`Thọ Nguyên +${up}`);
  }

  // ── Tu Vi ──
  if (eff.tuViUp) {
    const up = Math.round(eff.tuViUp * mFlat);
    run.tu_vi += up;
    result.effect.tuViUp = up;
    parts.push(`Tu Vi +${up}`);
  }

  // ── Luck ──
  if (eff.luckUp) {
    const up = Math.round(eff.luckUp * mFlat);
    run.luck += up;
    result.effect.luckUp = up;
    parts.push(`Cơ Duyên +${up}`);
  }

  // ── Đột phá ──
  if (eff.breakthroughBonus) {
    result.effect.breakthroughBonus = eff.breakthroughBonus;
    parts.push(`tỉ lệ đột phá +${Math.round(eff.breakthroughBonus * 100)}%`);
  }

  if (eff.tribulationReduction) {
    result.effect.tribulationReduction = eff.tribulationReduction;
    parts.push(`giảm ${Math.round(eff.tribulationReduction * 100)}% sát thương thiên kiếp`);
  }

  // ── Phòng thủ ──
  if (eff.deathSave) {
    result.effect.deathSave = true;
    parts.push('bảo vệ khỏi 1 đòn chí mạng');
  }

  if (eff.damageResistPct) {
    result.effect.damageResistPct = eff.damageResistPct;
    parts.push(`giảm ${Math.round(eff.damageResistPct * 100)}% sát thương (5 lượt combat)`);
  }

  // ── Chiến đấu ──
  if (eff.fleeGuaranteed) {
    result.effect.fleeGuaranteed = true;
    parts.push('thoát combat 100%');
  }

  if (eff.nextAttackDouble) {
    result.effect.nextAttackDouble = true;
    parts.push('đòn đánh kế gây 200% sát thương');
  }

  result.message = parts.length > 0
    ? `Dùng ${itemDef.name}: ${parts.join(' | ')}.`
    : `Đã dùng ${itemDef.name}.`;

  return result;
}

/**
 * Parse equipment từ run metadata.
 * @returns {{ weapon?: object, armor?: object, accessory?: object }}
 */
function getEquipment(metadataJson) {
  if (!metadataJson) return { weapon: null, armor: null, accessory: null, manual: null };
  try {
    const meta = JSON.parse(metadataJson);
    return meta.equipment || { weapon: null, armor: null, accessory: null, manual: null };
  } catch { return { weapon: null, armor: null, accessory: null, manual: null }; }
}

/**
 * Equip item vào slot.
 * @param {object} itemDef
 * @param {string} slot
 * @param {object} currentEquipment - { weapon, armor, accessory }
 * @returns {{ ok:boolean, equipped?:string, unequipped?:string|null, message?:string, error?:string }}
 */
function equipItem(itemDef, slot, currentEquipment) {
  if (!itemDef) return { ok: false, error: 'Vật phẩm không tồn tại.' };
  if (itemDef.type !== 'equipment') return { ok: false, error: `"${itemDef.name}" không phải trang bị.` };
  if (itemDef.slot !== slot) return { ok: false, error: `"${itemDef.name}" không thể gán vào slot ${slot} (cần slot ${itemDef.slot}).` };

  const oldItem = currentEquipment[slot];
  currentEquipment[slot] = { id: itemDef.id, name: itemDef.name, icon: itemDef.icon, rarity: itemDef.rarity, stats: itemDef.stats };

  return {
    ok: true,
    equipped: itemDef.id,
    unequipped: oldItem?.id || null,
    message: `Đã trang bị ${itemDef.icon} ${itemDef.name}${oldItem ? ` (thay thế ${oldItem.name})` : ''}.`
  };
}

/**
 * Unequip slot.
 */
function unequipSlot(slot, currentEquipment) {
  const old = currentEquipment[slot];
  if (!old) return { ok: false, error: `Slot ${slot} đang trống.` };
  currentEquipment[slot] = null;
  return { ok: true, unequipped: old, message: `Đã tháo ${old.name}.` };
}

/**
 * Tính combat bonuses từ tất cả equipment slots.
 * @returns {{ attackBonus:number, damageReduction:number, hpBonus:number, linhKhiBonus:number, luckBonus:number, breakthroughBonus:number, tribulationReduction:number, critChance:number, deathSavePerCombat:boolean }}
 */
function calcEquipmentBonuses(equipment) {
  const bonuses = {
    attackBonus: 0,
    damageReduction: 0,
    hpBonus: 0,
    linhKhiBonus: 0,
    luckBonus: 0,
    breakthroughBonus: 0,
    tribulationReduction: 0,
    critChance: 0,
    deathSavePerCombat: false
  };

  for (const slot of ['weapon', 'armor', 'accessory', 'manual']) {
    const item = equipment[slot];
    if (item && item.stats) {
      const s = item.stats;
      if (s.attackBonus)           bonuses.attackBonus += s.attackBonus;
      if (s.damageReduction)       bonuses.damageReduction += s.damageReduction;
      if (s.hpBonus)               bonuses.hpBonus += s.hpBonus;
      if (s.linhKhiBonus)          bonuses.linhKhiBonus += s.linhKhiBonus;
      if (s.luckBonus)             bonuses.luckBonus += s.luckBonus;
      if (s.breakthroughBonus)     bonuses.breakthroughBonus += s.breakthroughBonus;
      if (s.tribulationReduction)  bonuses.tribulationReduction += s.tribulationReduction;
      if (s.critChance)            bonuses.critChance += s.critChance;
      if (s.deathSavePerCombat)    bonuses.deathSavePerCombat = true;
    }
  }

  return bonuses;
}

/**
 * Thêm chỉ số trang bị vào run (gọi khi bắt đầu combat hoặc khi equip).
 */
function applyEquipmentToRun(run, equipment) {
  const bonuses = calcEquipmentBonuses(equipment);
  run.hp_max += bonuses.hpBonus;
  run.hp += bonuses.hpBonus;
  run.linh_khi_max += bonuses.linhKhiBonus;
  run.linh_khi += bonuses.linhKhiBonus;
  run.luck += bonuses.luckBonus;
  return bonuses;
}

/**
 * Lấy equipment của 1 slot cụ thể.
 */
function getEquippedItem(equipment, slot) {
  return equipment[slot] || null;
}

/**
 * Kiểm tra có phải weapon 2 tay không (để chặn dual-wield sau này).
 */
function isTwoHanded(itemDef) {
  return itemDef?.stats?.twoHanded === true;
}

module.exports = {
  parseItemId,
  getQualityTier,
  getItemDef,
  useItem,
  getEquipment,
  equipItem,
  unequipSlot,
  calcEquipmentBonuses,
  applyEquipmentToRun,
  getEquippedItem,
  isTwoHanded
};
