/**
 * lib/combat.js
 * Combat Engine — damage formula, element system, enemy AI.
 * Data-driven, không phụ thuộc Electron/DOM. Test được bằng node.
 */

const balance = require('../config/balance');

// Ngũ Hành tương khắc: key khắc value
const ELEMENT_COUNTER = {
  kim: 'moc',
  moc: 'tho',
  tho: 'thuy',
  thuy: 'hoa',
  hoa: 'kim'
};

/**
 * Tính hệ số khắc chế nguyên tố.
 * @param {string|null} atkElement - nguyên tố người tấn công
 * @param {string|null} defElement - nguyên tố người phòng thủ
 * @returns {number} 1.5 (khắc), 0.5 (bị khắc), 1.0 (trung tính)
 */
function getElementMultiplier(atkElement, defElement) {
  if (!atkElement || !defElement) return balance.combat.elementNeutral;
  if (ELEMENT_COUNTER[atkElement] === defElement) return balance.combat.elementCounter;
  if (ELEMENT_COUNTER[defElement] === atkElement) return balance.combat.elementWeak;
  return balance.combat.elementNeutral;
}

/**
 * Công thức sát thương (thuật toán #5).
 *   raw = attacker.attack * elementMultiplier
 *   varied = raw * random(variance.min, variance.max)
 *   final = max(varied - defender.defense, minDamage)
 * @param {{ attack:number, element?:string|null }} attacker
 * @param {{ defense:number, element?:string|null }} defender
 * @param {() => number} rng
 * @returns {{ damage:number, elementMultiplier:number, raw:number }}
 */
function calculateDamage(attacker, defender, rng = Math.random) {
  const { min, max } = balance.combat.variance;
  const elmMult = getElementMultiplier(attacker.element, defender.element);
  const raw = attacker.attack * elmMult;
  const varied = raw * (min + rng() * (max - min));
  const damage = Math.max(Math.round(varied - (defender.defense || 0)), balance.combat.minDamage);
  return { damage, elementMultiplier: elmMult, raw: Math.round(raw) };
}

/**
 * Chọn quái phù hợp realm.
 * @param {Array} zones - data enemies.zones
 * @param {number} realmOrder
 * @param {boolean} isBoss - ép chọn boss
 * @param {() => number} rng
 * @returns {{ enemy:object, zone:object }}
 */
function pickEnemy(zones, realmOrder, isBoss = false, rng = Math.random) {
  const zone = zones.find(z => realmOrder >= z.realmMin && realmOrder <= z.realmMax);
  if (!zone) {
    // fallback: zone cuối cùng nếu realm vượt ngoài
    const last = zones[zones.length - 1];
    return { enemy: isBoss ? last.boss : pickRandom(last.enemies, rng), zone: last };
  }
  return { enemy: isBoss ? zone.boss : pickRandom(zone.enemies, rng), zone };
}

function pickRandom(arr, rng = Math.random) {
  return arr[Math.min(arr.length - 1, Math.floor(rng() * arr.length))];
}

/**
 * Tạo combat state mới.
 * @param {object} enemy - enemy definition từ enemies.json
 * @param {number} difficultyMult - từ GameService.difficultyMultiplier()
 * @returns {object} combat state (lưu vào run.metadata)
 */
function initCombatState(enemy, difficultyMult = 1) {
  const hp = Math.round(enemy.hp * difficultyMult);
  const atk = Math.round(enemy.attack * difficultyMult);
  const def = Math.round((enemy.defense || 0) * difficultyMult);
  return {
    enemyId: enemy.id,
    enemyName: enemy.name,
    enemyHp: hp,
    enemyMaxHp: hp,
    enemyAttack: atk,
    enemyDefense: def,
    enemyElement: enemy.element || null,
    dropStones: enemy.dropStones,
    expReward: Math.round(enemy.expReward * difficultyMult),
    turn: 0,
    log: [`⚔️ ${enemy.name} xuất hiện! HP: ${hp}/${hp} | ATK: ${atk} | DEF: ${def}`]
  };
}

/**
 * Parse combat state từ metadata JSON string.
 */
function parseCombatState(metadataJson) {
  if (!metadataJson) return null;
  try { return JSON.parse(metadataJson); } catch { return null; }
}

/**
 * Serialize combat state về JSON string.
 */
function serializeCombatState(combat) {
  return JSON.stringify(combat);
}

/**
 * Enemy AI: chọn hành động và tính sát thương.
 * Hiện tại: tấn công cơ bản. Có thể mở rộng thêm skill.
 * @returns {{ action:string, damage:number, raw:number, elementMultiplier:number }}
 */
function enemyTurn(enemyCombat, playerElement, rng = Math.random) {
  const attacker = { attack: enemyCombat.enemyAttack, element: enemyCombat.enemyElement };
  const defender = { defense: 0, element: playerElement };
  const result = calculateDamage(attacker, defender, rng);
  return {
    action: 'attack',
    ...result
  };
}

/**
 * Roll thưởng rơi ra sau khi thắng.
 * @param {Array<number>} dropStones - [min, max]
 * @param {() => number} rng
 * @returns {number}
 */
function rollDrop(dropStones, rng = Math.random) {
  const [min, max] = dropStones;
  return Math.floor(min + rng() * (max - min + 1));
}

module.exports = {
  ELEMENT_COUNTER,
  getElementMultiplier,
  calculateDamage,
  pickEnemy,
  initCombatState,
  parseCombatState,
  serializeCombatState,
  enemyTurn,
  rollDrop
};
