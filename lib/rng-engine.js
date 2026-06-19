/**
 * lib/rng-engine.js
 * Weighted Random + Pity System (thuật toán #1 và #4).
 * Data-driven: nhận options từ data layer, không hardcode content.
 */

const balance = require('../config/balance');

class RNGEngine {
  /**
   * Weighted Random Selection với Luck modifier (thuật toán #1).
   * @param {Array<{id:string, weight:number, isGood?:boolean}>} options
   * @param {number} luck
   * @param {() => number} rng - inject được để test deterministic (default Math.random)
   * @returns {string} id được chọn
   */
  static weightedRoll(options, luck = 0, rng = Math.random) {
    if (!options || options.length === 0) {
      throw new Error('Options array cannot be empty');
    }

    const { goodDivisor, badDivisor } = balance.luck;

    const adjusted = options.map(opt => {
      let w = opt.weight;
      if (opt.isGood === true) {
        w = opt.weight * (1 + luck / goodDivisor);
      } else if (opt.isGood === false) {
        w = Math.max(0.1, opt.weight * (1 - luck / badDivisor));
      }
      return { id: opt.id, adjustedWeight: w };
    });

    const total = adjusted.reduce((s, o) => s + o.adjustedWeight, 0);
    let roll = rng() * total;

    for (const o of adjusted) {
      roll -= o.adjustedWeight;
      if (roll <= 0) return o.id;
    }
    return adjusted[adjusted.length - 1].id;
  }

  /**
   * Pity System (thuật toán #4) — linear ramp từ soft pity tới 100% ở hard pity.
   * @param {object} cfg - { baseRate, softPityStart, hardPity, increment }
   * @param {number} currentPity
   * @param {() => number} rng
   * @returns {boolean} true nếu thành công
   */
  static pityRoll(cfg, currentPity, rng = Math.random) {
    const { baseRate, softPityStart, hardPity, increment } = cfg;

    if (currentPity >= hardPity) return true;

    let rate;
    if (currentPity >= softPityStart) {
      const rateAtSoftStart = baseRate + softPityStart * increment;
      const progress = (currentPity - softPityStart) / (hardPity - softPityStart);
      rate = rateAtSoftStart + progress * (1.0 - rateAtSoftStart);
    } else {
      rate = baseRate + currentPity * increment;
    }

    return rng() < Math.min(1.0, rate);
  }

  /**
   * Roll Linh Căn với pity. Data + pity config inject từ ngoài.
   * @param {Array} linhCanOptions - data/character.json linh_can
   * @param {number} currentPity
   * @param {number} luck
   * @param {() => number} rng
   * @returns {{ result:string, resetPity:boolean }}
   */
  static rollLinhCan(linhCanOptions, currentPity = 0, luck = 0, rng = Math.random) {
    if (this.pityRoll(balance.pity.linhCan, currentPity, rng)) {
      return { result: 'thien_linh_can', resetPity: true };
    }
    const result = this.weightedRoll(linhCanOptions, luck, rng);
    const resetPity = (result === 'thien_linh_can' || result === 'bien_di_thanh_the');
    return { result, resetPity };
  }

  /**
   * Roll Gia Cảnh với pity.
   */
  static rollGiaCanh(giaCanhOptions, currentPity = 0, luck = 0, rng = Math.random) {
    if (this.pityRoll(balance.pity.giaCanh, currentPity, rng)) {
      return { result: 'dich_ton_thanh_dia', resetPity: true };
    }
    const result = this.weightedRoll(giaCanhOptions, luck, rng);
    const resetPity = (result === 'dich_ton_thanh_dia');
    return { result, resetPity };
  }

  /**
   * Roll event từ data/events.json.
   */
  static rollEvent(eventOptions, luck = 0, rng = Math.random) {
    return this.weightedRoll(eventOptions, luck, rng);
  }
}

module.exports = RNGEngine;
