/**
 * lib/achievements.js
 * Achievement System — kiểm tra milestone, thưởng Điểm Luân Hồi.
 * Data-driven từ data/achievements.json. Test được bằng node.
 */

/**
 * Kiểm tra achievement nào vừa đạt được.
 * @param {Array} achievements - data achievements
 * @param {object} stats - { total_lifetimes, best_realm, total_kills, best_score, account_level, boss_kills, craft_count, breakthroughs, tribulations, shop_purchases, sect_joined }
 * @param {Array<string>} unlockedIds - danh sách achievement đã mở khóa
 * @returns {Array<object>} danh sách achievement mới được mở khóa
 */
function checkAchievements(achievements, stats, unlockedIds) {
  const unlocked = new Set(unlockedIds || []);
  const newUnlocks = [];

  for (const ach of achievements) {
    if (unlocked.has(ach.id)) continue;

    const currentValue = stats[ach.check] || 0;
    if (currentValue >= ach.threshold) {
      newUnlocks.push(ach);
      unlocked.add(ach.id);
    }
  }

  return newUnlocks;
}

/**
 * Tính tổng điểm thưởng từ danh sách achievement.
 */
function sumRewards(achievements) {
  let total = 0;
  for (const ach of achievements) {
    total += ach.reward?.luanHoiPoints || 0;
  }
  return total;
}

module.exports = { checkAchievements, sumRewards };
