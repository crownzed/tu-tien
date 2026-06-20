/**
 * lib/items.js
 * Item Effect System — sử dụng vật phẩm, equip/unequip, tính combat bonuses.
 * Data-driven từ data/items.json. Test được bằng node.
 */

/**
 * Lấy item definition.
 */
function getItemDef(itemDefs, itemId) {
  const def = itemDefs[itemId];
  if (!def) return null;
  return { id: itemId, ...def };
}

/**
 * Sử dụng consumable item. Trả về effect đã áp dụng.
 * @param {object} itemDef - từ data/items.json
 * @param {object} run - run row (modified in place)
 * @returns {{ ok:boolean, error?:string, effect?:object }}
 */
function useItem(itemDef, run) {
  if (!itemDef) return { ok: false, error: 'Vật phẩm không tồn tại.' };
  if (itemDef.type !== 'consumable') return { ok: false, error: `"${itemDef.name}" không phải vật phẩm tiêu hao.` };

  const eff = itemDef.effect;
  if (!eff) return { ok: false, error: 'Vật phẩm không có hiệu ứng.' };

  const result = { ok: true, effect: {}, message: '' };

  if (eff.healPct) {
    const healed = Math.floor(run.hp_max * eff.healPct);
    const before = run.hp;
    run.hp = Math.min(run.hp_max, run.hp + healed);
    result.effect.hpHealed = run.hp - before;
    result.message = `Dùng ${itemDef.name}: +${result.effect.hpHealed} HP.`;
  }
  if (eff.linhKhiMaxUp) {
    run.linh_khi_max += eff.linhKhiMaxUp;
    run.linh_khi += eff.linhKhiMaxUp;
    result.effect.linhKhiUp = eff.linhKhiMaxUp;
    result.message = `Dùng ${itemDef.name}: Linh Khí vĩnh viễn +${eff.linhKhiMaxUp}.`;
  }
  if (eff.tuViUp) {
    run.tu_vi += eff.tuViUp;
    result.effect.tuViUp = eff.tuViUp;
    result.message = `Dùng ${itemDef.name}: Tu Vi +${eff.tuViUp}.`;
  }
  if (eff.breakthroughBonus) {
    result.effect.breakthroughBonus = eff.breakthroughBonus;
    result.message = `Dùng ${itemDef.name}: Tỉ lệ đột phá +${(eff.breakthroughBonus * 100).toFixed(0)}% trong kiếp này.`;
  }
  if (eff.deathSave) {
    result.effect.deathSave = true;
    result.message = `Dùng ${itemDef.name}: Được bảo vệ khỏi 1 đòn chí mạng.`;
  }
  if (eff.fleeGuaranteed) {
    result.effect.fleeGuaranteed = true;
    result.message = `Dùng ${itemDef.name}: Có thể thoát combat 100% trong lần tới.`;
  }
  if (!result.message) result.message = `Đã dùng ${itemDef.name}.`;

  return result;
}

/**
 * Parse equipment từ run metadata.
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
 */
function equipItem(itemDef, slot, currentEquipment) {
  if (!itemDef) return { ok: false, error: 'Vật phẩm không tồn tại.' };
  if (itemDef.type !== 'equipment') return { ok: false, error: `"${itemDef.name}" không phải trang bị.` };
  if (itemDef.slot !== slot) return { ok: false, error: `"${itemDef.name}" không thể gán vào slot ${slot} (cần slot ${itemDef.slot}).` };

  const oldItem = currentEquipment[slot];
  currentEquipment[slot] = { id: itemDef.id, name: itemDef.name, stats: itemDef.stats };

  return { ok: true, equipped: itemDef.id, unequipped: oldItem?.id || null, message: `Đã trang bị ${itemDef.name}${oldItem ? ` (thay thế ${oldItem.name})` : ''}.` };
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
 * Tính combat bonuses từ equipment.
 */
function calcEquipmentBonuses(equipment) {
  const bonuses = { attackBonus: 0, damageReduction: 0, breakthroughBonus: 0, tribulationReduction: 0 };
  for (const slot of ['weapon', 'armor', 'accessory']) {
    const item = equipment[slot];
    if (item && item.stats) {
      if (item.stats.attackBonus) bonuses.attackBonus += item.stats.attackBonus;
      if (item.stats.damageReduction) bonuses.damageReduction += item.stats.damageReduction;
      if (item.stats.breakthroughBonus) bonuses.breakthroughBonus += item.stats.breakthroughBonus;
      if (item.stats.tribulationReduction) bonuses.tribulationReduction += item.stats.tribulationReduction;
    }
  }
  return bonuses;
}

module.exports = { getItemDef, useItem, getEquipment, equipItem, unequipSlot, calcEquipmentBonuses };
