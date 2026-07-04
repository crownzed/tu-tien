/**
 * lib/combat.js
 * Combat Engine — damage formula, element system, enemy AI.
 * Data-driven, không phụ thuộc Electron/DOM. Test được bằng node.
 */

const balance = require('../config/balance');
const StatsEngine = require('./stats-engine');

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
 * Công thức sát thương V2 (Mitigation + Realm Suppression).
 *   mitigated = ATK² / (ATK + DEF)
 *   final = mitigated * critMultiplier * realmSuppress * elementMultiplier * variance
 * @param {{ attack:number, element?:string|null, realmTier?:number }} attacker
 * @param {{ defense:number, element?:string|null, realmTier?:number }} defender
 * @param {() => number} rng
 * @returns {{ damage:number, elementMultiplier:number, raw:number, isCrit:boolean }}
 */
function calculateDamage(attacker, defender, rng = Math.random) {
  const { min, max } = balance.combat.variance;
  const elmMult = getElementMultiplier(attacker.element, defender.element);

  const atkRaw = (attacker.attack || 0) * elmMult;
  const defActual = StatsEngine.calcActualDEF(defender.defense || 0);

  // Realm Suppression
  const atkTier = attacker.realmTier || 1;
  const defTier = defender.realmTier || 1;
  const suppress = StatsEngine.calcRealmSuppress(atkTier, defTier);

  // Crit roll (dùng luk nếu có, nếu không thì không bạo kích)
  const critResult = attacker.luk ? StatsEngine.rollCrit(attacker.luk, rng) : { isCrit: false, multiplier: 1.0 };

  // Mitigation formula: ATK² / (ATK + DEF)
  let mitigated = StatsEngine.calcFinalDamage(atkRaw, defActual, critResult.multiplier, suppress);

  // §2.3 Kháng nguyên tố — opt-in khi defender khai báo elemRes.
  //   Phần damage đã nhân μWuxing bị giảm theo: ElemRES/(ElemRES + Lvl*factor)
  //   Lvl = realmTier * 10 (Kim Đan tier 3 → level 30, khớp ví dụ spec).
  //   Không có elemRes → reduction 0 → hành vi như cũ.
  if (defender.elemRes != null && elmMult !== 1) {
    mitigated = StatsEngine.applyElemResistance(mitigated, defender.elemRes, defTier);
  }

  // §2.2 Tránh né hai tầng — chỉ khi defender khai báo agi (giữ test cũ không vỡ):
  //   tầng 1: né hẳn (damage 0) theo DodgeChance = AGI/(AGI+k)
  //   tầng 2: nếu không né, roll sượt → damage * glance_mult, triệt tiêu choáng/bạo kích
  if (defender.agi != null) {
    if (StatsEngine.rollDodge(defender.agi, rng)) {
      return { damage: 0, elementMultiplier: elmMult, raw: Math.round(atkRaw), isCrit: false, isGlancing: false, isDodge: true };
    }
    const glance = StatsEngine.rollGlance(attacker.agi || 0, defender.agi, rng);
    const variance = min + rng() * (max - min);
    const damage = Math.max(balance.combat.minDamage, Math.round(mitigated * variance * glance.multiplier));
    return {
      damage,
      elementMultiplier: elmMult,
      raw: Math.round(atkRaw),
      isCrit: glance.glancing ? false : critResult.isCrit,
      isGlancing: glance.glancing,
      isDodge: false
    };
  }

  // Variance (đường cũ — không có agi)
  const variance = min + rng() * (max - min);
  const damage = Math.max(balance.combat.minDamage, Math.round(mitigated * variance));

  return { damage, elementMultiplier: elmMult, raw: Math.round(atkRaw), isCrit: critResult.isCrit, isGlancing: false, isDodge: false };
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
  const zone = zones.find(z => realmOrder >= z.realmMin && realmOrder <= z.realmMax)
    || zones[zones.length - 1];
  const enemy = isBoss ? zone.boss : pickRandom(zone.enemies, rng);
  // Tier áp chế cảnh giới (§8): quái thường lấy ĐÁY band (realmMin) để người chơi cùng vùng
  // không bị phạt; boss lấy ĐỈNH band (realmMax) để thành "tường chắn" cuối realm. Clamp ≥ 1.
  const realmTier = Math.max(1, isBoss ? zone.realmMax : zone.realmMin);
  return { enemy, zone, realmTier };
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
function initCombatState(enemy, difficultyMult = 1, realmTier = 1) {
  // β cảnh giới: quái scale cùng β như HP/ATK người chơi để số lượt giết/chết ổn định
  // qua mọi cảnh giới (β triệt tiêu trong công thức ATK²/(ATK+DEF)). tier=1 → β=1 (giữ số liệu cũ).
  const beta = StatsEngine.calcRealmMultiplier(Math.max(1, realmTier || 1));
  const hp = Math.round(enemy.hp * difficultyMult * beta);
  const atk = Math.round(enemy.attack * difficultyMult * beta);
  const def = Math.round((enemy.defense || 0) * difficultyMult * beta);
  return {
    enemyId: enemy.id,
    enemyName: enemy.name,
    enemyHp: hp,
    enemyMaxHp: hp,
    enemyAttack: atk,
    enemyDefense: def,
    enemyElement: enemy.element || null,
    enemyElemRes: enemy.elemRes != null ? enemy.elemRes : null,
    enemyRealmTier: Math.max(1, realmTier || 1),  // §8 áp chế cảnh giới (đặt từ pickEnemy)
    // §3 Poise — PoiseMax = base_poise + enemyDefense * alpha_poise (def là proxy độ "cứng")
    enemyPoiseMax: Math.round(balance.combatV2.base_poise + def * balance.combatV2.alpha_poise),
    enemyPoise: Math.round(balance.combatV2.base_poise + def * balance.combatV2.alpha_poise),
    enemyStaggerTurns: 0,   // > 0 → enemy đang bị Phá Thể, nhận bonus damage
    enemyImmuneTurns: 0,    // > 0 → enemy miễn nhiễm phá thể (poise không giảm)
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
function enemyTurn(enemyCombat, playerElement, rng = Math.random, playerAgi = null, playerRealmTier = 1) {
  const attacker = { attack: enemyCombat.enemyAttack, element: enemyCombat.enemyElement, realmTier: enemyCombat.enemyRealmTier || 1 };
  // playerAgi != null → kích hoạt né/sượt hai tầng (§2.2) cho đòn enemy đánh vào player
  // playerRealmTier → §8 áp chế cảnh giới khi enemy (tier thấp hơn) đánh player (tier cao hơn)
  const defender = { defense: 0, element: playerElement, agi: playerAgi, realmTier: playerRealmTier };
  const result = calculateDamage(attacker, defender, rng);
  return {
    action: 'attack',
    ...result
  };
}

/**
 * §3 Hệ số sát thương khi enemy đang Phá Thể (Staggered).
 * Phải gọi TRƯỚC applyPoiseDamage để đòn trong cửa sổ stagger được +50%.
 * @returns {number} 1.5 nếu đang staggered, 1.0 nếu không
 */
function staggerDamageMult(combat) {
  return (combat.enemyStaggerTurns || 0) > 0
    ? 1 + balance.combatV2.stagger_bonus_damage
    : 1.0;
}

/**
 * §3 Cập nhật thanh Kiên Định sau 1 đòn của player.
 * Lifecycle (turn-based, "giây" của spec → lượt):
 *   - đang staggered → đếm ngược; hết → hồi đầy poise + miễn nhiễm N lượt
 *   - đang miễn nhiễm → đếm ngược, không trừ poise
 *   - bình thường → trừ poise; cạn về 0 → Staggered M lượt
 * @returns {{ broke:boolean, recovered:boolean, staggered:boolean }}
 */
function applyPoiseDamage(combat, poiseDmg) {
  const cfg = balance.combatV2;
  const ev = { broke: false, recovered: false, staggered: (combat.enemyStaggerTurns || 0) > 0 };

  if ((combat.enemyStaggerTurns || 0) > 0) {
    combat.enemyStaggerTurns--;
    if (combat.enemyStaggerTurns <= 0) {
      combat.enemyPoise = combat.enemyPoiseMax;
      combat.enemyImmuneTurns = cfg.stagger_immunity_turns;
      ev.recovered = true;
    }
    return ev;
  }

  if ((combat.enemyImmuneTurns || 0) > 0) {
    combat.enemyImmuneTurns--;
    return ev;
  }

  combat.enemyPoise = Math.max(0, (combat.enemyPoise || 0) - poiseDmg);
  if (combat.enemyPoise <= 0) {
    combat.enemyStaggerTurns = cfg.stagger_duration_turns;
    ev.broke = true;
  }
  return ev;
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
  staggerDamageMult,
  applyPoiseDamage,
  rollDrop
};
