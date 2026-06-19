/**
 * lib/game-service.js
 * Tầng logic game thuần (không phụ thuộc Electron/DOM).
 * Nhận repositories + game data, thực thi luật chơi. Test được bằng node.
 */

const balance = require('../config/balance');
const RNGEngine = require('./rng-engine');
const { computeLinhKhiRegen } = require('./time-delta');
const { FSM, STATES } = require('./fsm');

class GameService {
  /**
   * @param {object} repos - createRepositories(db)
   * @param {object} data  - loadGameData()
   * @param {() => number} rng - inject để test
   */
  constructor(repos, data, rng = Math.random) {
    this.repos = repos;
    this.data = data;
    this.rng = rng;
  }

  // ---------- Character Creation ----------

  /** Roll Linh Căn, cập nhật pity. */
  rollLinhCan() {
    const pity = this.repos.pity.get();
    const account = this.repos.account.get();
    const luck = account.innate_luck_bonus;
    const { result, resetPity } = RNGEngine.rollLinhCan(
      this.data.linhCan, pity.linh_can_rolls, luck, this.rng
    );
    if (resetPity) this.repos.pity.reset('linh_can_rolls');
    else this.repos.pity.increment('linh_can_rolls');
    return { result, def: this.data.linhCanById[result], pityCount: pity.linh_can_rolls, resetPity };
  }

  /** Roll Gia Cảnh, cập nhật pity. */
  rollGiaCanh() {
    const pity = this.repos.pity.get();
    const account = this.repos.account.get();
    const luck = account.innate_luck_bonus;
    const { result, resetPity } = RNGEngine.rollGiaCanh(
      this.data.giaCanh, pity.gia_canh_rolls, luck, this.rng
    );
    if (resetPity) this.repos.pity.reset('gia_canh_rolls');
    else this.repos.pity.increment('gia_canh_rolls');
    return { result, def: this.data.giaCanhById[result], pityCount: pity.gia_canh_rolls, resetPity };
  }

  /**
   * Tạo kiếp mới từ linh căn + gia cảnh đã chọn.
   * Cộng chỉ số tiên thiên từ account.
   * @param {string} linhCanId
   * @param {string} giaCanhId
   * @param {number} nowMs
   */
  createRun(linhCanId, giaCanhId, nowMs = Date.now()) {
    const linhCan = this.data.linhCanById[linhCanId];
    const giaCanh = this.data.giaCanhById[giaCanhId];
    if (!linhCan) throw new Error(`Linh căn không tồn tại: ${linhCanId}`);
    if (!giaCanh) throw new Error(`Gia cảnh không tồn tại: ${giaCanhId}`);

    const account = this.repos.account.get();
    const startRealm = this.data.realmById[giaCanh.startRealm || 'luyen_khi'];

    // Base + tiên thiên + realm bonus
    const hpMax = balance.base.hpMax + startRealm.hpBonus + account.innate_hp_bonus;
    const linhKhiMax = startRealm.linhKhiMax + account.innate_linhkhi_bonus;
    const luck = balance.base.luck + account.innate_luck_bonus + (giaCanh.startLuckBonus || 0);

    const runData = {
      alive: 1,
      realm_id: startRealm.id,
      linh_can_id: linhCanId,
      gia_canh_id: giaCanhId,
      hp: hpMax,
      hp_max: hpMax,
      linh_khi: linhKhiMax,
      linh_khi_max: linhKhiMax,
      tu_vi: 0,
      tuoi_tho: balance.base.tuoiTho,
      tuoi_tho_max: startRealm.tuoiThoMax,
      luck,
      spirit_stones: giaCanh.startSpiritStones || 0,
      fsm_state: STATES.IDLE,
      linh_khi_last_update: nowMs,
      started_at: nowMs,
      monsters_killed: 0
    };

    const run = this.repos.run.create(runData);

    // Đồ khởi đầu từ gia cảnh
    if (Array.isArray(giaCanh.startItems)) {
      for (const itemId of giaCanh.startItems) {
        this.repos.inventory.add({ item_id: itemId, item_name: itemId, quantity: 1 });
      }
    }
    return run;
  }

  // ---------- Linh Khí (Time-Delta) ----------

  updateLinhKhi(nowMs = Date.now()) {
    const run = this.repos.run.get();
    if (!run) return null;

    const multiplier = run.fsm_state === STATES.MEDITATING
      ? balance.linhKhi.meditationMultiplier : 1;

    const r = computeLinhKhiRegen({
      current: run.linh_khi,
      max: run.linh_khi_max,
      lastUpdateMs: run.linh_khi_last_update,
      nowMs,
      regenRate: balance.linhKhi.regenRatePerMinute,
      multiplier
    });

    this.repos.run.update({
      linh_khi: r.newValue,
      linh_khi_last_update: r.newLastUpdateMs
    });
    return r;
  }

  // ---------- FSM ----------

  /** Thử chuyển state, persist nếu hợp lệ. */
  transitionState(toState) {
    const run = this.repos.run.get();
    if (!run) return { ok: false, error: 'Chưa có kiếp nào' };
    const fsm = new FSM(run.fsm_state);
    const res = fsm.transition(toState);
    if (res.ok) this.repos.run.update({ fsm_state: res.to });
    return res;
  }

  // ---------- Death & Scoring (thuật toán #6) ----------

  /** Tính điểm luân hồi của kiếp hiện tại. */
  computeScore(run) {
    const realm = this.data.realmById[run.realm_id];
    const yearsLived = Math.max(0, run.tuoi_tho - balance.base.tuoiTho);
    const { realmMultiplier, yearMultiplier } = balance.meta.score;
    return Math.floor(
      realm.order * realmMultiplier +
      yearsLived * yearMultiplier +
      run.monsters_killed * 50
    );
  }

  /** EXP cần để lên level kế (thuật toán #6). */
  expForLevel(level) {
    const { baseExp, exponent } = balance.meta.levelCurve;
    return Math.floor(baseExp * Math.pow(level, exponent));
  }

  /**
   * Xử lý chết: tính điểm, cộng vào account, level up nếu đủ, đánh dấu run chết.
   * @returns {{ score, leveledUp, newLevel, lifetimes }}
   */
  processDeath() {
    const run = this.repos.run.get();
    if (!run) return null;

    const score = this.computeScore(run);
    const account = this.repos.account.get();

    let totalExp = account.total_exp + score;
    let level = account.level;
    let leveledUp = false;

    while (totalExp >= this.expForLevel(level)) {
      totalExp -= this.expForLevel(level);
      level++;
      leveledUp = true;
    }

    this.repos.account.update({
      level,
      total_exp: totalExp,
      luan_hoi_points: account.luan_hoi_points + score,
      total_lifetimes: account.total_lifetimes + 1
    });

    this.repos.run.markDead();

    return { score, leveledUp, newLevel: level, lifetimes: account.total_lifetimes + 1 };
  }

  /** Endless difficulty multiplier (thuật toán #3). */
  difficultyMultiplier(run) {
    const realm = this.data.realmById[run.realm_id];
    const yearsLived = Math.max(0, run.tuoi_tho - balance.base.tuoiTho);
    const { yearsDivisor, yearsExponent, realmFactor } = balance.scaling;
    return 1 + Math.pow(yearsLived / yearsDivisor, yearsExponent) + realm.order * realmFactor;
  }
}

module.exports = { GameService };
