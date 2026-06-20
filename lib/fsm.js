/**
 * lib/fsm.js
 * Finite State Machine — Kiến Trúc Máy Trạng Thái Hữu Hạn.
 *
 * Mục đích: Khóa chặt logic, đảm bảo tại một thời điểm nhân vật
 * chỉ được phép làm những hành động hợp lệ. Ngăn spam dòng lệnh,
 * bấm nhầm, hoặc gọi hành động không đúng ngữ cảnh.
 *
 * FSM Middleware sẽ chặn mọi Action Payload không hợp lệ TRƯỚC KHI
 * gọi đến GameService, không cần chạm vào database.
 */

// ── States ──
const STATES = Object.freeze({
  IDLE:        'IDLE',          // Tự do — có thể di chuyển, mở túi đồ, tịnh khí
  IN_EVENT:    'IN_EVENT',      // Đang đọc cốt truyện — CHỈ chọn phương án
  COMBAT:      'COMBAT',        // Đang chiến đấu — CHỈ đánh, thi pháp, chạy
  MEDITATING:  'MEDITATING',    // Đang nhập định/tịnh khí — KHÓA TẤT CẢ, trừ thức tỉnh
  TRIBULATION: 'TRIBULATION',   // Đang độ thiên kiếp — CHỈ chịu lôi hoặc dùng artifact
  CRAFTING:    'CRAFTING',      // Đang chế tạo (dự phòng)
  DEAD:        'DEAD'           // Game Over — CHỈ luân hồi
});

// ── Transition Table ──
// Từ state hiện tại → những state có thể chuyển đến
const TRANSITIONS = Object.freeze({
  IDLE:        ['IN_EVENT', 'COMBAT', 'MEDITATING', 'TRIBULATION', 'CRAFTING', 'DEAD'],
  IN_EVENT:    ['IDLE', 'COMBAT', 'DEAD'],
  COMBAT:      ['IDLE', 'DEAD'],
  MEDITATING:  ['IDLE', 'COMBAT', 'DEAD'],   // Bị tập kích khi thiền → COMBAT
  TRIBULATION: ['IDLE', 'DEAD'],              // Sống sót → IDLE, chết → DEAD
  CRAFTING:    ['IDLE', 'DEAD'],
  DEAD:        []                              // Chỉ rebirth (tạo run mới)
});

// ── Action Permission Table ──
// Mỗi state CHỈ cho phép một tập action cụ thể
const ALLOWED_ACTIONS = Object.freeze({
  IDLE: [
    'inventory', 'equip', 'unequip', 'use_item',
    'travel', 'enter_node', 'select_node',
    'meditate', 'breakthrough', 'craft',
    'sect_list', 'sect_join', 'sect_leave', 'sect_contribute',
    'shop', 'shop_buy',
    'status', 'map', 'account', 'history', 'achievements',
    'die'
  ],

  IN_EVENT: [
    'choose',           // Chọn phương án 1/2/3
    'status'            // Xem trạng thái
  ],

  COMBAT: [
    'attack', 'cast', 'forbidden_art', 'flee',
    'use_item',         // Dùng đan dược trong combat
    'status'
  ],

  MEDITATING: [
    'stop_meditate',    // Thức tỉnh / hủy bế quan
    'status'
  ],

  TRIBULATION: [
    'endure',           // Chịu 1 đạo lôi kiếp
    'use_artifact',     // Dùng pháp bảo chống kiếp
    'status'
  ],

  CRAFTING: [
    'status'
  ],

  DEAD: [
    'start',            // Luân hồi / rebirth
    'status',
    'history'
  ]
});

// ── Action → Human-readable error messages ──
const ACTION_ERRORS = {
  travel:    'Bản ngã đang chìm trong thiên địa, không thể di chuyển!',
  meditate:  'Tâm trí chưa tĩnh, chưa thể nhập định lúc này.',
  attack:    'Không có kẻ địch nào để tấn công.',
  cast:      'Chưa đến lúc thi triển thuật pháp.',
  flee:      'Không thể chạy trốn khỏi hư vô.',
  endure:    'Không có thiên kiếp nào đang diễn ra.',
  choose:    'Không có sự kiện nào để lựa chọn.',
  breakthrough: 'Chưa thể đột phá trong hoàn cảnh hiện tại.',
  craft:     'Không thể chế tạo lúc này.',
  shop:      'Không thể mở cửa hàng lúc này.',
  inventory: 'Không thể xem túi đồ lúc này.',
  use_item:  'Không thể sử dụng vật phẩm lúc này.',
  start:     'Hãy để kiếp này kết thúc trước đã.',
  default:   'Hành động này không khả dụng trong trạng thái hiện tại.'
};

// ── FSM Class ──
class FSM {
  /**
   * @param {string} initialState - Một trong STATES
   */
  constructor(initialState = STATES.IDLE) {
    if (!STATES[initialState]) {
      throw new Error(`Trạng thái không tồn tại: ${initialState}`);
    }
    this.state = initialState;
  }

  /** @returns {string} State hiện tại */
  getState() { return this.state; }

  /** @returns {boolean} Nhân vật còn sống không */
  isAlive() { return this.state !== STATES.DEAD; }

  // ── Transition Validation ──

  /**
   * Kiểm tra CÓ THỂ chuyển sang state mới không.
   * @param {string} toState
   * @returns {boolean}
   */
  canTransition(toState) {
    if (!STATES[toState]) return false;
    return TRANSITIONS[this.state]?.includes(toState) || false;
  }

  /**
   * Thực hiện chuyển state.
   * @param {string} toState
   * @returns {{ ok: boolean, from: string, to: string, error?: string }}
   */
  transition(toState) {
    const from = this.state;

    if (!STATES[toState]) {
      return { ok: false, from, to: toState, error: `Trạng thái không tồn tại: ${toState}` };
    }

    if (!this.canTransition(toState)) {
      return {
        ok: false,
        from,
        to: toState,
        error: `Không thể chuyển từ ${from} → ${toState}. Trạng thái hiện tại không cho phép.`
      };
    }

    this.state = toState;
    return { ok: true, from, to: toState };
  }

  // ── Action Validation (FSM Middleware) ──

  /**
   * Kiểm tra action có được phép ở state hiện tại không.
   * Đây là FSM MIDDLEWARE — mọi Action Payload phải đi qua đây.
   *
   * @param {string} action - Tên action (vd: 'travel', 'attack', 'meditate')
   * @returns {{ allowed: boolean, error?: string }}
   */
  isActionAllowed(action) {
    const allowed = ALLOWED_ACTIONS[this.state] || [];

    if (allowed.includes(action)) {
      return { allowed: true };
    }

    // Sinh thông báo lỗi thân thiện, cụ thể cho từng action
    const errorMsg = ACTION_ERRORS[action] || ACTION_ERRORS.default;
    return {
      allowed: false,
      error: `[FSM] ${errorMsg} (State: ${this.state})`
    };
  }

  /**
   * Validate toàn bộ action payload.
   * Kết hợp: FSM check + resource check + cooldown check.
   *
   * @param {string} action     - Tên action
   * @param {object} context    - Context chứa các validator function
   * @param {Function} [context.checkCost]      - (action) => { ok, error }
   * @param {Function} [context.checkCooldown]  - (action) => { ok, error }
   * @param {Function} [context.checkItems]     - (action) => { ok, error }
   * @returns {{ ok: boolean, error?: string, checks?: object }}
   */
  validateAction(action, context = {}) {
    // Check 1: FSM — trạng thái hiện tại có cho phép action này không?
    const fsmCheck = this.isActionAllowed(action);
    if (!fsmCheck.allowed) {
      return { ok: false, error: fsmCheck.error, failedAt: 'fsm' };
    }

    // Check 2: Resources (HP, Mana, Linh Thạch...)
    if (context.checkCost) {
      const costCheck = context.checkCost(action);
      if (costCheck && !costCheck.ok) {
        return { ok: false, error: costCheck.error, failedAt: 'cost' };
      }
    }

    // Check 3: Cooldown / Item lock
    if (context.checkCooldown) {
      const cdCheck = context.checkCooldown(action);
      if (cdCheck && !cdCheck.ok) {
        return { ok: false, error: cdCheck.error, failedAt: 'cooldown' };
      }
    }

    // Check 4: Required items
    if (context.checkItems) {
      const itemCheck = context.checkItems(action);
      if (itemCheck && !itemCheck.ok) {
        return { ok: false, error: itemCheck.error, failedAt: 'items' };
      }
    }

    return { ok: true, passedAll: true };
  }

  /**
   * Lấy danh sách các action được phép ở state hiện tại.
   * Dùng để render UI (chỉ hiện nút hợp lệ).
   * @returns {string[]}
   */
  getAvailableActions() {
    return [...(ALLOWED_ACTIONS[this.state] || [])];
  }
}

// ── Helper: tạo context validator cho GameService ──

/**
 * Tạo context validator từ run state hiện tại.
 * Dùng kèm với FSM.validateAction().
 *
 * @param {object} run - Run state từ database
 * @param {object} costs - Cost definitions
 * @returns {object} context cho FSM.validateAction
 */
function createValidationContext(run, costs = {}) {
  return {
    checkCost(action) {
      switch (action) {
        case 'cast':
          if ((run.linh_khi || 0) < (costs.castCost || 20)) {
            return { ok: false, error: `Không đủ Chân Nguyên (cần ${costs.castCost || 20}, hiện ${run.linh_khi}).` };
          }
          break;
        case 'forbidden_art': {
          const hpCost = Math.floor((run.hp_max || 100) * 0.2);
          const lkCost = costs.forbiddenLkCost || 30;
          if ((run.hp || 0) <= hpCost) {
            return { ok: false, error: `Khí Huyết không đủ (cần ${hpCost}, hiện ${run.hp}).` };
          }
          if ((run.linh_khi || 0) < lkCost) {
            return { ok: false, error: `Chân Nguyên không đủ (cần ${lkCost}, hiện ${run.linh_khi}).` };
          }
          break;
        }
        case 'breakthrough': {
          if ((run.linh_khi || 0) < (costs.breakthroughLkCost || 50)) {
            return { ok: false, error: `Chân Nguyên không đủ để đột phá (cần ${costs.breakthroughLkCost || 50}).` };
          }
          break;
        }
        case 'meditate': {
          if ((run.linh_khi || 0) <= 0 && (run.hp || 0) <= 0) {
            return { ok: false, error: 'Khí Huyết và Chân Nguyên đều cạn, không thể nhập định.' };
          }
          break;
        }
      }
      return { ok: true };
    },

    checkCooldown(action) {
      // Cooldown check (nếu có system sau này)
      return { ok: true };
    },

    checkItems(action) {
      // Item requirement check
      return { ok: true };
    }
  };
}

module.exports = { FSM, STATES, TRANSITIONS, ALLOWED_ACTIONS, ACTION_ERRORS, createValidationContext };
