/**
 * lib/items.js
 * Item Effect System — sử dụng vật phẩm, equip/unequip, tính combat bonuses.
 * Data-driven từ data/items.json. Test được bằng node.
 *
 * Hỗ trợ 20+ loại hiệu ứng vật phẩm tiêu hao và 8+ loại chỉ số trang bị.
 */

/**
 * Lấy item definition từ dictionary.
 */
function getItemDef(itemDefs, itemId) {
  const def = itemDefs[itemId];
  if (!def) return null;
  return { id: itemId, ...def };
}

/**
 * Sử dụng consumable item. Trả về effect đã áp dụng.
 * @param {object} itemDef - từ data/items.json (đã merge id)
 * @param {object} run - run row (modified in place)
 * @param {object} [context] - combat context nếu dùng trong combat
 * @returns {{ ok:boolean, error?:string, effect?:object, message?:string }}
 */
function useItem(itemDef, run, context = null) {
  if (!itemDef) return { ok: false, error: 'Vật phẩm không tồn tại.' };
  if (itemDef.type !== 'consumable') return { ok: false, error: `"${itemDef.name}" không phải vật phẩm tiêu hao.` };

  const eff = itemDef.effect;
  if (!eff) return { ok: false, error: 'Vật phẩm không có hiệu ứng.' };

  const result = { ok: true, effect: {}, message: '' };
  const parts = [];

  // ── Hồi phục ──
  if (eff.healPct) {
    const healed = Math.floor(run.hp_max * eff.healPct);
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
    const healed = Math.floor(run.linh_khi_max * eff.lkHealPct);
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
    run.linh_khi_max += eff.linhKhiMaxUp;
    run.linh_khi += eff.linhKhiMaxUp;
    result.effect.linhKhiUp = eff.linhKhiMaxUp;
    parts.push(`Chân Nguyên vĩnh viễn +${eff.linhKhiMaxUp}`);
  }

  if (eff.hpMaxUp) {
    run.hp_max += eff.hpMaxUp;
    run.hp += eff.hpMaxUp;
    result.effect.hpUp = eff.hpMaxUp;
    parts.push(`Khí Huyết vĩnh viễn +${eff.hpMaxUp}`);
  }

  if (eff.tuoiThoUp) {
    run.tuoi_tho_max += eff.tuoiThoUp;
    run.tuoi_tho = Math.min(run.tuoi_tho + eff.tuoiThoUp, run.tuoi_tho_max);
    result.effect.tuoiThoUp = eff.tuoiThoUp;
    parts.push(`Thọ Nguyên +${eff.tuoiThoUp}`);
  }

  // ── Tu Vi ──
  if (eff.tuViUp) {
    run.tu_vi += eff.tuViUp;
    result.effect.tuViUp = eff.tuViUp;
    parts.push(`Tu Vi +${eff.tuViUp}`);
  }

  // ── Luck ──
  if (eff.luckUp) {
    run.luck += eff.luckUp;
    result.effect.luckUp = eff.luckUp;
    parts.push(`Cơ Duyên +${eff.luckUp}`);
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
  if (!metadataJson) return { weapon: null, armor: null, accessory: null };
  try {
    const meta = JSON.parse(metadataJson);
    return meta.equipment || { weapon: null, armor: null, accessory: null };
  } catch { return { weapon: null, armor: null, accessory: null }; }
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

  for (const slot of ['weapon', 'armor', 'accessory']) {
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
