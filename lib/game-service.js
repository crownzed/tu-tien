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
const MapGenerator = require('./map-generator');
const EventChain = require('./event-chain');
const Breakthrough = require('./breakthrough');
const Crafting = require('./crafting');
const Sect = require('./sect');
const Metaprogression = require('./metaprogression');
const Items = require('./items');
const Meditation = require('./meditation');
const Achievements = require('./achievements');
const Travel = require('./travel');

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

    // Base + tiên thiên + realm bonus
    const hpMax = balance.base.hpMax + startRealm.hpBonus + innateBonuses.innate_hp_bonus;
    const linhKhiMax = startRealm.linhKhiMax + innateBonuses.innate_linhkhi_bonus;
    const luck = balance.base.luck + innateBonuses.innate_luck_bonus + (giaCanh.startLuckBonus || 0);

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
      map_state: null
    };

    const run = this.repos.run.create(runData);

    // Sinh bản đồ cho kiếp mới
    const realm = this.data.realmById[run.realm_id];
    const mapState = MapGenerator.generateMap(this.data.map, realm.order, this.rng);
    this.repos.run.update({ map_state: MapGenerator.serializeMapState(mapState) });
    run.map_state = MapGenerator.serializeMapState(mapState);

    // Đồ khởi đầu từ gia cảnh
    if (Array.isArray(giaCanh.startItems)) {
      for (const itemId of giaCanh.startItems) {
        this.repos.inventory.add({ item_id: itemId, item_name: itemId, quantity: 1 });
      }
    }
    // Thêm start items từ shop
    if (innateBonuses.start_items.length > 0) {
      for (const itemId of innateBonuses.start_items) {
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
    return CombatEngine.parseCombatState(run.metadata);
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
    const { enemy, zone } = CombatEngine.pickEnemy(this.data.enemies, realm.order, isBoss, this.rng);

    const combat = CombatEngine.initCombatState(enemy, isBoss ? diff * 1.5 : diff);
    this.repos.run.update({
      fsm_state: STATES.COMBAT,
      metadata: CombatEngine.serializeCombatState(combat)
    });

    return { ok: true, combat, zone: zone.id };
  }

  /** Trả về run với combat state cho renderer. */
  getCombatView() {
    const run = this.repos.run.get();
    if (!run) return null;
    const combat = CombatEngine.parseCombatState(run.metadata);
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

    const combat = CombatEngine.parseCombatState(run.metadata);
    if (!combat) return { ok: false, error: 'Không có combat state' };

    const linhCan = this.data.linhCanById[run.linh_can_id];
    const playerElm = linhCan?.element || null;

    // LK cost for normal attack
    const lkCost = balance.linhKhi.attackCost || 3;
    if (run.linh_khi < lkCost) return { ok: false, error: `Cần ${lkCost} Linh Khí để tấn công (hiện ${run.linh_khi}).` };
    run.linh_khi -= lkCost;

    // Tính equipment bonuses
    const equipment = Items.getEquipment(run.metadata);
    const eqBonuses = Items.calcEquipmentBonuses(equipment);
    const baseAtk = run.linh_khi_max * 0.25 + eqBonuses.attackBonus;

    // Player -> Enemy
    const playerDmg = CombatEngine.calculateDamage(
      { attack: baseAtk, element: playerElm },
      { defense: combat.enemyDefense * (1 - eqBonuses.damageReduction), element: combat.enemyElement },
      this.rng
    );

    combat.enemyHp -= playerDmg.damage;
    combat.turn++;
    combat.log.push(`⚔️ Bạn tấn công: -${playerDmg.damage} HP${playerDmg.elementMultiplier !== 1 ? ` [${elmTag(playerDmg.elementMultiplier)}]` : ''} | Quái còn ${Math.max(0, combat.enemyHp)} HP`);

    const result = { ok: true, playerAction: { type: 'attack', ...playerDmg } };

    if (combat.enemyHp <= 0) {
      return this._resolveVictory(run, combat, result);
    }

    // Enemy counter-attack
    const enemyAct = CombatEngine.enemyTurn(combat, playerElm, this.rng);
    run.hp -= enemyAct.damage;
    combat.log.push(`👊 ${combat.enemyName} phản công: -${enemyAct.damage} HP | Bạn còn ${Math.max(0, run.hp)} HP`);
    result.enemyAction = enemyAct;

    this.repos.run.update({ hp: run.hp, linh_khi: run.linh_khi, metadata: CombatEngine.serializeCombatState(combat) });

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

    const combat = CombatEngine.parseCombatState(run.metadata);
    if (!combat) return { ok: false, error: 'Không có combat state' };

    const castCost = 20;
    if (run.linh_khi < castCost) return { ok: false, error: `Không đủ Linh Khí (cần ${castCost}, hiện ${run.linh_khi})` };

    run.linh_khi -= castCost;

    const linhCan = this.data.linhCanById[run.linh_can_id];
    const playerElm = linhCan?.element || null;

    const equipment = Items.getEquipment(run.metadata);
    const eqBonuses = Items.calcEquipmentBonuses(equipment);

    const playerDmg = CombatEngine.calculateDamage(
      { attack: run.linh_khi_max * 0.45 + eqBonuses.attackBonus, element: playerElm },
      { defense: combat.enemyDefense * 0.6 * (1 - eqBonuses.damageReduction), element: combat.enemyElement },
      this.rng
    );

    combat.enemyHp -= playerDmg.damage;
    combat.turn++;
    combat.log.push(`✨ Bạn thi pháp (-${castCost} LK): -${playerDmg.damage} HP${playerDmg.elementMultiplier !== 1 ? ` [${elmTag(playerDmg.elementMultiplier)}]` : ''} | Quái còn ${Math.max(0, combat.enemyHp)} HP`);

    const result = { ok: true, playerAction: { type: 'cast', cost: castCost, ...playerDmg } };

    if (combat.enemyHp <= 0) {
      return this._resolveVictory(run, combat, result);
    }

    const enemyAct = CombatEngine.enemyTurn(combat, playerElm, this.rng);
    run.hp -= enemyAct.damage;
    combat.log.push(`👊 ${combat.enemyName} phản công: -${enemyAct.damage} HP | Bạn còn ${Math.max(0, run.hp)} HP`);
    result.enemyAction = enemyAct;

    this.repos.run.update({ hp: run.hp, linh_khi: run.linh_khi, metadata: CombatEngine.serializeCombatState(combat) });

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

    const combat = CombatEngine.parseCombatState(run.metadata);
    if (!combat) return { ok: false, error: 'Không có combat state' };

    const fleeChance = 0.3 + run.luck / 200; // 30% base + luck bonus
    const success = this.rng() < fleeChance;

    if (success) {
      combat.log.push('🏃 Bạn chạy thoát thành công!');
      this.repos.run.update({ fsm_state: STATES.IDLE, metadata: null });
      return { ok: true, result: 'fled', combat };
    }

    const linhCan = this.data.linhCanById[run.linh_can_id];
    const playerElm = linhCan?.element || null;
    const enemyAct = CombatEngine.enemyTurn(combat, playerElm, this.rng);
    run.hp -= enemyAct.damage;
    combat.turn++;
    combat.log.push('🏃 Chạy thất bại!');
    combat.log.push(`👊 ${combat.enemyName} tấn công: -${enemyAct.damage} HP | Bạn còn ${Math.max(0, run.hp)} HP`);

    this.repos.run.update({ hp: run.hp, metadata: CombatEngine.serializeCombatState(combat) });

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

    const combat = CombatEngine.parseCombatState(run.metadata);
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

      this.repos.run.update({ hp: run.hp, linh_khi: run.linh_khi, metadata: CombatEngine.serializeCombatState(combat) });

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
    const enemyAct = CombatEngine.enemyTurn(combat, playerElm, this.rng);
    run.hp -= enemyAct.damage;
    combat.log.push(`👊 ${combat.enemyName} phản công: -${enemyAct.damage} HP | Bạn còn ${Math.max(0, run.hp)} HP`);
    result.enemyAction = enemyAct;

    this.repos.run.update({ hp: run.hp, linh_khi: run.linh_khi, metadata: CombatEngine.serializeCombatState(combat) });

    if (run.hp <= 0) {
      return this._resolveDefeat(run, combat, result);
    }

    return result;
  }

  // ---------- Private combat helpers ----------

  _resolveVictory(run, combat, result) {
    const stones = CombatEngine.rollDrop(combat.dropStones, this.rng);
    run.spirit_stones += stones;
    run.monsters_killed += 1;

    // Run EXP — tích lũy trong kiếp
    const expGain = combat.expReward || balance.runExp.combatBase;
    run.run_exp = (run.run_exp || 0) + expGain;
    combat.log.push(`🎉 Chiến thắng! +${expGain} EXP, +${stones} Linh Thạch`);

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
      metadata: null
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
      metadata: CombatEngine.serializeCombatState(combat)
    });
    result.defeat = true;
    result.combat = combat;
    return result;
  }

  // ---------- Map / Event System ----------

  getMapView() {
    const run = this.repos.run.get();
    if (!run) return null;
    const mapState = MapGenerator.parseMapState(run.map_state);
    return { run: { hp: run.hp, hp_max: run.hp_max, linh_khi: run.linh_khi, linh_khi_max: run.linh_khi_max, luck: run.luck, fsm_state: run.fsm_state, spirit_stones: run.spirit_stones }, mapState };
  }

  selectNode(nodeIndex) {
    const run = this.repos.run.get();
    if (!run) return { ok: false, error: 'Chưa có kiếp sống' };

    const mapState = MapGenerator.parseMapState(run.map_state);
    if (!mapState) return { ok: false, error: 'Không có map state' };

    const result = MapGenerator.selectNextNode(mapState, nodeIndex);
    if (!result.ok) return result;

    this.repos.run.update({ map_state: MapGenerator.serializeMapState(result.mapState) });
    return { ok: true, mapState: result.mapState, currentNode: this._getCurrentNode(result.mapState) };
  }

  enterNode() {
    const run = this.repos.run.get();
    if (!run) return { ok: false, error: 'Chưa có kiếp sống' };

    const mapState = MapGenerator.parseMapState(run.map_state);
    if (!mapState) return { ok: false, error: 'Không có map state' };

    const node = this._getCurrentNode(mapState);
    if (!node) return { ok: false, error: 'Không có node hiện tại' };

    // Lấy event flags hiện tại
    const flags = EventChain.getFlags(run.metadata);

    // Combat / Elite / Boss -> dùng combat system
    if (node.type === 'combat' || node.type === 'elite' || node.type === 'boss') {
      const fsm = new FSM(run.fsm_state);
      const trans = fsm.transition(STATES.COMBAT);
      if (!trans.ok) return { ok: false, error: trans.error };

      const realm = this.data.realmById[run.realm_id];
      const diff = this.difficultyMultiplier(run);
      const isBoss = node.type === 'boss';
      const isElite = node.type === 'elite';
      const mult = isBoss ? diff * 2 : isElite ? diff * 1.5 : diff;
      const { enemy } = CombatEngine.pickEnemy(this.data.enemies, realm.order, isBoss, this.rng);
      const combat = CombatEngine.initCombatState(enemy, mult);

      // Set flag khi gặp boss
      if (isBoss) {
        const meta = EventChain.applyFlagsToRun(run.metadata, { [`met_boss_${node.id || 'unknown'}`]: true });
        this.repos.run.update({
          fsm_state: STATES.COMBAT,
          metadata: CombatEngine.serializeCombatState(combat)
        });
      } else {
        this.repos.run.update({
          fsm_state: STATES.COMBAT,
          metadata: CombatEngine.serializeCombatState(combat)
        });
      }

      return { ok: true, nodeType: node.type, node, action: 'combat', combat };
    }

    // Treasure / Rest / NPC / Event / Cave / Sect -> Narrative Engine với Queue + Phase + Weight
    const realm = this.data.realmById[run.realm_id];
    const { script, fromQueue, newMetadata: afterPick } = EventChain.pickEventScript(
      this.data.eventScripts, node.type, flags, realm.order, run.realm_id, run.luck, run.metadata, this.rng
    );
    if (!script) {
      return this._handleBasicNode(run, mapState, node);
    }

    // Chuyển sang IN_EVENT
    const fsmEvent = new FSM(run.fsm_state);
    const trans = fsmEvent.transition(STATES.IN_EVENT);
    if (!trans.ok) return { ok: false, error: trans.error };

    // Lưu script + flags vào map state
    mapState._activeScript = script;
    mapState._activeFlags = flags;
    const metaToStore = afterPick || run.metadata;
    this.repos.run.update({
      fsm_state: STATES.IN_EVENT,
      map_state: MapGenerator.serializeMapState(mapState),
      ...(afterPick ? { metadata: afterPick } : {})
    });

    return { ok: true, nodeType: node.type, node, action: 'event', script, fromQueue };
  }

  resolveChoice(choiceIndex) {
    const run = this.repos.run.get();
    if (!run) return { ok: false, error: 'Chưa có kiếp sống' };

    const fsmCheck = new FSM(run.fsm_state);
    const actionCheck = fsmCheck.validateAction('choose');
    if (!actionCheck.ok) return { ok: false, error: actionCheck.error };

    const mapState = MapGenerator.parseMapState(run.map_state);
    if (!mapState || !mapState._activeScript) return { ok: false, error: 'Không có event đang active' };

    const script = mapState._activeScript;
    const flags = mapState._activeFlags || EventChain.getFlags(run.metadata);

    const result = EventChain.resolveChoice(script, choiceIndex, run.luck, flags, this.rng);
    if (!result.ok) return result;

    const res = result.result;

    // Áp dụng reward/damage/cost
    if (res.reward) EventChain.applyReward(run, res.reward, flags);
    if (res.damage) EventChain.applyDamage(run, res.damage);
    if (res.cost) EventChain.applyCost(run, res.cost);

    // Persist flags
    let updatedMeta = run.metadata || null;
    if (result.setFlags && Object.keys(result.setFlags).length > 0) {
      updatedMeta = EventChain.applyFlagsToRun(run.metadata, result.setFlags);
    }

    // Xử lý next_event: đẩy vào queue
    if (result.nextEventId) {
      updatedMeta = EventChain.enqueueEvent(updatedMeta || run.metadata, result.nextEventId);
    }

    // Xử lý item thưởng (hỗ trợ cả dạng đơn và mảng)
    const items = [];
    if (res.reward) {
      if (res.reward._item) items.push(res.reward._item);
      if (res.reward._item2) items.push(res.reward._item2);
      if (res.reward._items) items.push(...res.reward._items);
      // Cũng check items array từ format mới
      if (res.reward.items) {
        for (const it of res.reward.items) items.push(it);
      }
    }

    // Clear active script, mark node cleared, return to IDLE
    delete mapState._activeScript;
    delete mapState._activeFlags;
    MapGenerator.clearCurrentNode(mapState);
    this.repos.run.update({
      hp: run.hp,
      linh_khi: run.linh_khi,
      tu_vi: run.tu_vi,
      spirit_stones: run.spirit_stones,
      tuoi_tho: run.tuoi_tho,
      fsm_state: STATES.IDLE,
      map_state: MapGenerator.serializeMapState(mapState),
      ...(updatedMeta ? { metadata: updatedMeta } : {})
    });

    // Thêm items vào inventory
    for (const itemId of items) {
      this.repos.inventory.add({ item_id: itemId, item_name: itemId, quantity: 1 });
    }

    if (run.hp <= 0) {
      return { ok: true, result: res, nodeCleared: true, mapState, died: true };
    }

    return { ok: true, result: res, nodeCleared: true, mapState, hp: run.hp, linh_khi: run.linh_khi };
  }

  /** Hoàn thành combat node (gọi sau khi thắng combat). */
  completeCombatNode() {
    const run = this.repos.run.get();
    if (!run) return { ok: false, error: 'Chưa có kiếp sống' };
    if (run.fsm_state !== STATES.IDLE) return { ok: false, error: 'Combat chưa kết thúc' };

    const mapState = MapGenerator.parseMapState(run.map_state);
    if (!mapState) return { ok: false, error: 'Không có map state' };

    MapGenerator.clearCurrentNode(mapState);
    this.repos.run.update({ map_state: MapGenerator.serializeMapState(mapState) });
    return { ok: true, mapState };
  }

  // ---------- Private map helpers ----------

  _getCurrentNode(mapState) {
    if (!mapState || !mapState.layers) return null;
    const layer = mapState.layers[mapState.currentLayer];
    if (!layer) return null;
    return layer[mapState.currentNodeIndex] || null;
  }

  _handleBasicNode(run, mapState, node) {
    // Fallback khi không có event script
    if (node.type === 'rest') {
      const healPct = balance.map.restHealPercent;
      const hpHeal = Math.floor(run.hp_max * healPct);
      const lkHeal = Math.floor(run.linh_khi_max * healPct);
      run.hp = Math.min(run.hp_max, run.hp + hpHeal);
      run.linh_khi = Math.min(run.linh_khi_max, run.linh_khi + lkHeal);
      MapGenerator.clearCurrentNode(mapState);
      this.repos.run.update({
        hp: run.hp,
        linh_khi: run.linh_khi,
        map_state: MapGenerator.serializeMapState(mapState)
      });
      return { ok: true, nodeType: node.type, node, action: 'rest', result: { text: `Nghỉ ngơi hồi ${hpHeal} HP, ${lkHeal} Linh Khí.` } };
    }

    // Các loại node khác — chỉ clear
    MapGenerator.clearCurrentNode(mapState);
    this.repos.run.update({ map_state: MapGenerator.serializeMapState(mapState) });
    return { ok: true, nodeType: node.type, node, action: 'skip', result: { text: `${node.desc} — không có gì đặc biệt.` } };
  }

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

    if (result.success) {
      run.realm_stage = result.newStage;
      run.hp_max += result.hpBonus;
      run.hp += result.hpBonus;
      run.linh_khi_max += result.lkBonus;
      run.linh_khi += result.lkBonus;
    } else if (result.damage) {
      run.hp = Math.max(0, run.hp - result.damage.hp);
    }

    this.repos.run.update({
      tu_vi: run.tu_vi,
      realm_stage: run.realm_stage,
      hp: run.hp, hp_max: run.hp_max,
      linh_khi: run.linh_khi, linh_khi_max: run.linh_khi_max
    });

    return { ...result, hp: run.hp, tu_vi: run.tu_vi, realm_stage: run.realm_stage };
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
      if (result.tribulation) {
        // Có thiên kiếp — chuyển sang TRIBULATION state, lưu tribulation state
        run.fsm_state = STATES.TRIBULATION;
        // Lưu breakthrough state tạm vào metadata (nextRealm, tribulation)
        const meta = { nextRealmId: Breakthrough.getNextRealm(run.realm_id, this.data.realms, this.data.realmById)?.id, tribulation: result.tribulation };
        this.repos.run.update({ linh_khi: run.linh_khi, fsm_state: STATES.TRIBULATION, metadata: JSON.stringify(meta) });
        return { ok: true, success: true, tribulation: true, strikes: result.tribulation.strikes, damagePerStrike: result.tribulation.damagePerStrike, message: result.message };
      }

      // Không thiên kiếp — advance realm ngay
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
    const strikeResult = Breakthrough.processTribulationStrike(meta.tribulation, run.hp, artifactCount, this.rng);

    if (!strikeResult.survived) {
      // Chết trong thiên kiếp
      run.hp = 0;
      run.fsm_state = STATES.DEAD;
      run.alive = 0;
      this.repos.run.update({ hp: 0, fsm_state: STATES.DEAD, alive: 0, metadata: null });
      return { ok: true, died: true, strikeNumber: strikeResult.strikeNumber, damage: strikeResult.damage, message: `Thiên kiếp đạo thứ ${strikeResult.strikeNumber}: -${strikeResult.damage} HP. Bạn đã tử vong dưới lôi kiếp!` };
    }

    run.hp = strikeResult.playerHpAfter;
    meta.tribulation = strikeResult;
    this.repos.run.update({ hp: run.hp, metadata: JSON.stringify(meta) });

    if (strikeResult.tribulationOver) {
      // Sống sót toàn bộ thiên kiếp — advance realm
      this._advanceRealm(run, { tribulation: meta.tribulation });
      return { ok: true, tribulationOver: true, survived: true, strikeNumber: strikeResult.strikeNumber, damage: strikeResult.damage, hp: run.hp, newRealm: run.realm_id, message: `Đạo ${strikeResult.strikeNumber}/${meta.tribulation.strikes}: -${strikeResult.damage} HP. THIÊN KIẾP ĐÃ QUA! Chúc mừng đột phá thành công!` };
    }

    return { ok: true, tribulationOver: false, strikeNumber: strikeResult.strikeNumber, strikesRemaining: strikeResult.strikesRemaining, damage: strikeResult.damage, hp: run.hp, message: `Đạo ${strikeResult.strikeNumber}/${meta.tribulation.strikes + strikeResult.strikesRemaining}: -${strikeResult.damage} HP. Còn ${strikeResult.strikesRemaining} đạo.` };
  }

  _advanceRealm(run, btResult) {
    const nextRealm = Breakthrough.getNextRealm(run.realm_id, this.data.realms, this.data.realmById);
    if (!nextRealm) return;

    run.realm_id = nextRealm.id;
    run.realm_stage = 0;
    run.hp_max = run.hp_max + nextRealm.hpBonus;
    run.hp = run.hp_max; // full heal on breakthrough
    run.linh_khi_max = nextRealm.linhKhiMax;
    run.linh_khi = run.linh_khi_max;
    run.tuoi_tho_max = nextRealm.tuoiThoMax;
    run.tuoi_tho = Math.min(run.tuoi_tho, run.tuoi_tho_max);
    run.fsm_state = STATES.IDLE;
    run.metadata = null;

    this.repos.run.update({
      realm_id: run.realm_id, hp: run.hp, hp_max: run.hp_max,
      linh_khi: run.linh_khi, linh_khi_max: run.linh_khi_max,
      tuoi_tho: run.tuoi_tho, tuoi_tho_max: run.tuoi_tho_max,
      fsm_state: STATES.IDLE, metadata: null
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

    // Sinh lại map cho realm mới
    const newMap = MapGenerator.generateMap(this.data.map, nextRealm.order, this.rng);
    this.repos.run.update({ map_state: MapGenerator.serializeMapState(newMap) });
  }

  _parseMeta(json) { if (!json) return null; try { return JSON.parse(json); } catch { return null; } }
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

    const result = Crafting.craftItem(recipe, run, run.luck, this.rng);
    if (!result.ok) return result;

    // Trừ Linh Thạch
    run.spirit_stones -= result.cost.spiritStones;

    if (result.success) {
      this.repos.inventory.add({ item_id: result.item, item_name: result.item, quantity: result.quantity });
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

    const result = Items.useItem(def, run);
    if (!result.ok) return result;

    // Giảm quantity, xóa nếu hết
    if (slot.quantity <= 1) {
      this.repos.inventory.clear(); // Xóa all rồi thêm lại (đơn giản)
      for (const i of inv) {
        if (i.item_id !== itemId) {
          this.repos.inventory.add({ item_id: i.item_id, item_name: i.item_name, quantity: i.quantity });
        }
      }
    } else {
      // Cập nhật quantity (đơn giản: xóa all, thêm lại)
      this.repos.inventory.clear();
      for (const i of inv) {
        const qty = i.item_id === itemId ? i.quantity - 1 : i.quantity;
        if (qty > 0) this.repos.inventory.add({ item_id: i.item_id, item_name: i.item_name, quantity: qty });
      }
    }

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

    // Giảm inventory
    this.repos.inventory.clear();
    for (const i of inv) {
      const qty = i.item_id === itemId ? i.quantity - 1 : i.quantity;
      if (qty > 0) this.repos.inventory.add({ item_id: i.item_id, item_name: i.item_name, quantity: qty });
    }
    // Trả item cũ về inventory nếu có
    if (result.unequipped) {
      const oldDef = Items.getItemDef(this.data.itemDefs, result.unequipped);
      const oldName = oldDef?.name || result.unequipped;
      this.repos.inventory.add({ item_id: result.unequipped, item_name: oldName, quantity: 1 });
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
    this.repos.inventory.add({ item_id: result.unequipped.id, item_name: result.unequipped.name, quantity: 1 });
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
      const { enemy } = CombatEngine.pickEnemy(this.data.enemies, realmOrder, false, this.rng);
      const combat = CombatEngine.initCombatState(enemy, diff);
      this.repos.run.update({ fsm_state: STATES.COMBAT, metadata: CombatEngine.serializeCombatState(combat) });
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
    const step = Travel.travelStep(travelData.stepTypes, travelData.scenarios, run.luck, flags, this.rng);

    if (step.type === 'combat') {
      const realm = this.data.realmById[run.realm_id];
      const diff = this.difficultyMultiplier(run) * (step.scenario.enemyDifficulty || 1.0);
      const isBoss = step.scenario.isBoss || false;
      const { enemy } = CombatEngine.pickEnemy(this.data.enemies, realm.order, isBoss, this.rng);
      const combat = CombatEngine.initCombatState(enemy, diff);
      this.repos.run.update({ fsm_state: STATES.COMBAT, metadata: CombatEngine.serializeCombatState(combat) });
      return { ok: true, type: step.type, icon: step.icon, scenario: step.scenario, combat };
    }

    // Scenario có choices -> chuyển IN_EVENT, lưu scenario để renderer gọi resolveTravelChoice
    if (step.scenario.choices && Array.isArray(step.scenario.choices)) {
      const meta = this._parseMeta(run.metadata) || {};
      meta._travelScenario = step.scenario;
      this.repos.run.update({
        fsm_state: STATES.IN_EVENT,
        metadata: JSON.stringify(meta)
      });
      return { ok: true, type: step.type, icon: step.icon, scenario: step.scenario, state: STATES.IN_EVENT };
    }

    // Non-combat: resolve ngay
    const result = Travel.resolveTravelReward(run, step.scenario, this.rng);
    const updates = { hp: run.hp, linh_khi: run.linh_khi, linh_khi_max: run.linh_khi_max, tu_vi: run.tu_vi, spirit_stones: run.spirit_stones, luck: run.luck, tuoi_tho: run.tuoi_tho };
    this.repos.run.update(updates);

    // Xử lý item reward
    let itemReward = null;
    if (step.scenario.reward?.item) {
      itemReward = step.scenario.reward.item;
      this.repos.inventory.add({ item_id: itemReward, item_name: itemReward, quantity: 1 });
    }
    if (result.reward?.item) {
      itemReward = result.reward.item;
      this.repos.inventory.add({ item_id: itemReward, item_name: itemReward, quantity: 1 });
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
    this.repos.inventory.add({ item_id: shopItemId, item_name: shopItemId, quantity: 1 });

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

    if (outcome === 'success' && reward) {
      if (reward.spiritStones) run.spirit_stones += reward.spiritStones;
      if (reward.tuVi) run.tu_vi += reward.tuVi;
      if (reward.item) this.repos.inventory.add({ item_id: reward.item, item_name: reward.item, quantity: 1 });
      if (reward.linhKhiBonus) { run.linh_khi_max += reward.linhKhiBonus; run.linh_khi += reward.linhKhiBonus; }
      if (reward.fullHeal) { run.hp = run.hp_max; run.linh_khi = run.linh_khi_max; }
      message += ` → Thành công!`;
    } else if (outcome === 'failure' && risk !== 'none') {
      const hpLoss = Math.floor(run.hp_max * 0.2);
      run.hp = Math.max(1, run.hp - hpLoss);
      message += ` → Thất bại! Mất ${hpLoss} HP.`;
    }

    // Clear travel scenario, return to IDLE
    delete meta._travelScenario;
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

module.exports = { GameService };
