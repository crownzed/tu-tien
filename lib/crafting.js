/**
 * lib/crafting.js
 * Crafting Engine — Luyện Đan/Khí/Phù/Trận.
 * Data-driven từ data/recipes.json. Test được bằng node.
 */

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
 * @returns {{ ok:boolean, error?:string, success?:boolean, item?:string }}
 */
function craftItem(recipe, run, luck = 0, rng = Math.random) {
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
    result.message = `Chế tạo thành công: ${recipe.name}! Nhận ${result.quantity}x ${result.item}.`;
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

module.exports = { getAvailableRecipes, craftItem };
