/**
 * lib/event-chain.js
 * Stateful & Branching Narrative Engine.
 *
 * Kiến trúc: Event State Machine với 5 tầng xử lý:
 *
 *   1. EVENT QUEUE  — Kiểm tra hàng đợi sự kiện bắt buộc (next_event từ turn trước)
 *   2. PHASE FILTER — Lọc sự kiện theo Giai đoạn cuộc đời (Phàm Nhân → Tiên Đế)
 *   3. CONDITIONS   — Lọc theo min/max realm, require_flags, exclude_flags
 *   4. WEIGHT ROLL  — Tính trọng số (base_weight + Luck buff cho Kỳ Ngộ)
 *   5. CHAIN FORCE  — Sau khi resolve, xếp next_event vào queue nếu có
 *
 * Nguyên lý: Sự kiện không phải là bốc 1 lá bài từ bộ bài xáo trộn.
 * Nó là việc bạn đang đứng ở ngã tư, và hệ thống tự động sinh ra
 * con đường phía trước dựa trên những dấu chân (Flags) bạn đã để lại.
 */

const balance = require('../config/balance');

// ═══════════════════════════════════════════════
// PHASE SYSTEM — Phân đoạn cuộc đời
// ═══════════════════════════════════════════════

/**
 * Xác định Phase hiện tại dựa trên realm order.
 * Mỗi Phase mở khóa một tập sự kiện khác nhau.
 *
 * Phase 1: Phàm Nhân (realm 1) — Làng quê, gặp đạo sĩ, nhặt bí kíp
 * Phase 2: Nhập Môn (realm 2-3) — Tông môn, tạp dịch, thi đấu ngoại môn
 * Phase 3: Hành Tẩu (realm 4-5) — Xuống núi, bí cảnh, Ma tu, Đấu giá
 * Phase 4: Tranh Bá (realm 6-8) — Đại kiếp, Thiên ma, Lập phái
 * Phase 5: Tiên Đạo (realm 9-11) — Phi thăng, Tiên giới, Thần thoại
 * Phase 6: Hỗn Nguyên (realm 12-15) — Sáng thế, Hủy diệt, Luân hồi
 */
function getPhase(realmOrder) {
  if (realmOrder <= 1) return 1;
  if (realmOrder <= 3) return 2;
  if (realmOrder <= 5) return 3;
  if (realmOrder <= 8) return 4;
  if (realmOrder <= 11) return 5;
  return 6;
}

const PHASE_NAMES = {
  1: 'Phàm Nhân',
  2: 'Nhập Môn',
  3: 'Hành Tẩu',
  4: 'Tranh Bá',
  5: 'Tiên Đạo',
  6: 'Hỗn Nguyên'
};

// ═══════════════════════════════════════════════
// FLAG SYSTEM
// ═══════════════════════════════════════════════

function getFlags(metadataJson) {
  if (!metadataJson) return {};
  try { return JSON.parse(metadataJson).eventFlags || {}; } catch { return {}; }
}

function mergeFlags(metadataJson, newFlags) {
  let meta = {};
  if (metadataJson) { try { meta = JSON.parse(metadataJson); } catch { meta = {}; } }
  meta.eventFlags = { ...(meta.eventFlags || {}), ...newFlags };
  return JSON.stringify(meta);
}

/**
 * Áp dụng mảng flag strings vào object.
 * setFlags(['flag_a', 'flag_b']) → { flag_a: true, flag_b: true }
 */
function flagsFromArray(arr) {
  if (!arr || !Array.isArray(arr)) return {};
  const obj = {};
  for (const f of arr) obj[f] = true;
  return obj;
}

// ═══════════════════════════════════════════════
// CONDITION CHECKING
// ═══════════════════════════════════════════════

/**
 * Kiểm tra 1 event có đủ điều kiện xuất hiện không.
 *
 * @param {object} event - Event script
 * @param {object} flags - Current event flags
 * @param {number} realmOrder - Realm order của player
 * @param {string} realmId - Realm id của player
 * @returns {boolean}
 */
function checkConditions(event, flags, realmOrder, realmId, metadataJson) {
  const cond = event.conditions;
  if (!cond) return true; // Không có conditions = luôn hiện

  let meta = {};
  if (metadataJson) { try { meta = JSON.parse(metadataJson); } catch {} }
  const turn = meta.turn || 1;
  const karma = flags.karma || 0;

  if (cond.min_turn !== undefined && turn < cond.min_turn) return false;
  if (cond.max_turn !== undefined && turn > cond.max_turn) return false;
  if (cond.min_karma !== undefined && karma < cond.min_karma) return false;
  if (cond.max_karma !== undefined && karma > cond.max_karma) return false;
  
  if (cond.affinity) {
    for (const [faction, requiredAff] of Object.entries(cond.affinity)) {
      if ((flags[`affinity_${faction}`] || 0) < requiredAff) return false;
    }
  }

  // realm range check
  if (cond.min_realm || cond.max_realm) {
    const minOrder = cond.min_realm_order || 0;
    const maxOrder = cond.max_realm_order || 999;
    if (realmOrder < minOrder || realmOrder > maxOrder) return false;
  }

  // require_flags: TẤT CẢ phải present & truthy
  if (cond.require_flags && Array.isArray(cond.require_flags)) {
    for (const f of cond.require_flags) {
      if (!flags[f]) return false;
    }
  }

  // exclude_flags: CHỈ CẦN 1 flag có mặt là loại
  if (cond.exclude_flags && Array.isArray(cond.exclude_flags)) {
    for (const f of cond.exclude_flags) {
      if (flags[f]) return false;
    }
  }

  // require_items: cần item trong inventory
  if (cond.require_items && Array.isArray(cond.require_items)) {
    // Passed via context — checked externally
  }

  return true;
}

// ═══════════════════════════════════════════════
// EVENT QUEUE
// ═══════════════════════════════════════════════

/**
 * Lấy event queue từ metadata.
 */
function getQueue(metadataJson) {
  if (!metadataJson) return [];
  try { return JSON.parse(metadataJson).eventQueue || []; } catch { return []; }
}

/**
 * Push event vào queue.
 */
function enqueueEvent(metadataJson, eventId) {
  let meta = {};
  if (metadataJson) { try { meta = JSON.parse(metadataJson); } catch { meta = {}; } }
  const queue = meta.eventQueue || [];
  if (!queue.includes(eventId)) queue.push(eventId);
  meta.eventQueue = queue;
  return JSON.stringify(meta);
}

/**
 * Pop event đầu tiên khỏi queue (FIFO).
 * Trả về { eventId, newMetadata }
 */
function dequeueEvent(metadataJson) {
  let meta = {};
  if (metadataJson) { try { meta = JSON.parse(metadataJson); } catch { meta = {}; } }
  const queue = meta.eventQueue || [];
  const eventId = queue.shift() || null;
  meta.eventQueue = queue;
  return { eventId, newMetadata: JSON.stringify(meta) };
}

/**
 * Clear toàn bộ queue.
 */
function clearQueue(metadataJson) {
  let meta = {};
  if (metadataJson) { try { meta = JSON.parse(metadataJson); } catch { meta = {}; } }
  meta.eventQueue = [];
  return JSON.stringify(meta);
}

// ═══════════════════════════════════════════════
// EVENT SELECTION ENGINE
// ═══════════════════════════════════════════════

/**
 * Tìm event tiếp theo — Full Engine.
 *
 * Workflow:
 *   1. Check Queue → nếu có forced event, trả luôn
 *   2. Filter pool → Phase + Conditions + Flags
 *   3. Weight calculation → base_weight + Luck modifier
 *   4. Weighted random roll
 *
 * @param {object} eventScripts - data.eventScripts
 * @param {string} nodeType - Loại node map
 * @param {object} flags - Current flags
 * @param {number} realmOrder - Realm order
 * @param {string} realmId - Realm id
 * @param {number} luck - Player luck
 * @param {string} metadataJson - Run metadata (for queue)
 * @param {() => number} rng
 * @returns {{ script: object|null, index: number, fromQueue: boolean, newMetadata?: string }}
 */
function pickEventScript(eventScripts, nodeType, flags, realmOrder, realmId, luck, metadataJson, rng = Math.random) {
  const pool = eventScripts[nodeType];
  if (!pool || !Array.isArray(pool) || pool.length === 0) return { script: null, index: -1 };

  const phase = getPhase(realmOrder);

  // ═══ STEP 1: Check Queue ═══
  const { eventId: queuedId, newMetadata: afterDequeue } = dequeueEvent(metadataJson);
  if (queuedId) {
    // Tìm event trong pool (tìm theo id trong TẤT CẢ categories)
    let forcedEvent = pool.find(e => e.id === queuedId);
    if (!forcedEvent) {
      // Tìm trong tất cả categories
      for (const key of Object.keys(eventScripts)) {
        forcedEvent = eventScripts[key]?.find(e => e.id === queuedId);
        if (forcedEvent) break;
      }
    }
    if (forcedEvent) {
      return { script: forcedEvent, index: -1, fromQueue: true, newMetadata: afterDequeue };
    }
    // Event trong queue không tìm thấy → bỏ qua, tiếp tục random
  }

  // ═══ STEP 2: Filter ═══
  const eligible = [];
  for (let i = 0; i < pool.length; i++) {
    const event = pool[i];

    // Phase filter: event phải thuộc phase hiện tại hoặc thấp hơn
    const eventPhase = event.phase || 1;
    if (eventPhase > phase) continue;

    // Condition filter
    if (!checkConditions(event, flags, realmOrder, realmId, metadataJson)) continue;

    eligible.push({ script: event, index: i });
  }

  if (eligible.length === 0) return { script: null, index: -1, reason: 'no_eligible' };

  // ═══ STEP 3: Weight Calculation ═══
  // Luck buff: Kỳ Ngộ (phase >= current phase) được buff x2 weight nếu luck cao
  const luckBonus = 1 + (luck / 100); // luck 0-100 → multiplier 1.0-2.0

  const weighted = eligible.map(e => {
    let weight = e.script.base_weight || 50;

    // Luck buff cho high-phase events (Kỳ Ngộ)
    if (e.script.phase && e.script.phase >= phase) {
      weight = Math.floor(weight * luckBonus);
    }

    // Kỳ ngộ tag được buff thêm
    if (e.script.tags && e.script.tags.includes('ky_ngo')) {
      weight = Math.floor(weight * (1 + luck / 50)); // x2 at 50 luck, x3 at 100
    }

    return { ...e, weight };
  });

  // ═══ STEP 4: Weighted Random Roll ═══
  const totalWeight = weighted.reduce((s, e) => s + e.weight, 0);
  let roll = rng() * totalWeight;
  for (const e of weighted) {
    roll -= e.weight;
    if (roll <= 0) return { script: e.script, index: e.index, fromQueue: false };
  }

  // Fallback: last event
  return { script: weighted[weighted.length - 1].script, index: weighted[weighted.length - 1].index, fromQueue: false };
}

// ═══════════════════════════════════════════════
// CHOICE RESOLUTION
// ═══════════════════════════════════════════════

/**
 * Xử lý lựa chọn — có hỗ trợ next_event chaining.
 */
function resolveChoice(script, choiceIndex, luck = 0, flags = {}, rng = Math.random) {
  if (!script.choices || !Array.isArray(script.choices)) {
    return { ok: false, error: 'Script không có choices' };
  }
  if (choiceIndex < 0 || choiceIndex >= script.choices.length) {
    return { ok: false, error: `Choice ${choiceIndex} không hợp lệ (0-${script.choices.length - 1})` };
  }

  const choice = script.choices[choiceIndex];
  const result = {
    text: script.desc || script.text || '',
    choice: choice.label || choice.text || ''
  };

  const setFlags = {};
  let nextEventId = null;

  // Collect script-level flags
  if (script.set_flags) Object.assign(setFlags, flagsFromArray(script.set_flags));

  if (!choice.success_rate || choice.success_rate >= 1.0 || (choice.on_fail && !choice.on_fail)) {
    // No risk or guaranteed
    result.outcome = 'success';
    result.outcomeText = choice.on_success?.text || choice.success?.text || '';
    result.reward = choice.on_success?.reward || choice.success?.reward || null;
    result.cost = choice.on_success?.cost || choice.cost || choice.success?.cost || null;
    if (choice.on_success?.set_flags) Object.assign(setFlags, flagsFromArray(choice.on_success.set_flags));
    if (choice.set_flags) Object.assign(setFlags, flagsFromArray(choice.set_flags));
    nextEventId = choice.on_success?.next_event || null;
    return { ok: true, result, setFlags, nextEventId };
  }

  // Risk roll
  const baseRate = choice.success_rate || 0.5;
  const luckBonus = luck / 200;
  const effectiveRate = Math.min(0.95, baseRate + luckBonus);
  const success = rng() < effectiveRate;

  if (success) {
    result.outcome = 'success';
    result.outcomeText = choice.on_success?.text || choice.success?.text || '';
    result.reward = choice.on_success?.reward || choice.success?.reward || null;
    result.cost = choice.on_success?.cost || choice.cost || choice.success?.cost || null;
    if (choice.on_success?.set_flags) Object.assign(setFlags, flagsFromArray(choice.on_success.set_flags));
    nextEventId = choice.on_success?.next_event || null;
  } else {
    result.outcome = 'failure';
    result.outcomeText = choice.on_fail?.text || choice.failure?.text || '';
    result.damage = choice.on_fail?.damage || choice.failure?.damage || null;
    result.cost = choice.on_fail?.cost || choice.failure?.cost || null;
    if (choice.on_fail?.set_flags) Object.assign(setFlags, flagsFromArray(choice.on_fail.set_flags));
    nextEventId = choice.on_fail?.next_event || null;
  }

  if (choice.set_flags) Object.assign(setFlags, flagsFromArray(choice.set_flags));
  return { ok: true, result, setFlags, nextEventId };
}

// ═══════════════════════════════════════════════
// REWARD / DAMAGE / COST
// ═══════════════════════════════════════════════

function classifyCombatNode(nodeType) {
  return { type: 'combat', isBoss: nodeType === 'boss', isElite: nodeType === 'elite' };
}

function applyReward(run, reward, flags = {}) {
  if (!reward) return;
  if (reward.spiritStones) run.spirit_stones += reward.spiritStones;
  if (reward.hpRestore) run.hp = Math.min(run.hp_max, run.hp + reward.hpRestore);
  if (reward.fullHpHeal) run.hp = run.hp_max;
  if (reward.linhKhiRestore) run.linh_khi = Math.min(run.linh_khi_max, run.linh_khi + reward.linhKhiRestore);
  if (reward.restHeal) {
    const healPct = balance.map.restHealPercent;
    run.hp = Math.min(run.hp_max, run.hp + Math.floor(run.hp_max * healPct));
    run.linh_khi = Math.min(run.linh_khi_max, run.linh_khi + Math.floor(run.linh_khi_max * healPct));
  }
  if (reward.restFullHeal) {
    run.hp = run.hp_max;
    run.linh_khi = run.linh_khi_max;
  }
  if (reward.tuVi) run.tu_vi += reward.tuVi;
  if (reward.luckBoost) {
    flags._tempLuckBoost = (flags._tempLuckBoost || 0) + reward.luckBoost;
  }
  if (reward.item) {
    reward._item = reward.item;
    if (reward.item2) reward._item2 = reward.item2;
  }
  // Support items array
  if (reward.items && Array.isArray(reward.items)) {
    reward._items = reward.items;
  }
  if (reward.karma) {
    flags.karma = (flags.karma || 0) + reward.karma;
  }
  if (reward.affinity) {
    for (const [faction, val] of Object.entries(reward.affinity)) {
      flags[`affinity_${faction}`] = (flags[`affinity_${faction}`] || 0) + val;
    }
  }
}

function applyDamage(run, damage) {
  if (!damage) return;
  if (damage.hp) run.hp = Math.max(0, run.hp - damage.hp);
  if (damage.hpPct) run.hp = Math.max(0, run.hp - Math.floor(run.hp_max * damage.hpPct));
  if (damage.lkDrain) run.linh_khi = Math.max(0, run.linh_khi - damage.lkDrain);
}

function applyCost(run, cost) {
  if (!cost) return;
  if (cost.spiritStones) run.spirit_stones = Math.max(0, run.spirit_stones - cost.spiritStones);
  if (cost.tuoiTho) run.tuoi_tho = Math.max(0, run.tuoi_tho - cost.tuoiTho);
  if (cost.hp) run.hp = Math.max(0, run.hp - cost.hp);
  if (cost.linhKhi) run.linh_khi = Math.max(0, run.linh_khi - cost.linhKhi);
}

function applyFlagsToRun(metadataJson, newFlags = {}) {
  if (!newFlags || Object.keys(newFlags).length === 0) return metadataJson;
  return mergeFlags(metadataJson, newFlags);
}

// ═══════════════════════════════════════════════
// EXPORT
// ═══════════════════════════════════════════════

module.exports = {
  // Phase
  getPhase,
  PHASE_NAMES,
  // Flags
  getFlags,
  mergeFlags,
  flagsFromArray,
  applyFlagsToRun,
  // Conditions
  checkConditions,
  // Queue
  getQueue,
  enqueueEvent,
  dequeueEvent,
  clearQueue,
  // Engine
  pickEventScript,
  resolveChoice,
  // Actions
  classifyCombatNode,
  applyReward,
  applyDamage,
  applyCost
};
