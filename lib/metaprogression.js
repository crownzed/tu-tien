/**
 * lib/metaprogression.js
 * Meta-progression Engine — Luân Hồi Shop, Account Level Benefits, Run History.
 * Data-driven, test được bằng node.
 */

const balance = require('../config/balance');

/**
 * Tính level benefits cho account.
 * @param {number} level
 * @returns {{ innate_hp_bonus:number, innate_linhkhi_bonus:number, innate_luck_bonus:number }}
 */
function getLevelBenefits(level) {
  return {
    innate_hp_bonus: Math.floor(level / 3) * 10,
    innate_linhkhi_bonus: Math.floor(level / 4) * 10,
    innate_luck_bonus: Math.floor(level / 5) * 3
  };
}

/**
 * Tính tiên thiên chỉ số tổng hợp (shop purchases + level benefits).
 * @param {object} account - account row
 * @param {object} shopPurchases - { shopItemId: level } từ account metadata
 * @param {Array} shopItems - data/shop.json items
 */
function calcInnateBonuses(account, shopPurchases, shopItems) {
  const bonuses = {
    innate_hp_bonus: account.innate_hp_bonus || 0,
    innate_hp_pct_bonus: account.innate_hp_pct_bonus || 0,
    innate_linhkhi_bonus: account.innate_linhkhi_bonus || 0,
    innate_linhkhi_pct_bonus: account.innate_linhkhi_pct_bonus || 0,
    innate_luck_bonus: account.innate_luck_bonus || 0,
    cultivation_speed_bonus: 0,
    cancco_reduction: account.cancco_reduction || 0,
    start_spirit_stones: 0,
    start_items: []
  };

  // Level benefits (additive on top of account columns)
  const lvBenefits = getLevelBenefits(account.level);
  bonuses.innate_hp_bonus += lvBenefits.innate_hp_bonus;
  bonuses.innate_linhkhi_bonus += lvBenefits.innate_linhkhi_bonus;
  bonuses.innate_luck_bonus += lvBenefits.innate_luck_bonus;

  // Shop start items/spirit stones/percent bonuses (these aren't stored in account columns)
  if (shopPurchases && shopItems) {
    for (const [itemId, purchasedLevel] of Object.entries(shopPurchases)) {
      const item = shopItems.find(i => i.id === itemId);
      if (!item || !item.effect) continue;

      const mult = purchasedLevel || 1;
      if (item.effect.cultivation_speed_bonus) bonuses.cultivation_speed_bonus += item.effect.cultivation_speed_bonus * mult;
      if (item.effect.innate_hp_pct_bonus) bonuses.innate_hp_pct_bonus += item.effect.innate_hp_pct_bonus * mult;
      if (item.effect.innate_linhkhi_pct_bonus) bonuses.innate_linhkhi_pct_bonus += item.effect.innate_linhkhi_pct_bonus * mult;
      if (item.effect.start_spirit_stones) bonuses.start_spirit_stones += item.effect.start_spirit_stones * mult;
      if (item.effect.start_item) bonuses.start_items.push(item.effect.start_item);
    }
  }

  return bonuses;
}

/**
 * Kiểm tra có thể mua shop item không.
 * @returns {{ ok:boolean, error?:string, cost?:number }}
 */
function canBuyShopItem(item, purchasedLevel, luanHoiPoints, shopPurchases) {
  if (!item) return { ok: false, error: 'Item không tồn tại.' };

  const currentLevel = purchasedLevel || 0;
  if (item.maxLevel && currentLevel >= item.maxLevel) {
    return { ok: false, error: `Đã đạt cấp tối đa (${item.maxLevel}).` };
  }

  // Check prerequisites
  if (item.requires) {
    for (const [reqId, reqLevel] of Object.entries(item.requires)) {
      const reqPurchased = shopPurchases[reqId] || 0;
      if (reqPurchased < reqLevel) {
        return { ok: false, error: `Yêu cầu mua trước: ${reqId} cấp ${reqLevel}.` };
      }
    }
  }

  // Cost scaling: mỗi level tăng 20% giá
  const scaledCost = Math.floor(item.cost * (1 + currentLevel * 0.2));
  if (luanHoiPoints < scaledCost) {
    return { ok: false, error: `Cần ${scaledCost} Điểm Luân Hồi (hiện ${luanHoiPoints}).` };
  }

  return { ok: true, cost: scaledCost };
}

/**
 * Thực hiện mua shop item.
 * @returns {{ ok:boolean, error?:string, newLevel:number, cost:number }}
 */
function buyShopItem(item, purchasedLevel, luanHoiPoints, shopPurchases) {
  const check = canBuyShopItem(item, purchasedLevel, luanHoiPoints, shopPurchases);
  if (!check.ok) return check;

  const newLevel = (purchasedLevel || 0) + 1;
  return { ok: true, newLevel, cost: check.cost };
}

/**
 * Lọc danh sách shop item khả dụng.
 */
function getAvailableShopItems(shopItems, shopPurchases, luanHoiPoints) {
  return shopItems.map(item => {
    const currentLevel = shopPurchases[item.id] || 0;
    const check = canBuyShopItem(item, currentLevel, luanHoiPoints, shopPurchases);
    return {
      ...item,
      currentLevel,
      canBuy: check.ok,
      cost: check.cost || item.cost,
      reason: check.error || null,
      maxed: item.maxLevel && currentLevel >= item.maxLevel
    };
  });
}

/**
 * Tính reward multiplier cho endless scaling.
 */
function getEndlessMultiplier(run, account) {
  const baseMult = 1;
  const lifetimeBonus = Math.log10(account.total_lifetimes + 1) * 0.5;
  const levelBonus = account.level * 0.02;
  return baseMult + lifetimeBonus + levelBonus;
}

module.exports = {
  getLevelBenefits,
  calcInnateBonuses,
  canBuyShopItem,
  buyShopItem,
  getAvailableShopItems,
  getEndlessMultiplier
};
