/**
 * lib/game-service.js
 * Tầng logic game thuần (không phụ thuộc Electron/DOM).
 * Nhận repositories + game data, thực thi luật chơi. Test được bằng node.
 */

const balance = require('../config/balance');
const RNGEngine = require('./rng-engine');
const { computeLinhKhiRegen } = require('./time-delta');
const { FSM, STATES, createValidationContext } = require('./fsm');
const CombatEngine = require('./combat');
const EventChain = require('./event-chain');
const Breakthrough = require('./breakthrough');
const Crafting = require('./crafting');
const Sect = require('./sect');
const Metaprogression = require('./metaprogression');
const Items = require('./items');
const Meditation = require('./meditation');
const Achievements = require('./achievements');
const Travel = require('./travel');
const StatsEngine = require('./stats-engine');
const CongPhap = require('./cong-phap');

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
    const accountMeta = this.repos.account.getMetadata();
    const shopPurchases = accountMeta.shopPurchases || {};

    // Tính tiên thiên tổng hợp (level benefits + shop purchases)
    const innateBonuses = Metaprogression.calcInnateBonuses(account, shopPurchases, this.data.shop.items);
    const startRealm = this.data.realmById[giaCanh.startRealm || 'luyen_khi'];

    // Roll 6 Core Attributes (STR/CON/AGI/INT/SPR/LUK)
    const coreAttrs = StatsEngine.rollInitialAttributes(linhCan, giaCanh, this.rng);
    const realmTier = startRealm.order || 1;
    const rootM = StatsEngine.getSpiritRootMultiplier(linhCan);

    // Tính HP/MP bằng công thức mới (có realm scaling)
    const hpMax = StatsEngine.calcMaxHP(
      coreAttrs.con, balance.base.hpMax, realmTier, innateBonuses.innate_hp_pct_bonus,
      (startRealm.hpBonus || 0) + innateBonuses.innate_hp_bonus
    );
    const linhKhiMax = StatsEngine.calcMaxMP(
      coreAttrs.spr, balance.base.linhKhiMax,
      balance.combatV2.dantian_base_cap, rootM, realmTier, innateBonuses.innate_linhkhi_pct_bonus,
      innateBonuses.innate_linhkhi_bonus
    );
    const luck = coreAttrs.luk + innateBonuses.innate_luck_bonus + (giaCanh.startLuckBonus || 0);

    const runData = {
      alive: 1,
      realm_id: startRealm.id,
      realm_stage: 0,
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
      spirit_stones: (giaCanh.startSpiritStones || 0) + innateBonuses.start_spirit_stones,
      fsm_state: STATES.IDLE,
      linh_khi_last_update: nowMs,
      started_at: nowMs,
      monsters_killed: 0,
      run_exp: 0,
      map_state: null,
      metadata: JSON.stringify({ turn: 1, karma: 0, affinity: {}, coreAttrs, rootM })
    };

    const run = this.repos.run.create(runData);

    // Đồ khởi đầu từ gia cảnh
    if (Array.isArray(giaCanh.startItems)) {
      for (const itemId of giaCanh.startItems) {
        this._addItem(itemId, 1);
      }
    }
    // Thêm start items từ shop
    if (innateBonuses.start_items.length > 0) {
      for (const itemId of innateBonuses.start_items) {
        this._addItem(itemId, 1);
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

  // ────────── FSM ──────────

  /**
   * Validate action qua FSM Middleware (CQRS Pipeline: Check 1).
   * Mọi Action Payload phải qua đây TRƯỚC KHI thực thi.
   *
   * Pipeline: Action → FSM Check → Cost Check → Execute → Log Result
   *
   * @param {string} action - Tên action (vd: 'travel', 'attack')
   * @param {object} run - Run state hiện tại
   * @param {object} extraCost - Cost config bổ sung
   * @returns {{ ok: boolean, error?: string }}
   */
  _validateAction(action, run, extraCost = {}) {
    if (!run || run.alive === 0) {
      return { ok: false, error: 'Chưa có kiếp sống. Gõ "start".' };
    }
    const fsm = new FSM(run.fsm_state);
    const context = createValidationContext(run, extraCost);
    return fsm.validateAction(action, context);
  }

  /** Thử chuyển state, persist nếu hợp lệ. */
  transitionState(toState) {
    const run = this.repos.run.get();
    if (!run) return { ok: false, error: 'Chưa có kiếp nào' };
    const fsm = new FSM(run.fsm_state);
    const res = fsm.transition(toState);
    if (res.ok) this.repos.run.update({ fsm_state: res.to });
    return res;
  }

  // ---------- Combat ----------

  /** Lấy combat state hiện tại từ run metadata. */
  getCombatState() {
    const run = this.repos.run.get();
    if (!run) return null;
    return this._getCombat(run);
  }

  /**
   * Bắt đầu combat. Chọn quái từ data enemies theo realm, init combat state.
   * @param {boolean} isBoss
   */
  startCombat(isBoss = false) {
    const run = this.repos.run.get();
    if (!run || run.alive === 0) return { ok: false, error: 'Chưa có kiếp sống' };

    const fsm = new FSM(run.fsm_state);
    const trans = fsm.transition(STATES.COMBAT);
    if (!trans.ok) return { ok: false, error: trans.error };

    const realm = this.data.realmById[run.realm_id];
    const diff = this.difficultyMultiplier(run);
    const { enemy, zone, realmTier: enemyTier } = CombatEngine.pickEnemy(this.data.enemies, realm.order, isBoss, this.rng);

    const combat = CombatEngine.initCombatState(enemy, isBoss ? diff * 1.5 : diff, enemyTier);
    // Populate player V2 metrics cho UI (crit/dodge/glance từ coreAttrs)
    const cpMeta = this._parseMeta(run.metadata) || {};
    const cpAttrs = cpMeta.coreAttrs || { agi: 10, luk: 5 };
    combat.playerCritRate = StatsEngine.calcCritRate(cpAttrs.luk);
    combat.playerDodgeChance = StatsEngine.calcDodgeChance(cpAttrs.agi);
    // Tỉ lệ đòn enemy đánh player bị "sượt": khớp combat thật — enemyTurn để attacker.agi=0,
    // defender.agi=playerAgi → chance sượt = 1 - calcHitProbability(0, playerAgi).
    combat.playerGlanceChance = 1 - StatsEngine.calcHitProbability(0, cpAttrs.agi);
    this.repos.run.update({
      fsm_state: STATES.COMBAT,
      metadata: this._setCombat(run, combat)
    });

    return { ok: true, combat, zone: zone.id };
  }

  /** Trả về run với combat state cho renderer. */
  getCombatView() {
    const run = this.repos.run.get();
    if (!run) return null;
    const combat = this._getCombat(run);
    // Populate player V2 metrics if missing (re-entrant from renderer)
    if (combat && combat.playerCritRate == null) {
      const meta = this._parseMeta(run.metadata) || {};
      const attrs = meta.coreAttrs || { agi: 10, luk: 5 };
      combat.playerCritRate = StatsEngine.calcCritRate(attrs.luk);
      combat.playerDodgeChance = StatsEngine.calcDodgeChance(attrs.agi);
      combat.playerGlanceChance = 1 - StatsEngine.calcHitProbability(0, attrs.agi);
    }
    return {
      run: {
        hp: run.hp, hp_max: run.hp_max,
        linh_khi: run.linh_khi, linh_khi_max: run.linh_khi_max,
        luck: run.luck, fsm_state: run.fsm_state
      },
      combat
    };
  }

  /**
   * Người chơi tấn công thường.
   */
  playerAttack() {
    const run = this.repos.run.get();
    if (!run || run.fsm_state !== STATES.COMBAT) return { ok: false, error: 'Không trong combat' };

    const combat = this._getCombat(run);
    if (!combat) return { ok: false, error: 'Không có combat state' };

    const linhCan = this.data.linhCanById[run.linh_can_id];
    const playerElm = linhCan?.element || null;

    // LK cost for normal attack
    const lkCost = balance.linhKhi.attackCost || 3;
    if (run.linh_khi < lkCost) return { ok: false, error: `Cần ${lkCost} Linh Khí để tấn công (hiện ${run.linh_khi}).` };
    run.linh_khi -= lkCost;

    // Tính equipment bonuses & core attributes
    const equipment = Items.getEquipment(run.metadata);
    const eqBonuses = Items.calcEquipmentBonuses(equipment);
    const meta = JSON.parse(run.metadata || '{}');
    const attrs = meta.coreAttrs || { str: 10, con: 10, agi: 10, int: 10, spr: 10, luk: 5 };
    const realm = this.data.realmById[run.realm_id];
    const realmTier = realm?.order || 1;

    // Công thức STR-based ATK mới
    const baseAtk = StatsEngine.calcRawATK(eqBonuses.attackBonus, attrs.str);

    // Passive công pháp đang chủ tu (damageMult, elementBonus, hpRegen)
    const cpActive = this._getActiveCongPhapMods(meta);
    const cpMods = cpActive?.mods || null;
    const cpDmgMult = cpMods ? cpMods.damageMult * (1 + (cpMods.elementBonus[playerElm] || 0)) : 1;

    // Player -> Enemy (với Realm Suppression)
    const playerDmg = CombatEngine.calculateDamage(
      { attack: baseAtk * cpDmgMult, element: playerElm, realmTier, luk: attrs.luk },
      { defense: combat.enemyDefense * (1 - eqBonuses.damageReduction), element: combat.enemyElement, elemRes: combat.enemyElemRes, realmTier: combat.enemyRealmTier || realmTier },
      this.rng
    );

    // §3 Phá Thể — bonus damage nếu enemy đang Staggered, rồi trừ poise cho đòn này
    const staggerMult = CombatEngine.staggerDamageMult(combat);
    const dealtDmg = Math.round(playerDmg.damage * staggerMult);
    combat.enemyHp -= dealtDmg;
    combat.turn++;
    const poiseEv = CombatEngine.applyPoiseDamage(combat, balance.combatV2.poise_dmg_attack);
    combat.log.push(`⚔️ Bạn tấn công${playerDmg.isCrit ? ' [BẠO KÍCH]' : ''}: -${dealtDmg} HP${staggerMult > 1 ? ' [PHÁ THỂ +50%]' : ''}${playerDmg.elementMultiplier !== 1 ? ` [${elmTag(playerDmg.elementMultiplier)}]` : ''} | Quái còn ${Math.max(0, combat.enemyHp)} HP`);
    if (poiseEv.broke) combat.log.push(`💥 ${combat.enemyName} bị PHÁ THỂ! Mất phòng ngự trong ${balance.combatV2.stagger_duration_turns} lượt.`);
    else if (poiseEv.recovered) combat.log.push(`🛡️ ${combat.enemyName} hồi phục Kiên Định, miễn nhiễm phá thể.`);

    if (cpActive) this._bumpCongPhapProficiency(meta);
    const result = { ok: true, playerAction: { type: 'attack', ...playerDmg, damage: dealtDmg, staggered: staggerMult > 1, poiseBroke: poiseEv.broke } };

    if (combat.enemyHp <= 0) {
      // Lưu LK + metadata trước resolve victory (victory đọc lại DB)
      this.repos.run.update({ linh_khi: run.linh_khi, metadata: cpActive ? JSON.stringify(meta) : this._setCombat(run, combat) });
      const freshRun = this.repos.run.get();
      return this._resolveVictory(freshRun, combat, result);
    }

    // Enemy counter-attack (player né/sượt theo AGI — §2.2; player tier cho §8 áp chế)
    const enemyAct = CombatEngine.enemyTurn(combat, playerElm, this.rng, attrs.agi, realmTier);
    run.hp -= enemyAct.damage;
    combat.log.push(enemyHitLog(combat.enemyName, enemyAct, Math.max(0, run.hp)));
    result.enemyAction = enemyAct;

    // Hồi máu passive (vd Bất Tử Trường Sinh Công)
    if (cpMods && cpMods.hpRegenPct > 0 && run.hp > 0) {
      const heal = Math.round(run.hp_max * cpMods.hpRegenPct);
      run.hp = Math.min(run.hp_max, run.hp + heal);
      combat.log.push(`🌿 Công pháp hồi phục: +${heal} HP | Bạn còn ${run.hp} HP`);
    }

    meta.combat = combat;
    this.repos.run.update({ hp: run.hp, linh_khi: run.linh_khi, metadata: JSON.stringify(meta) });

    if (run.hp <= 0) {
      return this._resolveDefeat(run, combat, result);
    }

    return result;
  }

  /**
   * Người chơi dùng thuật (tốn Linh Khí).
   */
  playerCast() {
    const run = this.repos.run.get();
    if (!run || run.fsm_state !== STATES.COMBAT) return { ok: false, error: 'Không trong combat' };

    const combat = this._getCombat(run);
    if (!combat) return { ok: false, error: 'Không có combat state' };

    const castCost = 20;
    if (run.linh_khi < castCost) return { ok: false, error: `Không đủ Linh Khí (cần ${castCost}, hiện ${run.linh_khi})` };

    run.linh_khi -= castCost;

    const linhCan = this.data.linhCanById[run.linh_can_id];
    const playerElm = linhCan?.element || null;

    const equipment = Items.getEquipment(run.metadata);
    const eqBonuses = Items.calcEquipmentBonuses(equipment);
    const meta = JSON.parse(run.metadata || '{}');
    const attrs = meta.coreAttrs || { str: 10, con: 10, agi: 10, int: 10, spr: 10, luk: 5 };
    const realm = this.data.realmById[run.realm_id];
    const realmTier = realm?.order || 1;

    // Công thức INT-based MATK mới (Thi Pháp dùng INT thay vì STR)
    const baseMAtk = StatsEngine.calcRawMATK(eqBonuses.attackBonus, attrs.int);

    const playerDmg = CombatEngine.calculateDamage(
      { attack: baseMAtk, element: playerElm, realmTier, luk: attrs.luk },
      { defense: combat.enemyDefense * 0.6 * (1 - eqBonuses.damageReduction), element: combat.enemyElement, elemRes: combat.enemyElemRes, realmTier: combat.enemyRealmTier || realmTier },
      this.rng
    );

    // §3 Phá Thể — enemy staggered nhận +50% damage; thi pháp phá poise mạnh hơn đòn thường
    const staggerMult = CombatEngine.staggerDamageMult(combat);
    const castDmg = Math.round(playerDmg.damage * staggerMult);
    combat.enemyHp -= castDmg;
    combat.turn++;
    combat.log.push(`✨ Bạn thi pháp${playerDmg.isCrit ? ' [BẠO KÍCH]' : ''} (-${castCost} LK): -${castDmg} HP${staggerMult > 1 ? ' [PHÁ THỂ +50%]' : ''}${playerDmg.elementMultiplier !== 1 ? ` [${elmTag(playerDmg.elementMultiplier)}]` : ''} | Quái còn ${Math.max(0, combat.enemyHp)} HP`);
    const poiseEv = CombatEngine.applyPoiseDamage(combat, balance.combatV2.poise_dmg_cast);
    if (poiseEv.broke) combat.log.push(`💥 ${combat.enemyName} bị PHÁ THỂ! Chịu thêm 50% sát thương trong ${balance.combatV2.stagger_duration_turns} lượt.`);
    else if (poiseEv.recovered) combat.log.push(`🛡️ ${combat.enemyName} hồi phục Kiên Định, miễn nhiễm phá thể.`);

    const result = { ok: true, playerAction: { type: 'cast', cost: castCost, ...playerDmg, damage: castDmg, staggered: poiseEv.broke } };

    if (combat.enemyHp <= 0) {
      return this._resolveVictory(run, combat, result);
    }

    const enemyAct = CombatEngine.enemyTurn(combat, playerElm, this.rng, attrs.agi, realmTier);
    run.hp -= enemyAct.damage;
    combat.log.push(enemyHitLog(combat.enemyName, enemyAct, Math.max(0, run.hp)));
    result.enemyAction = enemyAct;

    this.repos.run.update({ hp: run.hp, linh_khi: run.linh_khi, metadata: this._setCombat(run, combat) });

    if (run.hp <= 0) {
      return this._resolveDefeat(run, combat, result);
    }

    return result;
  }

  /** Lấy modifier passive của công pháp đang kích hoạt (dùng trong combat). */
  _getActiveCongPhapMods(meta) {
    const cpState = meta?.congPhap;
    if (!cpState || !cpState.activeId) return null;
    const def = this.data.congPhapById[cpState.activeId];
    if (!def) return null;
    const learned = cpState.learned[cpState.activeId];
    return { def, learned, mods: CongPhap.getCombatModifiers(def, learned) };
  }

  /** +1 độ thuần thục cho công pháp đang kích hoạt (gọi sau mỗi đòn/skill). */
  _bumpCongPhapProficiency(meta) {
    const cpState = meta?.congPhap;
    if (!cpState || !cpState.activeId) return false;
    const learned = cpState.learned[cpState.activeId];
    if (!learned) return false;
    learned.proficiency = (learned.proficiency || 0) + 1;
    return true;
  }

  /**
   * Thi triển kỹ năng chủ động của công pháp đang kích hoạt (tốn Linh Khí theo skill).
   */
  castCongPhapSkill(skillId) {
    const run = this.repos.run.get();
    if (!run || run.fsm_state !== STATES.COMBAT) return { ok: false, error: 'Không trong combat' };

    const combat = this._getCombat(run);
    if (!combat) return { ok: false, error: 'Không có combat state' };

    const meta = this._parseMeta(run.metadata) || {};
    const active = this._getActiveCongPhapMods(meta);
    if (!active) return { ok: false, error: 'Chưa kích hoạt công pháp nào.' };

    const skill = CongPhap.findSkill(active.def, skillId);
    if (!skill) return { ok: false, error: `Công pháp đang dùng không có kỹ năng "${skillId}".` };

    const evolvedScale = active.learned?.evolved ? CongPhap.EVOLVED_MULT : 1;
    const lkCost = Math.round(skill.lkCost / evolvedScale); // tiến hóa giảm phí
    if (run.linh_khi < lkCost) return { ok: false, error: `Không đủ Linh Khí (cần ${lkCost}, hiện ${run.linh_khi}).` };
    run.linh_khi -= lkCost;

    const attrs = meta.coreAttrs || { int: 10, luk: 5 };
    const realm = this.data.realmById[run.realm_id];
    const realmTier = realm?.order || 1;

    // Sát thương skill = damage cơ bản scale theo tiến hóa, đi qua công thức nguyên tố/phòng ngự.
    const skillAtk = skill.damage * evolvedScale;
    const playerDmg = CombatEngine.calculateDamage(
      { attack: skillAtk, element: skill.element, realmTier, luk: attrs.luk },
      { defense: combat.enemyDefense * 0.6, element: combat.enemyElement, elemRes: combat.enemyElemRes, realmTier: combat.enemyRealmTier || realmTier },
      this.rng
    );

    const staggerMult = CombatEngine.staggerDamageMult(combat);
    const dealt = Math.round(playerDmg.damage * staggerMult);
    combat.enemyHp -= dealt;
    combat.turn++;
    combat.log.push(`🌀 ${skill.ten}${playerDmg.isCrit ? ' [BẠO KÍCH]' : ''} (-${lkCost} LK): -${dealt} HP${staggerMult > 1 ? ' [PHÁ THỂ +50%]' : ''}${playerDmg.elementMultiplier !== 1 ? ` [${elmTag(playerDmg.elementMultiplier)}]` : ''} | Quái còn ${Math.max(0, combat.enemyHp)} HP`);
    CombatEngine.applyPoiseDamage(combat, balance.combatV2.poise_dmg_cast);

    this._bumpCongPhapProficiency(meta);
    const result = { ok: true, playerAction: { type: 'cong_phap_skill', skillId, ten: skill.ten, cost: lkCost, ...playerDmg, damage: dealt } };

    if (combat.enemyHp <= 0) {
      // lưu proficiency + LK trước khi resolve victory (victory dọn combat nhưng giữ blob)
      this.repos.run.update({ linh_khi: run.linh_khi, metadata: JSON.stringify(meta) });
      const freshRun = this.repos.run.get();
      return this._resolveVictory(freshRun, combat, result);
    }

    const linhCan = this.data.linhCanById[run.linh_can_id];
    const playerElm = linhCan?.element || null;
    const enemyAct = CombatEngine.enemyTurn(combat, playerElm, this.rng, attrs.agi, realmTier);
    run.hp -= enemyAct.damage;
    combat.log.push(enemyHitLog(combat.enemyName, enemyAct, Math.max(0, run.hp)));
    result.enemyAction = enemyAct;

    // ghi cả proficiency (meta) lẫn combat state
    meta.combat = combat;
    this.repos.run.update({ hp: run.hp, linh_khi: run.linh_khi, metadata: JSON.stringify(meta) });

    if (run.hp <= 0) {
      return this._resolveDefeat(run, combat, result);
    }
    return result;
  }

  /**
   * Bỏ chạy (Luck-based).
   */
  playerFlee() {
    const run = this.repos.run.get();
    if (!run || run.fsm_state !== STATES.COMBAT) return { ok: false, error: 'Không trong combat' };

    const combat = this._getCombat(run);
    if (!combat) return { ok: false, error: 'Không có combat state' };

    const fleeChance = 0.3 + run.luck / 200; // 30% base + luck bonus
    const success = this.rng() < fleeChance;

    if (success) {
      combat.log.push('🏃 Bạn chạy thoát thành công!');
      this.repos.run.update({ fsm_state: STATES.IDLE, metadata: this._clearCombat(run) });
      return { ok: true, result: 'fled', combat };
    }

    const linhCan = this.data.linhCanById[run.linh_can_id];
    const playerElm = linhCan?.element || null;
    const fleeRealmTier = this.data.realmById[run.realm_id]?.order || 1;
    const enemyAct = CombatEngine.enemyTurn(combat, playerElm, this.rng, null, fleeRealmTier);
    run.hp -= enemyAct.damage;
    combat.turn++;
    combat.log.push('🏃 Chạy thất bại!');
    combat.log.push(`👊 ${combat.enemyName} tấn công: -${enemyAct.damage} HP | Bạn còn ${Math.max(0, run.hp)} HP`);

    this.repos.run.update({ hp: run.hp, metadata: this._setCombat(run, combat) });

    if (run.hp <= 0) {
      return this._resolveDefeat(run, combat, { ok: true, result: 'flee_failed', enemyAction: enemyAct });
    }

    return { ok: true, result: 'flee_failed', enemyAction: enemyAct };
  }

  /**
   * Cấm thuật — hy sinh HP+Linh Khí để gây sát thương lớn, có tỉ lệ phản phệ.
   */
  playerForbiddenArt() {
    const run = this.repos.run.get();
    if (!run || run.fsm_state !== STATES.COMBAT) return { ok: false, error: 'Không trong combat' };

    const combat = this._getCombat(run);
    if (!combat) return { ok: false, error: 'Không có combat state' };

    const hpCost = Math.floor(run.hp_max * 0.2);
    const lkCost = 30;
    if (run.hp <= hpCost) return { ok: false, error: `HP không đủ (cần ${hpCost}, hiện ${run.hp})` };
    if (run.linh_khi < lkCost) return { ok: false, error: `Linh Khí không đủ (cần ${lkCost}, hiện ${run.linh_khi})` };

    run.hp -= hpCost;
    run.linh_khi -= lkCost;

    const backlashChance = 0.2 - run.luck / 500; // luck giảm tỉ lệ phản phệ
    const backfired = this.rng() < Math.max(0.05, backlashChance);

    combat.turn++;
    const result = { ok: true, playerAction: { type: 'forbidden_art', hpCost, lkCost } };

    if (backfired) {
      const selfDmg = Math.floor(run.hp_max * 0.15);
      run.hp -= selfDmg;
      combat.log.push(`💀 Cấm thuật phản phệ: -${hpCost} HP, -${lkCost} LK, phản sát: -${selfDmg} HP | Bạn còn ${Math.max(0, run.hp)} HP`);
      result.playerAction.damage = 0;
      result.playerAction.backfired = true;
      result.playerAction.selfDamage = selfDmg;

      this.repos.run.update({ hp: run.hp, linh_khi: run.linh_khi, metadata: this._setCombat(run, combat) });

      if (run.hp <= 0) {
        return this._resolveDefeat(run, combat, result);
      }
      return result;
    }

    const equipment = Items.getEquipment(run.metadata);
    const eqBonuses = Items.calcEquipmentBonuses(equipment);

    const playerDmg = CombatEngine.calculateDamage(
      { attack: run.linh_khi_max * 0.8 + eqBonuses.attackBonus, element: null },
      { defense: combat.enemyDefense * 0.2 * (1 - eqBonuses.damageReduction), element: combat.enemyElement },
      this.rng
    );

    combat.enemyHp -= playerDmg.damage;
    combat.log.push(`☠️ CẤM THUẬT (-${hpCost} HP, -${lkCost} LK): -${playerDmg.damage} HP | Quái còn ${Math.max(0, combat.enemyHp)} HP`);
    result.playerAction = { ...result.playerAction, ...playerDmg, backfired: false };

    if (combat.enemyHp <= 0) {
      return this._resolveVictory(run, combat, result);
    }

    const linhCan = this.data.linhCanById[run.linh_can_id];
    const playerElm = linhCan?.element || null;
    const fbRealmTier = this.data.realmById[run.realm_id]?.order || 1;
    const enemyAct = CombatEngine.enemyTurn(combat, playerElm, this.rng, null, fbRealmTier);
    run.hp -= enemyAct.damage;
    combat.log.push(`👊 ${combat.enemyName} phản công: -${enemyAct.damage} HP | Bạn còn ${Math.max(0, run.hp)} HP`);
    result.enemyAction = enemyAct;

    this.repos.run.update({ hp: run.hp, linh_khi: run.linh_khi, metadata: this._setCombat(run, combat) });

    if (run.hp <= 0) {
      return this._resolveDefeat(run, combat, result);
    }

    return result;
  }

  // ---------- Private combat helpers ----------

  _rollManualDrop(combat) {
    const r = this.rng ? this.rng() : Math.random();
    let rarity = null;
    if (r < 0.0001) rarity = 'mythic';
    else if (r < 0.001) rarity = 'legendary';
    else if (r < 0.005) rarity = 'epic';
    else if (r < 0.02) rarity = 'rare';
    else if (r < 0.05) rarity = 'common';

    if (!rarity) return null;

    const manuals = Object.keys(this.data.itemDefs)
      .map(k => ({ id: k, ...this.data.itemDefs[k] }))
      .filter(item => item.slot === 'manual' && item.rarity === rarity);
    
    if (manuals.length === 0) return null;
    const dropped = manuals[Math.floor((this.rng ? this.rng() : Math.random()) * manuals.length)];

    this._addItem(dropped.id, 1);

    return dropped;
  }

  /** Tìm enemy def (kể cả boss) theo id trong toàn bộ zones. */
  _findEnemyDef(enemyId) {
    for (const zone of this.data.enemies) {
      const e = zone.enemies?.find(en => en.id === enemyId);
      if (e) return e;
      if (zone.boss?.id === enemyId) return zone.boss;
    }
    return null;
  }

  /** Roll bảng loot của enemy (đọc dropTable từ enemies.json). Trả mảng item đã nhặt. */
  _rollLootTable(combat) {
    const enemyDef = this._findEnemyDef(combat.enemyId);
    if (!enemyDef || !Array.isArray(enemyDef.dropTable)) return [];

    const dropped = [];
    for (const entry of enemyDef.dropTable) {
      if ((this.rng ? this.rng() : Math.random()) < (entry.chance || 0)) {
        const qty = entry.qtyMax && entry.qtyMax > 1
          ? 1 + Math.floor((this.rng ? this.rng() : Math.random()) * entry.qtyMax)
          : 1;
        this._addItem(entry.itemId, qty);
        const def = this.data.itemDefs[entry.itemId];
        dropped.push({ id: entry.itemId, name: def?.name || entry.itemId, qty });
      }
    }
    return dropped;
  }

  _resolveVictory(run, combat, result) {
    const stones = CombatEngine.rollDrop(combat.dropStones, this.rng);
    run.spirit_stones += stones;
    run.monsters_killed += 1;

    const droppedManual = this._rollManualDrop(combat);
    const droppedLoot = this._rollLootTable(combat);

    // Run EXP — tích lũy trong kiếp
    const expGain = combat.expReward || balance.runExp.combatBase;
    run.run_exp = (run.run_exp || 0) + expGain;
    
    let logMsg = `🎉 Chiến thắng! +${expGain} EXP, +${stones} Linh Thạch`;
    if (droppedManual) {
      logMsg += `\n🎁 Nhận được Công Pháp: [${droppedManual.name}] (${droppedManual.rarity})`;
    }
    for (const loot of droppedLoot) {
      logMsg += `\n🎁 Nhận được: [${loot.name}]${loot.qty > 1 ? ` x${loot.qty}` : ''}`;
    }
    combat.log.push(logMsg);

    // Kiểm tra level-up trong kiếp
    let leveledUp = false;
    let runLevel = 0;
    const thresholds = balance.runExp.levelThresholds;
    for (let i = 0; i < thresholds.length; i++) {
      if (run.run_exp >= thresholds[i]) runLevel = i + 1;
    }
    const prevRunLevel = run._runLevel || 0;
    if (runLevel > prevRunLevel) {
      leveledUp = true;
      run._runLevel = runLevel;
      run.hp_max += balance.runExp.hpBonusPerLevel;
      run.hp = Math.min(run.hp_max, run.hp + balance.runExp.hpBonusPerLevel);
      run.linh_khi_max += balance.runExp.lkBonusPerLevel;
      run.linh_khi = Math.min(run.linh_khi_max, run.linh_khi + balance.runExp.lkBonusPerLevel);
      combat.log.push(`⬆️ THĂNG CẤP TRONG KIẾP! Run Lv.${runLevel} — HP+${balance.runExp.hpBonusPerLevel}, LK+${balance.runExp.lkBonusPerLevel}`);
    }

    this.repos.run.update({
      hp: run.hp, hp_max: run.hp_max,
      linh_khi: run.linh_khi, linh_khi_max: run.linh_khi_max,
      spirit_stones: run.spirit_stones,
      monsters_killed: run.monsters_killed,
      run_exp: run.run_exp,
      fsm_state: STATES.IDLE,
      metadata: this._clearCombat(run)
    });

    result.victory = true;
    result.rewards = { spiritStones: stones, expReward: expGain, runLevel, leveledUp };
    result.run = {
      hp: run.hp, hp_max: run.hp_max,
      linh_khi: run.linh_khi, linh_khi_max: run.linh_khi_max,
      spirit_stones: run.spirit_stones,
      monsters_killed: run.monsters_killed,
      run_exp: run.run_exp, runLevel
    };
    return result;
  }

  _resolveDefeat(run, combat, result) {
    combat.log.push('💀 Bạn đã tử trận!');
    this.repos.run.update({
      hp: 0,
      fsm_state: STATES.DEAD,
      alive: 0,
      metadata: this._setCombat(run, combat)
    });
    result.defeat = true;
    result.combat = combat;
    return result;
  }

  // ---------- Event System ----------

  // ────────── Stage-Up (Tăng Tiểu Tầng) ──────────

  /** Kiểm tra có thể tăng tiểu tầng không. */
  canStageUp() {
    const run = this.repos.run.get();
    if (!run || run.alive === 0) return { ok: false, error: 'Chưa có kiếp sống.' };
    if (run.fsm_state !== STATES.IDLE) return { ok: false, error: `Không thể tăng tầng khi ${run.fsm_state}.` };

    const realm = this.data.realmById[run.realm_id];
    const linhCan = this.data.linhCanById[run.linh_can_id];
    const artifactCount = this._countArtifacts();

    const result = Breakthrough.calcStageUpChance(realm, run, linhCan, artifactCount);
    result.ok = true;
    result.realmName = realm.name;
    result.currentStage = (run.realm_stage || 0) + 1;
    return result;
  }

  /** Thực hiện tăng tiểu tầng. */
  attemptStageUp() {
    const run = this.repos.run.get();
    if (!run || run.alive === 0) return { ok: false, error: 'Chưa có kiếp sống.' };
    if (run.fsm_state !== STATES.IDLE) return { ok: false, error: `Không thể tăng tầng khi ${run.fsm_state}.` };

    const realm = this.data.realmById[run.realm_id];
    const linhCan = this.data.linhCanById[run.linh_can_id];
    const artifactCount = this._countArtifacts();

    const result = Breakthrough.attemptStageUp(realm, run, linhCan, artifactCount, this.rng);
    if (!result.canAttempt) return { ok: false, error: result.reason };

    // Trừ Tu Vi cost
    run.tu_vi = Math.max(0, run.tu_vi - result.cost.tuVi);

    let statPointsGained = 0;
    if (result.success) {
      run.realm_stage = result.newStage;
      run.hp_max += result.hpBonus;
      run.hp += result.hpBonus;
      run.linh_khi_max += result.lkBonus;
      run.linh_khi += result.lkBonus;
      statPointsGained = balance.coreAttributes.stat_points_per_stage || 0;
    } else if (result.damage) {
      run.hp = Math.max(0, run.hp - result.damage.hp);
    }

    const meta = this._parseMeta(run.metadata) || {};
    if (statPointsGained && meta.coreAttrs) {
      meta.coreAttrs.free_points = (meta.coreAttrs.free_points || 0) + statPointsGained;
    }

    this.repos.run.update({
      tu_vi: run.tu_vi,
      realm_stage: run.realm_stage,
      hp: run.hp, hp_max: run.hp_max,
      linh_khi: run.linh_khi, linh_khi_max: run.linh_khi_max,
      metadata: JSON.stringify(meta)
    });

    return { ok: true, ...result, hp: run.hp, tu_vi: run.tu_vi, realm_stage: run.realm_stage, statPointsGained };
  }

  /** Cộng 1 điểm tự do vào 1 thuộc tính. CON→HP max, SPR→LK max, LUK→luck được tính lại cận biên. */
  spendStatPoint(attr) {
    const run = this.repos.run.get();
    if (!run || run.alive === 0) return { ok: false, error: 'Chưa có kiếp sống.' };

    const valid = ['str', 'con', 'agi', 'int', 'spr', 'luk'];
    if (!valid.includes(attr)) return { ok: false, error: `Thuộc tính không hợp lệ: ${attr}` };

    const meta = this._parseMeta(run.metadata) || {};
    const attrs = meta.coreAttrs;
    if (!attrs) return { ok: false, error: 'Không có dữ liệu thuộc tính.' };
    if ((attrs.free_points || 0) <= 0) return { ok: false, error: 'Không còn điểm tự do.' };

    attrs.free_points -= 1;
    attrs[attr] = (attrs[attr] || 0) + 1;

    const realm = this.data.realmById[run.realm_id];
    const realmTier = realm?.order || 1;
    const beta = StatsEngine.calcRealmMultiplier(realmTier);
    const updates = { metadata: JSON.stringify(meta) };

    // CON/SPR/LUK đổi chỉ số dẫn xuất — cộng phần cận biên đúng theo công thức StatsEngine.
    if (attr === 'con') {
      const dHp = Math.round(balance.coreAttributes.alpha_con * beta);
      run.hp_max += dHp; run.hp += dHp;
      updates.hp_max = run.hp_max; updates.hp = run.hp;
    } else if (attr === 'spr') {
      const lnFactor = 1 + Math.log((meta.rootM || 1) + 1);
      const dLk = Math.round(balance.coreAttributes.alpha_spr * balance.combatV2.dantian_base_cap * lnFactor * beta);
      run.linh_khi_max += dLk; run.linh_khi += dLk;
      updates.linh_khi_max = run.linh_khi_max; updates.linh_khi = run.linh_khi;
    } else if (attr === 'luk') {
      run.luck += 1;
      updates.luck = run.luck;
    }

    this.repos.run.update(updates);
    return { ok: true, attr, newValue: attrs[attr], freePoints: attrs.free_points, attrs };
  }

  /** Trả về thuộc tính + điểm tự do cho renderer. */
  getAttributesView() {
    const run = this.repos.run.get();
    if (!run) return null;
    const meta = this._parseMeta(run.metadata) || {};
    return meta.coreAttrs || null;
  }

  // ────────── Breakthrough / Tribulation ──────────

  /** Kiểm tra điều kiện đột phá. */
  canBreakthrough() {
    const run = this.repos.run.get();
    if (!run || run.alive === 0) return { ok: false, error: 'Chưa có kiếp sống.' };
    if (run.fsm_state !== STATES.IDLE) return { ok: false, error: `Không thể đột phá khi đang ${run.fsm_state}.` };

    const realm = this.data.realmById[run.realm_id];
    const linhCan = this.data.linhCanById[run.linh_can_id];
    const artifactCount = this._countArtifacts();

    const result = Breakthrough.calcBreakthroughChance(realm, run, linhCan, artifactCount);
    result.ok = true;
    result.realmName = realm.name;
    result.nextRealm = Breakthrough.getNextRealm(run.realm_id, this.data.realms, this.data.realmById);
    return result;
  }

  /** Thực hiện đột phá. */
  attemptBreakthrough() {
    const run = this.repos.run.get();
    if (!run || run.alive === 0) return { ok: false, error: 'Chưa có kiếp sống.' };

    const realm = this.data.realmById[run.realm_id];
    const linhCan = this.data.linhCanById[run.linh_can_id];
    const artifactCount = this._countArtifacts();

    const result = Breakthrough.attemptBreakthrough(realm, run, linhCan, artifactCount, this.rng);
    if (!result.canAttempt) return { ok: false, error: result.reason };

    // Consume Linh Khí cost
    run.linh_khi = Math.max(0, run.linh_khi - result.cost.lk);

    if (result.success) {
      // Đột phá thành công tiêu hao Tu Vi tích lũy (chi phí đột phá theo realm).
      run.tu_vi = Math.max(0, run.tu_vi - (realm.breakthrough.tuViRequired || 0));

      if (result.tribulation) {
        // Có thiên kiếp — chuyển sang TRIBULATION state, lưu tribulation state.
        // Giữ nguyên blob bền vững (coreAttrs/rootM/congPhap...), chỉ thêm trạng thái tạm.
        run.fsm_state = STATES.TRIBULATION;
        const meta = this._parseMeta(run.metadata) || {};
        meta.nextRealmId = Breakthrough.getNextRealm(run.realm_id, this.data.realms, this.data.realmById)?.id;
        meta.tribulation = result.tribulation;
        this.repos.run.update({ tu_vi: run.tu_vi, linh_khi: run.linh_khi, fsm_state: STATES.TRIBULATION, metadata: JSON.stringify(meta) });
        return { ok: true, success: true, tribulation: true, strikes: result.tribulation.strikes, damagePerStrike: result.tribulation.damagePerStrike, message: result.message };
      }

      // Không thiên kiếp — advance realm ngay (tu_vi đã trừ, _advanceRealm persist tiếp)
      this._advanceRealm(run, result);
      return { ok: true, success: true, tribulation: false, newRealm: run.realm_id, message: result.message };
    }

    // Thất bại
    run.hp = Math.max(0, run.hp - (result.damage?.hp || 0));
    run.linh_khi = Math.max(0, run.linh_khi - (result.damage?.lkLost || 0));

    if (result.tauHoa && run.hp <= 0) {
      run.fsm_state = STATES.DEAD;
      run.alive = 0;
    }

    this.repos.run.update({ hp: run.hp, linh_khi: run.linh_khi, fsm_state: run.fsm_state, alive: run.alive });
    return { ok: true, success: false, tauHoa: result.tauHoa || false, message: result.message, hp: run.hp, linh_khi: run.linh_khi, successRate: result.successRate };
  }

  /** Chịu 1 đợt thiên kiếp. */
  endureTribulation() {
    const run = this.repos.run.get();
    if (!run || run.fsm_state !== STATES.TRIBULATION) return { ok: false, error: 'Không trong thiên kiếp.' };

    const meta = this._parseMeta(run.metadata);
    if (!meta || !meta.tribulation) return { ok: false, error: 'Không có trạng thái thiên kiếp.' };

    const artifactCount = this._countArtifacts();
    // processTribulationStrike mutate meta.tribulation tại chỗ (giảm strikesRemaining,
    // cộng totalDamageTaken). KHÔNG gán đè meta.tribulation = strikeResult — sẽ mất
    // damagePerStrike/strikes khiến đạo kế tiếp tính NaN → crash NOT NULL khi ghi hp.
    const tribState = meta.tribulation;

    // Vá save cũ bị hỏng (state thiên kiếp thiếu/ NaN field do bug ghi đè trước đây):
    // tính lại từ realm config + chỉ số hiện tại để không crash khi ghi hp.
    const realm = this.data.realmById[run.realm_id];
    if (!Number.isFinite(tribState.damagePerStrike) || tribState.damagePerStrike <= 0) {
      const mitigation = Math.min(0.9, artifactCount * balance.breakthrough.artifactTribulationReduction);
      tribState.damagePerStrike = StatsEngine.calcTribulationDamage(run.hp_max, run.luck, mitigation);
    }
    if (!Number.isFinite(tribState.strikes) || tribState.strikes <= 0) {
      tribState.strikes = realm?.breakthrough?.tribulationStrikes || 3;
    }
    if (!Number.isFinite(tribState.strikesRemaining) || tribState.strikesRemaining < 0) {
      tribState.strikesRemaining = tribState.strikes;
    }
    if (!Number.isFinite(tribState.totalDamageTaken)) tribState.totalDamageTaken = 0;

    const strikeResult = Breakthrough.processTribulationStrike(tribState, run.hp, artifactCount, this.rng);

    if (!strikeResult.survived) {
      // Chết trong thiên kiếp
      run.hp = 0;
      run.fsm_state = STATES.DEAD;
      run.alive = 0;
      this.repos.run.update({ hp: 0, fsm_state: STATES.DEAD, alive: 0, metadata: null });
      return { ok: true, died: true, strikeNumber: strikeResult.strikeNumber, damage: strikeResult.damage, message: `Thiên kiếp đạo thứ ${strikeResult.strikeNumber}: -${strikeResult.damage} HP. Bạn đã tử vong dưới lôi kiếp!` };
    }

    run.hp = strikeResult.playerHpAfter;
    this.repos.run.update({ hp: run.hp, metadata: JSON.stringify(meta) });

    if (strikeResult.tribulationOver) {
      // Sống sót toàn bộ thiên kiếp — advance realm
      this._advanceRealm(run, { tribulation: tribState });
      return { ok: true, tribulationOver: true, survived: true, strikeNumber: strikeResult.strikeNumber, damage: strikeResult.damage, hp: run.hp, newRealm: run.realm_id, message: `Đạo ${strikeResult.strikeNumber}/${tribState.strikes}: -${strikeResult.damage} HP. THIÊN KIẾP ĐÃ QUA! Chúc mừng đột phá thành công!` };
    }

    return { ok: true, tribulationOver: false, strikeNumber: strikeResult.strikeNumber, strikesRemaining: strikeResult.strikesRemaining, damage: strikeResult.damage, hp: run.hp, message: `Đạo ${strikeResult.strikeNumber}/${tribState.strikes}: -${strikeResult.damage} HP. Còn ${strikeResult.strikesRemaining} đạo.` };
  }

  _advanceRealm(run, btResult) {
    const nextRealm = Breakthrough.getNextRealm(run.realm_id, this.data.realms, this.data.realmById);
    if (!nextRealm) return;

    // linhKhiMax trong data là giá trị nền TUYỆT ĐỐI của mỗi realm. Cộng phần CHÊNH LỆCH
    // (delta) giữa realm mới và cũ thay vì gán đè, để giữ đầu tư SPR + đan vĩnh viễn
    // (đối xứng với hp_max vốn cộng dồn hpBonus). Gán đè sẽ xóa sạch các khoản này.
    const prevRealm = this.data.realmById[run.realm_id];
    const lkBaseDelta = nextRealm.linhKhiMax - (prevRealm?.linhKhiMax || 0);

    run.realm_id = nextRealm.id;
    run.realm_stage = 0;
    run.hp_max = run.hp_max + nextRealm.hpBonus;
    run.hp = run.hp_max; // full heal on breakthrough
    run.linh_khi_max = run.linh_khi_max + lkBaseDelta;
    run.linh_khi = run.linh_khi_max;
    run.tuoi_tho_max = nextRealm.tuoiThoMax;
    run.tuoi_tho = Math.min(run.tuoi_tho, run.tuoi_tho_max);
    run.fsm_state = STATES.IDLE;
    // Giữ blob bền vững (coreAttrs/equipment/sect...), chỉ xóa trạng thái tạm thiên kiếp/combat.
    const advMeta = this._parseMeta(run.metadata) || {};
    delete advMeta.tribulation;
    delete advMeta.combat;
    if (advMeta.coreAttrs) {
      advMeta.coreAttrs.free_points = (advMeta.coreAttrs.free_points || 0) + (balance.coreAttributes.stat_points_per_realm || 0);
    }
    run.metadata = JSON.stringify(advMeta);

    this.repos.run.update({
      realm_id: run.realm_id, hp: run.hp, hp_max: run.hp_max,
      linh_khi: run.linh_khi, linh_khi_max: run.linh_khi_max,
      tu_vi: run.tu_vi,
      tuoi_tho: run.tuoi_tho, tuoi_tho_max: run.tuoi_tho_max,
      fsm_state: STATES.IDLE, metadata: run.metadata
    });

    // Track breakthrough stats
    const accountMeta = this.repos.account.getMetadata();
    accountMeta.breakthroughs = (accountMeta.breakthroughs || 0) + 1;
    if (btResult.tribulation) {
      accountMeta.tribulations = (accountMeta.tribulations || 0) + 1;
    }
    if (nextRealm && nextRealm.order > (accountMeta.bestRealm || 0)) {
      accountMeta.bestRealm = nextRealm.order;
    }
    this.repos.account.updateMetadata(accountMeta);


  }

  /** Thêm item vào túi — tự tra itemDefs để set item_name đúng + stackable cho consumable. */
  _addItem(itemId, qty = 1) {
    // itemId có thể là composite "baseId@quality" — lookup def theo baseId,
    // nhưng giữ composite làm item_id để stack tách theo phẩm chất.
    const { baseId, qualityId } = Items.parseItemId(itemId);
    const def = this.data.itemDefs[baseId];
    const tier = Items.getQualityTier(qualityId);
    const name = def?.name || baseId;
    this.repos.inventory.add({
      item_id: itemId,
      item_name: tier ? `${name} (${tier.name})` : name,
      quantity: qty,
      stackable: def?.type === 'consumable'
    });
  }

  /** Bỏ vật phẩm khỏi túi. qty = số lượng hoặc 'all' để bỏ cả stack. */
  dropItem(itemId, qty = 1) {
    const run = this.repos.run.get();
    if (!run) return { ok: false, error: 'Chưa có kiếp sống.' };
    const slot = this.repos.inventory.all().find(i => i.item_id === itemId);
    if (!slot) return { ok: false, error: 'Không có vật phẩm này trong túi.' };
    const n = qty === 'all' ? slot.quantity : Math.min(Math.max(1, qty), slot.quantity);
    this.repos.inventory.decrement(itemId, n);
    const def = Items.getItemDef(this.data.itemDefs, itemId);
    return { ok: true, message: `Đã bỏ ${n}x ${def?.name || itemId}.`, dropped: n };
  }

  _parseMeta(json) { if (!json) return null; try { return JSON.parse(json); } catch { return null; } }

  // ── Combat state lồng trong metadata ──
  // metadata là blob bền vững (coreAttrs/equipment/sect/karma...). Combat state là
  // trạng thái tạm — lồng dưới key .combat để không xóa mất dữ liệu bền vững khi vào/ra trận.
  _getCombat(run) {
    const meta = this._parseMeta(run.metadata) || {};
    return meta.combat || null;
  }
  _setCombat(run, combat) {
    const meta = this._parseMeta(run.metadata) || {};
    meta.combat = combat;
    return JSON.stringify(meta);
  }
  _clearCombat(run) {
    const meta = this._parseMeta(run.metadata) || {};
    delete meta.combat;
    return JSON.stringify(meta);
  }
  _countArtifacts() {
    const inv = this.repos.inventory.all();
    // Tất cả item có thể giảm thiên kiếp hoặc tăng đột phá
    const artifactIds = [
      'phap_bao_so_cap', 'phap_bao_trung_cap', 'ky_bao_ha_pham', 'pha_gioi_dan',
      'thanh_phong_kiem', 'hac_am_chuy', 'tien_thien_kiem',
      'hoang_giap', 'bat_dai_giap',
      'han_ngoc', 'tien_thien_linh_chau', 'thien_pha_dan'
    ];
    return inv.filter(i => artifactIds.includes(i.item_id)).reduce((s, i) => s + i.quantity, 0);
  }

  // ---------- Crafting ----------

  getCraftingRecipes(category) {
    const run = this.repos.run.get();
    if (!run) return [];
    return Crafting.getAvailableRecipes(this.data.recipes, category || null, run.tu_vi);
  }

  craftItem(recipeId) {
    const run = this.repos.run.get();
    if (!run) return { ok: false, error: 'Chưa có kiếp sống.' };

    const recipe = this.data.recipes.find(r => r.id === recipeId);
    if (!recipe) return { ok: false, error: `Không tìm thấy recipe: ${recipeId}` };

    const meta = this._parseMeta(run.metadata) || {};
    const attrs = meta.coreAttrs || { int: 10 };
    const result = Crafting.craftItem(recipe, run, run.luck, this.rng, attrs.int);
    if (!result.ok) return result;

    // Trừ Linh Thạch
    run.spirit_stones -= result.cost.spiritStones;

    if (result.success) {
      // Phẩm chất (luyện đan) → gắn composite id để stack tách theo phẩm.
      const itemId = result.quality ? `${result.item}@${result.quality.id}` : result.item;
      this._addItem(itemId, result.quantity);
      // Track craft count
      const accountMeta = this.repos.account.getMetadata();
      accountMeta.craftCount = (accountMeta.craftCount || 0) + 1;
      this.repos.account.updateMetadata(accountMeta);
    }

    this.repos.run.update({ spirit_stones: run.spirit_stones });
    return result;
  }

  // ---------- Tông Môn ----------

  getSectState() {
    const run = this.repos.run.get();
    if (!run) return null;
    const meta = this._parseMeta(run.metadata);
    return meta?.sect || null;
  }

  listSects() {
    const run = this.repos.run.get();
    if (!run) return [];
    const linhCan = this.data.linhCanById[run.linh_can_id];
    return Sect.getAvailableSects(this.data.sects, run, linhCan);
  }

  joinSect(sectId) {
    const run = this.repos.run.get();
    if (!run) return { ok: false, error: 'Chưa có kiếp sống.' };

    const sect = this.data.sects.find(s => s.id === sectId);
    if (!sect) return { ok: false, error: `Không tìm thấy tông môn: ${sectId}` };

    const linhCan = this.data.linhCanById[run.linh_can_id];
    const realm = this.data.realmById[run.realm_id];
    const canJoin = Sect.canJoinSect(sect, run, linhCan, realm.order);
    if (!canJoin.ok) return canJoin;

    // Lưu sect state vào metadata
    const meta = this._parseMeta(run.metadata) || {};
    meta.sect = Sect.createSectState(sectId);
    meta.sect.joinedAt = Date.now();

    this.repos.run.update({ metadata: JSON.stringify(meta) });
    return { ok: true, sect: sect.name, message: `Đã gia nhập ${sect.name}!` };
  }

  leaveSect() {
    const run = this.repos.run.get();
    if (!run) return { ok: false, error: 'Chưa có kiếp sống.' };

    const meta = this._parseMeta(run.metadata) || {};
    if (!meta.sect) return { ok: false, error: 'Chưa gia nhập tông môn nào.' };

    const sect = this.data.sects.find(s => s.id === meta.sect.sectId);
    delete meta.sect;
    this.repos.run.update({ metadata: JSON.stringify(meta) });
    return { ok: true, message: `Đã rời khỏi ${sect?.name || 'tông môn'}.` };
  }

  contribute(amount) {
    const run = this.repos.run.get();
    if (!run) return { ok: false, error: 'Chưa có kiếp sống.' };

    const meta = this._parseMeta(run.metadata) || {};
    if (!meta.sect) return { ok: false, error: 'Chưa gia nhập tông môn nào.' };

    if (amount <= 0 || amount > run.spirit_stones) {
      return { ok: false, error: `Số Linh Thạch không hợp lệ (có ${run.spirit_stones}).` };
    }

    run.spirit_stones -= amount;
    meta.sect.contribution += amount;

    const sect = this.data.sects.find(s => s.id === meta.sect.sectId);
    const oldRank = Sect.getCurrentRank(sect, meta.sect.contribution - amount);
    const newRank = Sect.getCurrentRank(sect, meta.sect.contribution);

    this.repos.run.update({ spirit_stones: run.spirit_stones, metadata: JSON.stringify(meta) });

    const rankedUp = oldRank.name !== newRank.name;
    return { ok: true, contribution: meta.sect.contribution, rank: newRank.name, rankedUp, message: rankedUp ? `⬆️ Thăng cấp: ${newRank.name}!` : `Đã cống hiến ${amount} Linh Thạch.` };
  }

  // ---------- Công Pháp ----------

  _getCongPhapState(meta) {
    return meta?.congPhap || CongPhap.createState();
  }

  /** Danh sách công pháp + trạng thái học được / điều kiện. */
  listCongPhap() {
    const run = this.repos.run.get();
    if (!run) return [];
    const meta = this._parseMeta(run.metadata) || {};
    const cpState = this._getCongPhapState(meta);
    const learnedIds = Object.keys(cpState.learned);
    const realm = this.data.realmById[run.realm_id];
    const linhCan = this.data.linhCanById[run.linh_can_id];
    const ctx = {
      realmOrder: realm?.order || 1,
      linhCanElement: linhCan?.element || null,
      attrs: meta.coreAttrs || {},
      learnedIds,
      congPhapById: this.data.congPhapById,
      bloodline: meta.bloodline || null
    };
    return this.data.congPhap.map(def => {
      const learned = cpState.learned[def.id] || null;
      const check = learned ? { ok: false, error: 'Đã học.' } : CongPhap.canLearn(def, ctx);
      return {
        id: def.id, ten: def.ten, ngu_hanh: def.ngu_hanh, do_hiem: def.do_hiem,
        effect: def.effect, skills: def.skills, yeu_cau: def.yeu_cau,
        learned: !!learned, evolved: learned?.evolved || false,
        proficiency: learned?.proficiency || 0,
        active: cpState.activeId === def.id,
        canLearn: check.ok, reason: check.ok ? null : check.error,
        evolveThreshold: CongPhap.getEvolveThreshold(def)
      };
    });
  }

  /** Trạng thái công pháp đang kích hoạt + đã học. */
  getCongPhapState() {
    const run = this.repos.run.get();
    if (!run) return null;
    const meta = this._parseMeta(run.metadata) || {};
    return this._getCongPhapState(meta);
  }

  /** Học 1 công pháp. */
  learnCongPhap(id) {
    const run = this.repos.run.get();
    if (!run || run.alive === 0) return { ok: false, error: 'Chưa có kiếp sống.' };
    const def = this.data.congPhapById[id];
    if (!def) return { ok: false, error: `Không tìm thấy công pháp: ${id}` };

    const meta = this._parseMeta(run.metadata) || {};
    const cpState = this._getCongPhapState(meta);
    const realm = this.data.realmById[run.realm_id];
    const linhCan = this.data.linhCanById[run.linh_can_id];
    const ctx = {
      realmOrder: realm?.order || 1,
      linhCanElement: linhCan?.element || null,
      attrs: meta.coreAttrs || {},
      learnedIds: Object.keys(cpState.learned),
      congPhapById: this.data.congPhapById,
      bloodline: meta.bloodline || null
    };
    const check = CongPhap.canLearn(def, ctx);
    if (!check.ok) return check;

    cpState.learned[id] = { id, proficiency: 0, evolved: false };
    if (!cpState.activeId) cpState.activeId = id; // tự kích hoạt cái đầu tiên
    meta.congPhap = cpState;
    this.repos.run.update({ metadata: JSON.stringify(meta) });
    return { ok: true, id, ten: def.ten, message: `Đã lĩnh ngộ ${def.ten}!` };
  }

  /** Kích hoạt 1 công pháp đã học làm công pháp chủ tu. */
  activateCongPhap(id) {
    const run = this.repos.run.get();
    if (!run) return { ok: false, error: 'Chưa có kiếp sống.' };
    const meta = this._parseMeta(run.metadata) || {};
    const cpState = this._getCongPhapState(meta);
    if (!cpState.learned[id]) return { ok: false, error: 'Chưa học công pháp này.' };
    cpState.activeId = id;
    meta.congPhap = cpState;
    this.repos.run.update({ metadata: JSON.stringify(meta) });
    const def = this.data.congPhapById[id];
    return { ok: true, id, ten: def?.ten, message: `Đã chuyển sang chủ tu ${def?.ten || id}.` };
  }

  /** Tiến hóa công pháp khi đạt ngưỡng độ thuần thục. */
  evolveCongPhap(id) {
    const run = this.repos.run.get();
    if (!run) return { ok: false, error: 'Chưa có kiếp sống.' };
    const def = this.data.congPhapById[id];
    if (!def) return { ok: false, error: `Không tìm thấy công pháp: ${id}` };

    const meta = this._parseMeta(run.metadata) || {};
    const cpState = this._getCongPhapState(meta);
    const learned = cpState.learned[id];
    if (!learned) return { ok: false, error: 'Chưa học công pháp này.' };
    if (learned.evolved) return { ok: false, error: 'Công pháp đã tiến hóa rồi.' };

    const threshold = CongPhap.getEvolveThreshold(def);
    if (threshold == null) return { ok: false, error: 'Công pháp này không thể tiến hóa.' };
    if ((learned.proficiency || 0) < threshold)
      return { ok: false, error: `Cần độ thuần thục ≥ ${threshold} (hiện ${learned.proficiency || 0}).` };

    learned.evolved = true;
    meta.congPhap = cpState;
    this.repos.run.update({ metadata: JSON.stringify(meta) });
    const upName = def.tien_hoa?.nang_cap_cuoi || def.ten;
    return { ok: true, id, message: `${def.ten} đã tiến hóa thành ${upName}! Hiệu ứng x${CongPhap.EVOLVED_MULT}.` };
  }

  // ---------- Luân Hồi Shop ----------

  getShopItems() {
    const account = this.repos.account.get();
    const accountMeta = this.repos.account.getMetadata();
    const shopPurchases = accountMeta.shopPurchases || {};
    return Metaprogression.getAvailableShopItems(this.data.shop.items, shopPurchases, account.luan_hoi_points);
  }

  buyShopItem(itemId) {
    const account = this.repos.account.get();
    const accountMeta = this.repos.account.getMetadata();
    const shopPurchases = accountMeta.shopPurchases || {};

    const item = this.data.shop.items.find(i => i.id === itemId);
    if (!item) return { ok: false, error: `Item không tồn tại: ${itemId}` };

    const purchasedLevel = shopPurchases[itemId] || 0;
    const result = Metaprogression.buyShopItem(item, purchasedLevel, account.luan_hoi_points, shopPurchases);
    if (!result.ok) return result;

    // Trừ điểm
    this.repos.account.update({ luan_hoi_points: account.luan_hoi_points - result.cost });
    // Lưu purchase level
    shopPurchases[itemId] = result.newLevel;
    this.repos.account.updateMetadata({ shopPurchases });
    // Nếu là stat upgrade thì cập nhật luôn account column
    if (item.effect.innate_hp_bonus) this.repos.account.update({ innate_hp_bonus: account.innate_hp_bonus + item.effect.innate_hp_bonus });
    if (item.effect.innate_linhkhi_bonus) this.repos.account.update({ innate_linhkhi_bonus: account.innate_linhkhi_bonus + item.effect.innate_linhkhi_bonus });
    if (item.effect.innate_luck_bonus) this.repos.account.update({ innate_luck_bonus: account.innate_luck_bonus + item.effect.innate_luck_bonus });
    if (item.effect.cancco_reduction) this.repos.account.update({ cancco_reduction: account.cancco_reduction + item.effect.cancco_reduction });

    return { ok: true, item: item.name, newLevel: result.newLevel, cost: result.cost, remainingPoints: account.luan_hoi_points - result.cost };
  }

  getRunHistory(limit = 10) {
    return this.repos.runHistory.all(limit);
  }

  getAccountStats() {
    const account = this.repos.account.get();
    const accountMeta = this.repos.account.getMetadata();
    const shopPurchases = accountMeta.shopPurchases || {};
    const innateBonuses = Metaprogression.calcInnateBonuses(account, shopPurchases, this.data.shop.items);
    const bestScore = this.repos.runHistory.bestScore();
    const totalKills = this.repos.runHistory.totalKills();
    const runCount = this.repos.runHistory.count();
    const shopItems = Metaprogression.getAvailableShopItems(this.data.shop.items, shopPurchases, account.luan_hoi_points);

    return {
      account,
      innateBonuses,
      bestScore: bestScore?.best || 0,
      totalKills: totalKills?.total || 0,
      totalRuns: runCount?.count || 0,
      shopPurchases,
      purchasedCount: Object.values(shopPurchases).reduce((s, v) => s + v, 0),
      endlessMultiplier: Metaprogression.getEndlessMultiplier({}, account)
    };
  }

  // ---------- Items / Equipment ----------

  useItem(itemId) {
    const run = this.repos.run.get();
    if (!run) return { ok: false, error: 'Chưa có kiếp sống.' };

    const def = Items.getItemDef(this.data.itemDefs, itemId);
    if (!def) return { ok: false, error: `Vật phẩm không tồn tại: ${itemId}` };
    if (def.type !== 'consumable') return { ok: false, error: `Dùng "equip ${itemId}" để trang bị.` };

    // Tìm item trong inventory
    const inv = this.repos.inventory.all();
    const slot = inv.find(i => i.item_id === itemId && i.quantity > 0);
    if (!slot) return { ok: false, error: `Không có "${def.name}" trong túi đồ.` };

    // Đan dược scale theo cảnh giới: giá trị tuyệt đối (tuViUp/hpMaxUp...) nhân rewardScale.
    const realmTier = this.data.realmById[run.realm_id]?.order || 1;
    const result = Items.useItem(def, run, null, StatsEngine.calcRewardScale(realmTier));
    if (!result.ok) return result;

    // Giảm đúng 1 dòng item này; không đụng các item khác.
    this.repos.inventory.decrement(itemId, 1);

    // Lưu run state
    const updates = { hp: run.hp, linh_khi: run.linh_khi, linh_khi_max: run.linh_khi_max, tu_vi: run.tu_vi };
    const meta = this._parseMeta(run.metadata) || {};
    if (result.effect.deathSave) {
      meta.deathSave = true;
    }
    if (result.effect.breakthroughBonus) {
      meta.breakthroughBonus = (meta.breakthroughBonus || 0) + result.effect.breakthroughBonus;
    }
    if (result.effect.deathSave || result.effect.breakthroughBonus) {
      updates.metadata = JSON.stringify(meta);
    }
    this.repos.run.update(updates);

    return { ...result, hp: run.hp, linh_khi: run.linh_khi, linh_khi_max: run.linh_khi_max, tu_vi: run.tu_vi };
  }

  equipItem(itemId, slot) {
    const run = this.repos.run.get();
    if (!run) return { ok: false, error: 'Chưa có kiếp sống.' };

    const def = Items.getItemDef(this.data.itemDefs, itemId);
    if (!def) return { ok: false, error: `Vật phẩm không tồn tại: ${itemId}` };
    if (def.type !== 'equipment') return { ok: false, error: `"${def.name}" không phải trang bị. Dùng "use ${itemId}" để sử dụng.` };
    if (def.slot !== slot) return { ok: false, error: `"${def.name}" thuộc slot ${def.slot}, không phải ${slot}.` };

    const inv = this.repos.inventory.all();
    if (!inv.some(i => i.item_id === itemId && i.quantity > 0)) {
      return { ok: false, error: `Không có "${def.name}" trong túi đồ.` };
    }

    const meta = this._parseMeta(run.metadata) || {};
    const equipment = Items.getEquipment(run.metadata);

    const result = Items.equipItem(def, slot, equipment);
    if (!result.ok) return result;

    meta.equipment = equipment;
    this.repos.run.update({ metadata: JSON.stringify(meta) });

    // Giảm đúng 1 dòng item được trang bị (không clear-rebuild để tránh mất đồ)
    this.repos.inventory.decrement(itemId, 1);
    // Trả item cũ về inventory nếu có
    if (result.unequipped) {
      this._addItem(result.unequipped, 1);
    }

    return result;
  }

  unequipItem(slot) {
    const run = this.repos.run.get();
    if (!run) return { ok: false, error: 'Chưa có kiếp sống.' };

    const equipment = Items.getEquipment(run.metadata);
    const result = Items.unequipSlot(slot, equipment);
    if (!result.ok) return result;

    const meta = this._parseMeta(run.metadata) || {};
    meta.equipment = equipment;
    this.repos.run.update({ metadata: JSON.stringify(meta) });

    // Trả item về inventory
    this._addItem(result.unequipped.id, 1);
    return result;
  }

  getEquipmentView() {
    const run = this.repos.run.get();
    if (!run) return null;
    return Items.getEquipment(run.metadata);
  }

  // ---------- Meditation ----------

  meditate(minutes) {
    const run = this.repos.run.get();
    if (!run || run.alive === 0) return { ok: false, error: 'Chưa có kiếp sống.' };

    if (run.fsm_state !== STATES.IDLE) {
      return { ok: false, error: `Không thể thiền khi đang ${run.fsm_state}.` };
    }

    const mins = Math.min(60, Math.max(1, minutes || 10));
    const realm = this.data.realmById[run.realm_id];
    const result = Meditation.meditate(mins, run, realm, run.luck, this.rng);

    run.tu_vi += result.tuViGain;
    run.linh_khi = Math.min(run.linh_khi_max, run.linh_khi + result.linhKhiGain);

    this.repos.run.update({ tu_vi: run.tu_vi, linh_khi: run.linh_khi });

    if (result.ambushed) {
      // Bị tập kích — chuyển sang combat
      const realmOrder = realm.order;
      const diff = this.difficultyMultiplier(run);
      const { enemy, realmTier } = CombatEngine.pickEnemy(this.data.enemies, realmOrder, false, this.rng);
      const combat = CombatEngine.initCombatState(enemy, diff, realmTier);
      this.repos.run.update({ fsm_state: STATES.COMBAT, metadata: this._setCombat(run, combat) });
      return { ok: true, ...result, ambushed: true, combat };
    }

    return { ok: true, ...result, ambushed: false };
  }

  // ---------- Travel / Random Encounters ----------

  travelStep() {
    const run = this.repos.run.get();
    if (!run || run.alive === 0) return { ok: false, error: 'Chưa có kiếp sống.' };
    if (run.fsm_state !== STATES.IDLE) return { ok: false, error: `Không thể đi khi đang ${run.fsm_state}.` };

    const travelData = this.data.travel;
    const flags = EventChain.getFlags(run.metadata);
    const metaNow = this._parseMeta(run.metadata) || {};
    const recentIds = metaNow._recentScenarios || [];
    const step = Travel.travelStep(travelData.stepTypes, travelData.scenarios, run.luck, flags, this.rng, recentIds);

    // Nhớ scenario vừa chọn (cửa sổ 5) để chống lặp liên tục ở lượt sau.
    const recentNext = step.scenario?.id
      ? [step.scenario.id, ...recentIds.filter(id => id !== step.scenario.id)].slice(0, 5)
      : recentIds;

    if (step.type === 'combat') {
      const realm = this.data.realmById[run.realm_id];
      const diff = this.difficultyMultiplier(run) * (step.scenario.enemyDifficulty || 1.0);
      const isBoss = step.scenario.isBoss || false;
      const { enemy, realmTier } = CombatEngine.pickEnemy(this.data.enemies, realm.order, isBoss, this.rng);
      const combat = CombatEngine.initCombatState(enemy, diff, realmTier);
      const cMeta = this._parseMeta(run.metadata) || {};
      cMeta.combat = combat;
      cMeta._recentScenarios = recentNext;
      this.repos.run.update({ fsm_state: STATES.COMBAT, metadata: JSON.stringify(cMeta) });
      return { ok: true, type: step.type, icon: step.icon, scenario: step.scenario, combat };
    }

    // Scenario có choices -> chuyển IN_EVENT, lưu scenario để renderer gọi resolveTravelChoice
    if (step.scenario.choices && Array.isArray(step.scenario.choices)) {
      const meta = this._parseMeta(run.metadata) || {};
      meta._travelScenario = step.scenario;
      meta._branchDepth = 0; // reset bộ đếm độ sâu rẽ nhánh cho sự kiện mới
      meta._recentScenarios = recentNext;
      this.repos.run.update({
        fsm_state: STATES.IN_EVENT,
        metadata: JSON.stringify(meta)
      });
      return { ok: true, type: step.type, icon: step.icon, scenario: step.scenario, state: STATES.IN_EVENT };
    }

    // Non-combat: resolve ngay (scale phần thưởng theo cảnh giới)
    const rScale = StatsEngine.calcRewardScale(this.data.realmById[run.realm_id]?.order || 1);
    const result = Travel.resolveTravelReward(run, step.scenario, this.rng, rScale);
    const ncMeta = this._parseMeta(run.metadata) || {};
    ncMeta._recentScenarios = recentNext;
    const updates = { hp: run.hp, linh_khi: run.linh_khi, linh_khi_max: run.linh_khi_max, tu_vi: run.tu_vi, spirit_stones: run.spirit_stones, luck: run.luck, tuoi_tho: run.tuoi_tho, metadata: JSON.stringify(ncMeta) };
    this.repos.run.update(updates);

    // Xử lý item reward
    let itemReward = null;
    if (step.scenario.reward?.item) {
      itemReward = step.scenario.reward.item;
      this._addItem(itemReward, 1);
    }
    if (result.reward?.item) {
      itemReward = result.reward.item;
      this._addItem(itemReward, 1);
    }

    return { ok: true, type: step.type, icon: step.icon, scenario: step.scenario, result, itemReward, run: { hp: run.hp, hp_max: run.hp_max, linh_khi: run.linh_khi, linh_khi_max: run.linh_khi_max, tu_vi: run.tu_vi, spirit_stones: run.spirit_stones, luck: run.luck } };
  }

  /** Mua hàng từ thương nhân (travel merchant scenario). */
  travelBuy(shopItemId, cost) {
    const run = this.repos.run.get();
    if (!run) return { ok: false, error: 'Chưa có kiếp sống.' };
    if (run.spirit_stones < cost) return { ok: false, error: `Cần ${cost} Linh Thạch (hiện ${run.spirit_stones}).` };

    run.spirit_stones -= cost;
    this.repos.run.update({ spirit_stones: run.spirit_stones });
    this._addItem(shopItemId, 1);

    const itemDef = this.data.itemDefs[shopItemId];
    return { ok: true, item: itemDef?.name || shopItemId, cost, message: `Mua ${itemDef?.name || shopItemId} giá ${cost} LS.` };
  }

  /** Xử lý lựa chọn trong travel scenario. */
  resolveTravelChoice(choiceIndex) {
    const run = this.repos.run.get();
    if (!run) return { ok: false, error: 'Chưa có kiếp sống.' };

    // Validate: CHỈ resolve khi đang IN_EVENT
    if (run.fsm_state !== STATES.IN_EVENT) {
      return { ok: false, error: 'Không có sự kiện nào đang chờ lựa chọn.' };
    }

    const meta = this._parseMeta(run.metadata) || {};
    const scenario = meta._travelScenario;
    if (!scenario) return { ok: false, error: 'Không có sự kiện travel đang active.' };

    if (choiceIndex < 0 || choiceIndex >= (scenario.choices?.length || 0)) {
      return { ok: false, error: `Lựa chọn ${choiceIndex} không hợp lệ.` };
    }

    const choice = scenario.choices[choiceIndex];
    const risk = scenario.risks?.[choiceIndex] || 'none';
    const reward = scenario.rewards?.[choiceIndex] || null;

    // Roll risk
    let outcome = 'success';
    let message = choice;
    if (risk !== 'none') {
      const rate = risk === 'high' ? 0.35 : risk === 'medium' ? 0.55 : 0.75;
      const luckBonus = run.luck / 200;
      outcome = this.rng() < Math.min(0.95, rate + luckBonus) ? 'success' : 'failure';
    }

    // Scale phần thưởng tuyệt đối theo cảnh giới (giá trị cao hơn ở cảnh giới cao).
    const realmTier = this.data.realmById[run.realm_id]?.order || 1;
    const rScale = StatsEngine.calcRewardScale(realmTier);

    if (outcome === 'success' && reward) {
      if (reward.spiritStones) run.spirit_stones += Math.round(reward.spiritStones * rScale);
      if (reward.tuVi) run.tu_vi += Math.round(reward.tuVi * rScale);
      if (reward.item) this._addItem(reward.item, 1);
      if (reward.linhKhiBonus) { const lk = Math.round(reward.linhKhiBonus * rScale); run.linh_khi_max += lk; run.linh_khi += lk; }
      if (reward.fullHeal) { run.hp = run.hp_max; run.linh_khi = run.linh_khi_max; }
      message += ` → Thành công!`;
    } else if (outcome === 'failure' && risk !== 'none') {
      const hpLoss = Math.floor(run.hp_max * 0.2);
      run.hp = Math.max(1, run.hp - hpLoss);
      message += ` → Thất bại! Mất ${hpLoss} HP.`;
    }

    // Rẽ nhánh: success → reward.next; failure → scenario.failBranches[idx]. Mỗi nhánh là 1
    // scenario con đầy đủ (có choices). Bộ đếm _branchDepth chặn vòng lặp vô hạn (tối đa 6 bước).
    const branch = outcome === 'success'
      ? (reward?.next || null)
      : (scenario.failBranches?.[choiceIndex] || null);
    const depth = (meta._branchDepth || 0) + 1;

    if (branch && Array.isArray(branch.choices) && depth <= 6) {
      meta._travelScenario = branch;
      meta._branchDepth = depth;
      this.repos.run.update({
        hp: run.hp, linh_khi: run.linh_khi, linh_khi_max: run.linh_khi_max,
        tu_vi: run.tu_vi, spirit_stones: run.spirit_stones,
        fsm_state: STATES.IN_EVENT,
        metadata: JSON.stringify(meta)
      });
      return { ok: true, outcome, message, branched: true, scenario: branch, hp: run.hp };
    }

    // Kết thúc chuỗi: clear travel scenario + bộ đếm nhánh, về IDLE
    delete meta._travelScenario;
    delete meta._branchDepth;
    this.repos.run.update({
      hp: run.hp, linh_khi: run.linh_khi, linh_khi_max: run.linh_khi_max,
      tu_vi: run.tu_vi, spirit_stones: run.spirit_stones,
      fsm_state: STATES.IDLE,
      metadata: JSON.stringify(meta)
    });

    return { ok: true, outcome, message, hp: run.hp };
  }

  // ---------- Achievements ----------

  checkAchievements() {
    const account = this.repos.account.get();
    const accountMeta = this.repos.account.getMetadata();
    const unlockedIds = accountMeta.unlockedAchievements || [];
    const bestScore = this.repos.runHistory.bestScore();
    const totalKills = this.repos.runHistory.totalKills();
    const runCount = this.repos.runHistory.count();

    const stats = {
      total_lifetimes: account.total_lifetimes,
      best_realm: accountMeta.bestRealm || 0,
      total_kills: totalKills?.total || 0,
      best_score: bestScore?.best || 0,
      account_level: account.level,
      boss_kills: accountMeta.bossKills || 0,
      craft_count: accountMeta.craftCount || 0,
      breakthroughs: accountMeta.breakthroughs || 0,
      tribulations: accountMeta.tribulations || 0,
      shop_purchases: Object.values(accountMeta.shopPurchases || {}).reduce((s, v) => s + v, 0),
      sect_joined: accountMeta.sectJoined ? 1 : 0,
      sect_rank: accountMeta.maxSectRank || 0
    };

    const newUnlocks = Achievements.checkAchievements(this.data.achievements, stats, unlockedIds);
    if (newUnlocks.length === 0) return { ok: true, newUnlocks: [], totalReward: 0 };

    const reward = Achievements.sumRewards(newUnlocks);
    const allUnlocked = [...unlockedIds, ...newUnlocks.map(a => a.id)];
    this.repos.account.updateMetadata({ unlockedAchievements: allUnlocked });
    this.repos.account.update({ luan_hoi_points: account.luan_hoi_points + reward });

    return { ok: true, newUnlocks, totalReward: reward };
  }

  getAchievementsView() {
    const accountMeta = this.repos.account.getMetadata();
    const unlockedIds = accountMeta.unlockedAchievements || [];
    return this.data.achievements.map(a => ({
      ...a,
      unlocked: unlockedIds.includes(a.id)
    }));
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

    // Lưu run history
    const realm = this.data.realmById[run.realm_id];
    this.repos.runHistory.add({
      ended_at: Date.now(),
      realm_id: run.realm_id,
      realm_name: realm ? realm.name : run.realm_id,
      score,
      monsters_killed: run.monsters_killed,
      spirit_stones_earned: run.spirit_stones,
      years_lived: run.tuoi_tho,
      cause_of_death: run.fsm_state === 'DEAD' ? 'combat' : 'old_age'
    });

    // Track achievement stats
    const accountMeta = this.repos.account.getMetadata();
    if (realm && realm.order > (accountMeta.bestRealm || 0)) {
      accountMeta.bestRealm = realm.order;
    }
    accountMeta.bossKills = (accountMeta.bossKills || 0);
    this.repos.account.updateMetadata(accountMeta);

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

// Cosmetic helper cho element label
function elmTag(multiplier) {
  if (multiplier >= 1.5) return 'KHẮC CHẾ x1.5';
  if (multiplier <= 0.5) return 'BỊ KHẮC x0.5';
  return '';
}

// Log đòn đánh của quái — phản ánh né hẳn / sượt (§2.2)
function enemyHitLog(enemyName, act, hpLeft) {
  if (act.isDodge) return `💨 Bạn né được đòn của ${enemyName}! | Bạn còn ${hpLeft} HP`;
  const tag = [act.isCrit ? ' [BẠO KÍCH]' : '', act.isGlancing ? ' [SƯỢT]' : '', act.elementMultiplier !== 1 ? ` [${elmTag(act.elementMultiplier)}]` : ''].join('');
  return `👊 ${enemyName} phản công: -${act.damage} HP${tag} | Bạn còn ${hpLeft} HP`;
}

module.exports = { GameService };
