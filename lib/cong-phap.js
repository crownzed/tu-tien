/**
 * lib/cong-phap.js
 * Hệ Công Pháp — học (learn), kích hoạt passive, thi triển kỹ năng, tiến hóa, xung đột.
 * Pure logic (test bằng node). State lưu dưới meta.congPhap trong game-service.
 *
 * Ánh xạ yêu cầu: ngoTinh → INT (coreAttrs.int), theChat → CON (coreAttrs.con).
 * State shape: { learned: { [id]: { id, proficiency, evolved } }, activeId: string|null }
 */

// Hệ số khuếch đại hiệu ứng khi công pháp đã tiến hóa.
const EVOLVED_MULT = 1.5;

function createState() {
  return { learned: {}, activeId: null };
}

/** Ngưỡng tiến hóa = giá trị đầu tiên trong tien_hoa.dieu_kien (vd {thon_phe_di_hoa:1} → 1). */
function getEvolveThreshold(def) {
  const cond = def?.tien_hoa?.dieu_kien;
  if (!cond) return null;
  const vals = Object.values(cond);
  return vals.length ? vals[0] : null;
}

/** Danh sách id công pháp đã học mà xung khắc với def (kiểm 2 chiều). */
function findConflicts(def, learnedIds, congPhapById) {
  const conflicts = new Set();
  const mine = def.cong_phap_xung_dot || [];
  for (const id of learnedIds) {
    if (id === def.id) continue;
    if (mine.includes(id)) conflicts.add(id);
    const other = congPhapById[id];
    if (other && (other.cong_phap_xung_dot || []).includes(def.id)) conflicts.add(id);
  }
  return [...conflicts];
}

/**
 * Kiểm tra điều kiện học công pháp.
 * @param {object} def - định nghĩa công pháp
 * @param {object} ctx - { realmOrder, linhCanElement, attrs, learnedIds, congPhapById, bloodline }
 */
function canLearn(def, ctx) {
  if (!def) return { ok: false, error: 'Công pháp không tồn tại.' };
  const { realmOrder, linhCanElement, attrs, learnedIds, congPhapById, bloodline } = ctx;
  if (learnedIds.includes(def.id)) return { ok: false, error: 'Đã học công pháp này.' };

  const yc = def.yeu_cau || {};
  if (yc.realmMin != null && realmOrder < yc.realmMin)
    return { ok: false, error: `Cần cảnh giới bậc ${yc.realmMin} (hiện ${realmOrder}).` };
  if (yc.linhCan && linhCanElement !== yc.linhCan)
    return { ok: false, error: `Cần linh căn hệ ${yc.linhCan}.` };
  if (yc.ngoTinh != null && (attrs?.int || 0) < yc.ngoTinh)
    return { ok: false, error: `Cần Ngộ Tính (INT) ≥ ${yc.ngoTinh} (hiện ${attrs?.int || 0}).` };
  if (yc.theChat != null && (attrs?.con || 0) < yc.theChat)
    return { ok: false, error: `Cần Thể Chất (CON) ≥ ${yc.theChat} (hiện ${attrs?.con || 0}).` };
  if (yc.huyetMach && bloodline !== yc.huyetMach)
    return { ok: false, error: `Cần huyết mạch "${yc.huyetMach}".` };

  const conflicts = findConflicts(def, learnedIds, congPhapById);
  if (conflicts.length) {
    const names = conflicts.map(id => congPhapById[id]?.ten || id).join(', ');
    return { ok: false, error: `Xung khắc với công pháp đã học: ${names}.` };
  }
  return { ok: true };
}

/**
 * Modifier chiến đấu/tu luyện từ công pháp đang kích hoạt.
 * @returns {{damageMult:number, elementBonus:object, hpRegenPct:number, critImmune:boolean, lkRegenBonus:number}}
 */
function getCombatModifiers(def, learnedState) {
  const mods = { damageMult: 1, elementBonus: {}, hpRegenPct: 0, critImmune: false, lkRegenBonus: 0 };
  if (!def || !def.effect) return mods;
  const e = def.effect;
  const scale = learnedState?.evolved ? EVOLVED_MULT : 1;
  if (e.combatDamageBonus) mods.damageMult += e.combatDamageBonus * scale;
  if (e.hoaDamageBonus) mods.elementBonus.hoa = (mods.elementBonus.hoa || 0) + e.hoaDamageBonus * scale;
  if (e.hpRegenPct) mods.hpRegenPct += e.hpRegenPct * scale;
  // hpRegenBonus là hệ số trừu tượng → quy ra %HP hồi mỗi lượt (nhẹ) để dùng được trong combat.
  if (e.hpRegenBonus) mods.hpRegenPct += 0.02 * e.hpRegenBonus * scale;
  if (e.critImmune) mods.critImmune = true;
  if (e.linhKhiRegenBonus) mods.lkRegenBonus += e.linhKhiRegenBonus * scale;
  return mods;
}

/** Danh sách kỹ năng chủ động của công pháp. */
function getSkills(def) {
  return Array.isArray(def?.skills) ? def.skills : [];
}

/** Tìm 1 skill theo id trong 1 def. */
function findSkill(def, skillId) {
  return getSkills(def).find(s => s.id === skillId) || null;
}

module.exports = {
  EVOLVED_MULT,
  createState,
  getEvolveThreshold,
  findConflicts,
  canLearn,
  getCombatModifiers,
  getSkills,
  findSkill
};
