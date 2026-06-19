/**
 * lib/fsm.js
 * Finite State Machine (thuật toán #7).
 * Quản lý trạng thái nhân vật + validate transition.
 * Ngăn hành động bất hợp lệ (vd: chiến đấu khi đang bế quan luyện đan).
 */

// Các trạng thái hợp lệ
const STATES = Object.freeze({
  IDLE: 'IDLE',
  COMBAT: 'COMBAT',
  CRAFTING: 'CRAFTING',
  TRIBULATION: 'TRIBULATION', // Độ kiếp
  MEDITATING: 'MEDITATING',   // Tịnh Khí
  DEAD: 'DEAD'
});

// Bảng transition hợp lệ: từ state -> các state có thể tới
const TRANSITIONS = Object.freeze({
  IDLE:        ['COMBAT', 'CRAFTING', 'TRIBULATION', 'MEDITATING', 'DEAD'],
  COMBAT:      ['IDLE', 'DEAD'],
  CRAFTING:    ['IDLE', 'DEAD'],          // nổ lò có thể -> DEAD
  TRIBULATION: ['IDLE', 'DEAD'],
  MEDITATING:  ['IDLE', 'COMBAT', 'DEAD'], // bị tập kích khi thiền
  DEAD:        []                          // tuyệt lộ, chỉ rebirth (tạo run mới) thoát được
});

// Action nào được phép ở state nào
const ALLOWED_ACTIONS = Object.freeze({
  IDLE:        ['explore', 'craft', 'meditate', 'breakthrough', 'rest', 'status', 'inventory'],
  COMBAT:      ['attack', 'cast', 'use_item', 'flee', 'forbidden_art', 'status'],
  CRAFTING:    ['status'],
  TRIBULATION: ['use_artifact', 'endure', 'status'],
  MEDITATING:  ['stop_meditate', 'status'],
  DEAD:        ['rebirth', 'status']
});

class FSM {
  constructor(initialState = STATES.IDLE) {
    if (!STATES[initialState]) {
      throw new Error(`Invalid initial state: ${initialState}`);
    }
    this.state = initialState;
  }

  /** Kiểm tra có thể chuyển sang state mới không */
  canTransition(toState) {
    if (!STATES[toState]) return false;
    return TRANSITIONS[this.state].includes(toState);
  }

  /**
   * Chuyển state. Trả về {ok, from, to, error}.
   * Không throw — caller tự xử lý kết quả.
   */
  transition(toState) {
    const from = this.state;
    if (!STATES[toState]) {
      return { ok: false, from, to: toState, error: `State không tồn tại: ${toState}` };
    }
    if (!this.canTransition(toState)) {
      return { ok: false, from, to: toState, error: `Không thể chuyển ${from} -> ${toState}` };
    }
    this.state = toState;
    return { ok: true, from, to: toState };
  }

  /** Action có hợp lệ ở state hiện tại không */
  isActionAllowed(action) {
    return ALLOWED_ACTIONS[this.state].includes(action);
  }

  getState() { return this.state; }
}

module.exports = { FSM, STATES, TRANSITIONS, ALLOWED_ACTIONS };
