/**
 * lib/sect.js
 * Tông Môn System — join, contribute, rank, benefits.
 * Data-driven từ data/sects.json. Test được bằng node.
 */

/**
 * Lấy danh sách tông môn player có thể join.
 * @param {Array} sects - data sects
 * @param {object} run - run row
 * @param {object} linhCan - linh căn của player
 * @returns {Array<{sect:object, canJoin:boolean, reason?:string}>}
 */
function getAvailableSects(sects, run, linhCan) {
  return sects.map(s => {
    const req = s.requirements || {};

    if (run.tu_vi < (req.tuVi || 0)) {
      return { sect: s, canJoin: false, reason: `Cần Tu Vi ${req.tuVi}` };
    }
    if (req.realmMin) {
      // realm check — dùng realm order
    }
    if (req.element && linhCan?.element !== req.element) {
      return { sect: s, canJoin: false, reason: `Yêu cầu Linh Căn hệ ${req.element.toUpperCase()}` };
    }
    if (req.linhCanTier && !req.linhCanTier.includes(linhCan?.tier)) {
      return { sect: s, canJoin: false, reason: `Yêu cầu Linh Căn bậc ${req.linhCanTier.join(' hoặc ')}` };
    }

    return { sect: s, canJoin: true };
  });
}

/**
 * Kiểm tra player có thể join sect không.
 */
function canJoinSect(sect, run, linhCan, realmOrder) {
  const req = sect.requirements || {};

  if (run.tu_vi < (req.tuVi || 0)) {
    return { ok: false, error: `Cần Tu Vi ${req.tuVi} (hiện ${run.tu_vi}).` };
  }
  if (req.realmMin && realmOrder < req.realmMin) {
    return { ok: false, error: `Cần đạt cảnh giới tối thiểu để gia nhập.` };
  }
  if (req.element && linhCan?.element !== req.element) {
    return { ok: false, error: `Yêu cầu Linh Căn hệ ${req.element.toUpperCase()}.` };
  }
  if (req.linhCanTier && !req.linhCanTier.includes(linhCan?.tier)) {
    return { ok: false, error: `Yêu cầu Linh Căn bậc ${req.linhCanTier.join(' hoặc ')}.` };
  }

  return { ok: true };
}

/**
 * Tính rank hiện tại dựa trên contribution.
 * @returns {{ name:string, dailyStones:number, minContribution:number, nextRank?:object }}
 */
function getCurrentRank(sect, contribution) {
  const ranks = sect.contributionRanks;
  let current = ranks[0];
  for (const rank of ranks) {
    if (contribution >= rank.minContribution) {
      current = rank;
    }
  }
  const idx = ranks.indexOf(current);
  const next = idx < ranks.length - 1 ? ranks[idx + 1] : null;
  return { ...current, nextRank: next };
}

/**
 * Tính thưởng hàng ngày từ tông môn.
 */
function calculateDailyReward(sect, contribution) {
  const rank = getCurrentRank(sect, contribution);
  return { spiritStones: rank.dailyStones, rank: rank.name };
}

/**
 * Tạo sect state để lưu vào run metadata hoặc cột riêng.
 */
function createSectState(sectId) {
  return { sectId, contribution: 0, joinedAt: null };
}

module.exports = {
  getAvailableSects,
  canJoinSect,
  getCurrentRank,
  calculateDailyReward,
  createSectState
};
