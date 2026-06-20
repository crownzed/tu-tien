/**
 * lib/meditation.js
 * Meditation System — dùng FSM MEDITATING để tăng Tu Vi + Linh Khí.
 * Có nguy cơ bị tập kích. Data-driven, test được bằng node.
 */

const balance = require('../config/balance');

/**
 * Bắt đầu thiền định.
 * @param {object} run - run row
 * @param {object} realm - realm hiện tại
 * @returns {{ ok:boolean, error?:string }}
 */
function startMeditation(run, realm) {
  if (run.fsm_state !== 'IDLE') return { ok: false, error: `Không thể thiền khi đang ${run.fsm_state}.` };
  return { ok: true };
}

/**
 * Tính kết quả thiền định dựa trên thời gian.
 * @param {number} minutes - số phút thiền
 * @param {object} run - run row
 * @param {object} realm - realm hiện tại
 * @param {number} luck
 * @param {() => number} rng
 * @returns {{ tuViGain:number, linhKhiGain:number, ambushChance:number, ambushed:boolean, message:string }}
 */
function meditate(minutes, run, realm, luck = 0, rng = Math.random) {
  const realmOrder = realm.order || 1;
  const baseTuViPerMin = 0.5 + realmOrder * 0.3;
  const baseLKPerMin = 0.3 + realmOrder * 0.2;

  const tuViGain = Math.floor(minutes * baseTuViPerMin * (1 + luck / 200));
  const linhKhiGain = Math.floor(minutes * baseLKPerMin);

  // Nguy cơ bị tập kích: 5% mỗi 10 phút, giảm bởi luck
  const ambushChance = Math.min(0.5, (minutes / 10) * 0.05 * (1 - luck / 300));
  const ambushed = rng() < ambushChance;

  let message = `Thiền ${minutes} phút: Tu Vi +${tuViGain}, Linh Khí +${linhKhiGain}.`;
  if (ambushed) message += ' NHƯNG bị tập kích giữa chừng!';

  return { tuViGain, linhKhiGain, ambushChance, ambushed, message };
}

/**
 * Ngừng thiền, trả về kết quả.
 */
function stopMeditation(run, meditationStartMs, nowMs, realm, luck, rng) {
  const elapsedMs = nowMs - meditationStartMs;
  const minutes = Math.max(1, Math.floor(elapsedMs / 60000));
  return meditate(minutes, run, realm, luck, rng);
}

module.exports = { startMeditation, meditate, stopMeditation };
