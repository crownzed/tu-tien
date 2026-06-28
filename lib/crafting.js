/**
 * lib/crafting.js
 * Crafting Engine — Luyện Đan/Khí/Phù/Trận.
 * Data-driven từ data/recipes.json. Test được bằng node.
 */

const balance = require('../config/balance');

/**
 * Tính QualityScore và ánh xạ ra bậc phẩm (§4).
 *   score = baseQual + ((INT*intWeight + LUK*lukWeight) / divisor) * synergy
 * @param {number} int - Ngộ Tính
 * @param {number} luk - Cơ Duyên
 * @param {number} synergy - độ tương hợp nguyên liệu (clamp synergyMin..synergyMax)
 * @param {() => number} rng
 * @returns {{ score:number, tier:object, synergy:number }}
 */
function calcQuality(int, luk, synergy, rng = Math.random) {
  const cfg = balance.crafting;
  // synergy có thể chưa truyền (recipe cũ) → roll trong [min,max]
  const syn = synergy != null
    ? Math.max(cfg.synergyMin, Math.min(cfg.synergyMax, synergy))
    : cfg.synergyMin + rng() * (cfg.synergyMax - cfg.synergyMin);

  const score = cfg.baseQual + ((int * cfg.intWeight + luk * cfg.lukWeight) / cfg.divisor) * syn;

  // Tìm tier cao nhất mà score đạt ngưỡng min
  let tier = cfg.tiers[0];
  for (const t of cfg.tiers) {
    if (score >= t.min) tier = t;
  }

  return { score: Math.round(score * 100) / 100, tier, synergy: Math.round(syn * 100) / 100 };
}

/**
 * Lọc recipes theo category và tu vi hiện có.
 * @param {Array} recipes - data recipes
 * @param {string|null} category - category filter hoặc null để lấy tất cả
 * @param {number} tuVi - tu vi hiện tại của player
 * @returns {Array} danh sách recipe khả dụng
 */
function getAvailableRecipes(recipes, category, tuVi) {
  let filtered = recipes;
  if (category) {
    filtered = recipes.filter(r => r.category === category);
  }
  return filtered.filter(r => tuVi >= (r.requires?.tuVi || 0));
}

/**
 * Thực hiện craft 1 recipe.
 * @param {object} recipe
 * @param {object} run - run row
 * @param {number} luck
 * @param {() => number} rng
 * @param {number} int - Ngộ Tính (cho QualityScore; chỉ áp cho luyen_dan)
 * @returns {{ ok:boolean, error?:string, success?:boolean, item?:string, quality?:object }}
 */
function craftItem(recipe, run, luck = 0, rng = Math.random, int = 10) {
  // Kiểm tra Tu Vi
  if (run.tu_vi < (recipe.requires?.tuVi || 0)) {
    return { ok: false, error: `Cần Tu Vi ${recipe.requires.tuVi} (hiện ${run.tu_vi}).` };
  }

  // Kiểm tra Linh Thạch
  const stoneCost = recipe.cost?.spiritStones || 0;
  if (run.spirit_stones < stoneCost) {
    return { ok: false, error: `Cần ${stoneCost} Linh Thạch (hiện ${run.spirit_stones}).` };
  }

  // Roll thành công
  const baseRate = recipe.successRate || 0.5;
  const luckBonus = luck / 300;
  const effectiveRate = Math.min(0.95, baseRate + luckBonus);
  const success = rng() < effectiveRate;

  const result = { ok: true, success, recipe: recipe.id, recipeName: recipe.name, cost: { spiritStones: stoneCost } };

  if (success) {
    result.item = recipe.result.item;
    result.quantity = recipe.result.quantity || 1;

    // Phẩm chất chỉ áp cho luyện đan (consumable). Luyện khí/phù/trận giữ nguyên.
    if (recipe.category === 'luyen_dan') {
      const q = calcQuality(int, luck, recipe.synergy, rng);
      result.quality = { id: q.tier.id, name: q.tier.name, potencyMult: q.tier.potencyMult, score: q.score };
      result.message = `Luyện thành ${q.tier.name}: ${recipe.name}! (${result.quantity}x)`;
    } else {
      result.message = `Chế tạo thành công: ${recipe.name}! Nhận ${result.quantity}x ${result.item}.`;
    }
  } else {
    result.message = `Chế tạo thất bại: ${recipe.name}.`;
    if (recipe.failLoseMaterials) {
      result.message += ' Nguyên liệu đã bị phá hủy.';
    } else {
      result.cost.spiritStones = Math.floor(stoneCost / 2); // mất nửa phí nếu giữ nguyên liệu
    }
  }

  return result;
}

module.exports = { getAvailableRecipes, craftItem, calcQuality };
