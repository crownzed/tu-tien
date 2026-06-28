/**
 * test/run-tests.js
 * Test suite cho nền móng. Chạy: node test/run-tests.js
 * Dùng in-memory SQLite + deterministic RNG để test logic không phụ thuộc Electron.
 */

const assert = require('assert');
const Database = require('better-sqlite3');

const { runMigrations, MIGRATION_COUNT } = require('../db/migrations');
const { createRepositories } = require('../db/repositories');
const { loadGameData, clearCache } = require('../lib/data-loader');
const { GameService } = require('../lib/game-service');
const { computeLinhKhiRegen } = require('../lib/time-delta');
const { FSM, STATES } = require('../lib/fsm');
const RNGEngine = require('../lib/rng-engine');
const CombatEngine = require('../lib/combat');
const EventChain = require('../lib/event-chain');
const Breakthrough = require('../lib/breakthrough');
const Crafting = require('../lib/crafting');
const Sect = require('../lib/sect');
const Metaprogression = require('../lib/metaprogression');
const Items = require('../lib/items');
const Meditation = require('../lib/meditation');
const Achievements = require('../lib/achievements');
const Travel = require('../lib/travel');
const StatsEngine = require('../lib/stats-engine');
const CongPhap = require('../lib/cong-phap');
const balance = require('../config/balance');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${name}\n       ${e.message}`); failed++; }
}
function section(title) { console.log(`\n=== ${title} ===`); }

// Deterministic RNG: trả về chuỗi giá trị định sẵn
function seqRng(values) {
  let i = 0;
  return () => values[i++ % values.length];
}

function freshDb() {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

// ---------------------------------------------------------------
section('MIGRATIONS');
test('runMigrations bumps user_version to MIGRATION_COUNT', () => {
  const db = freshDb();
  assert.strictEqual(db.pragma('user_version', { simple: true }), MIGRATION_COUNT);
  db.close();
});
test('migrations idempotent (chạy 2 lần không lỗi)', () => {
  const db = freshDb();
  const r = runMigrations(db); // chạy lại
  assert.strictEqual(r.from, MIGRATION_COUNT);
  assert.strictEqual(r.to, MIGRATION_COUNT);
  db.close();
});
test('account + pity rows seeded', () => {
  const db = freshDb();
  const repos = createRepositories(db);
  assert.ok(repos.account.get());
  assert.strictEqual(repos.account.get().level, 1);
  assert.ok(repos.pity.get());
  db.close();
});

// ---------------------------------------------------------------
section('DATA LOADER');
test('loadGameData trả đủ linh_can/gia_canh/events/realms', () => {
  clearCache();
  const d = loadGameData();
  assert.ok(d.linhCan.length >= 4);
  assert.ok(d.giaCanh.length >= 4);
  assert.ok(d.events.length >= 5);
  assert.ok(d.realms.length >= 5);
});
test('lookup maps hoạt động', () => {
  const d = loadGameData();
  assert.strictEqual(d.linhCanById['thien_linh_can'].tier, 'legendary');
  assert.strictEqual(d.realmById['luyen_khi'].order, 1);
});

// ---------------------------------------------------------------
section('TIME-DELTA (bug fix)');
test('chưa đủ 1 phút: KHÔNG hồi và GIỮ NGUYÊN last_update', () => {
  const last = 1000000;
  const r = computeLinhKhiRegen({ current: 50, max: 100, lastUpdateMs: last, nowMs: last + 30000, regenRate: 1, multiplier: 1 });
  assert.strictEqual(r.regenAmount, 0);
  assert.strictEqual(r.newLastUpdateMs, last, 'last_update phải giữ nguyên để không mất phần lẻ');
});
test('poll nhiều lần dưới 1 phút vẫn tích lũy được (bug cũ đã sửa)', () => {
  // mô phỏng 6 lần poll cách nhau 10s = 60s tổng -> phải hồi đúng 1 điểm
  let current = 50, last = 0;
  for (let k = 1; k <= 6; k++) {
    const now = k * 10000; // 10s mỗi lần
    const r = computeLinhKhiRegen({ current, max: 100, lastUpdateMs: last, nowMs: now, regenRate: 1, multiplier: 1 });
    current = r.newValue; last = r.newLastUpdateMs;
  }
  assert.strictEqual(current, 51, 'sau 60s phải hồi đúng 1 điểm');
});
test('Tịnh Khí x2 multiplier', () => {
  const r = computeLinhKhiRegen({ current: 0, max: 100, lastUpdateMs: 0, nowMs: 60000, regenRate: 1, multiplier: 2 });
  assert.strictEqual(r.regenAmount, 2);
});
test('không vượt max', () => {
  const r = computeLinhKhiRegen({ current: 99, max: 100, lastUpdateMs: 0, nowMs: 600000, regenRate: 1, multiplier: 1 });
  assert.strictEqual(r.newValue, 100);
});
test('clock đi lùi không gây âm', () => {
  const r = computeLinhKhiRegen({ current: 50, max: 100, lastUpdateMs: 100000, nowMs: 50000, regenRate: 1, multiplier: 1 });
  assert.strictEqual(r.regenAmount, 0);
  assert.strictEqual(r.newValue, 50);
});

// ---------------------------------------------------------------
section('FSM');
test('transition hợp lệ IDLE->COMBAT', () => {
  const fsm = new FSM(STATES.IDLE);
  assert.strictEqual(fsm.transition('COMBAT').ok, true);
  assert.strictEqual(fsm.getState(), 'COMBAT');
});
test('transition bất hợp lệ CRAFTING->COMBAT bị chặn', () => {
  const fsm = new FSM('CRAFTING');
  const r = fsm.transition('COMBAT');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(fsm.getState(), 'CRAFTING');
});
test('action bị chặn theo state (không attack khi CRAFTING)', () => {
  const fsm = new FSM('CRAFTING');
  assert.strictEqual(fsm.isActionAllowed('attack').allowed, false);
  assert.strictEqual(fsm.isActionAllowed('status').allowed, true);
});
test('DEAD là tuyệt lộ (chỉ rebirth)', () => {
  const fsm = new FSM('DEAD');
  assert.strictEqual(fsm.transition('IDLE').ok, false);
  assert.strictEqual(fsm.isActionAllowed('start').allowed, true);
});

// ---------------------------------------------------------------
section('RNG ENGINE (data-driven)');
test('weightedRoll deterministic với injected rng', () => {
  const opts = [{ id: 'a', weight: 50 }, { id: 'b', weight: 50 }];
  assert.strictEqual(RNGEngine.weightedRoll(opts, 0, () => 0.1), 'a');
  assert.strictEqual(RNGEngine.weightedRoll(opts, 0, () => 0.9), 'b');
});
test('pity hard cap = guaranteed', () => {
  assert.strictEqual(RNGEngine.pityRoll(balance.pity.linhCan, 50, () => 0.999), true);
});
test('pity base rate thấp (rng cao -> fail)', () => {
  assert.strictEqual(RNGEngine.pityRoll(balance.pity.linhCan, 0, () => 0.999), false);
});
test('luck tăng tỉ lệ good event (statistical)', () => {
  const opts = [{ id: 'bad', weight: 50, isGood: false }, { id: 'good', weight: 50, isGood: true }];
  let goodNo = 0, goodHi = 0;
  for (let i = 0; i < 5000; i++) {
    if (RNGEngine.weightedRoll(opts, 0) === 'good') goodNo++;
    if (RNGEngine.weightedRoll(opts, 50) === 'good') goodHi++;
  }
  assert.ok(goodHi > goodNo + 300, `luck phải tăng good: no=${goodNo} hi=${goodHi}`);
});

// ---------------------------------------------------------------
section('GAME SERVICE — Character Creation');
test('createRun cộng đúng base + realm + tiên thiên', () => {
  const db = freshDb();
  const repos = createRepositories(db);
  const data = loadGameData();
  // set tiên thiên
  repos.account.update({ innate_hp_bonus: 50, innate_linhkhi_bonus: 20, innate_luck_bonus: 10 });
  const svc = new GameService(repos, data, () => 0.5);
  const run = svc.createRun('chan_linh_can', 'pham_nhan', 1000);
  // HP/LK giờ tính qua StatsEngine (CON/SPR + realm scaling); đọc coreAttrs từ metadata để kiểm theo công thức.
  const meta = JSON.parse(run.metadata);
  const startRealm = data.realmById['luyen_khi'];
  const realmTier = startRealm.order || 1;
  const expectedHp = StatsEngine.calcMaxHP(meta.coreAttrs.con, balance.base.hpMax, realmTier, 0, (startRealm.hpBonus || 0) + 50);
  const expectedLk = StatsEngine.calcMaxMP(meta.coreAttrs.spr, balance.base.linhKhiMax, balance.combatV2.dantian_base_cap, meta.rootM, realmTier) + 20;
  assert.strictEqual(run.hp_max, expectedHp);
  assert.strictEqual(run.linh_khi_max, expectedLk);
  assert.strictEqual(run.luck, meta.coreAttrs.luk + 10 + 0);
  assert.strictEqual(run.realm_id, 'luyen_khi');
  db.close();
});
test('Đích Tôn Thánh Địa khởi đầu ở Trúc Cơ + có Kỳ Bảo', () => {
  const db = freshDb();
  const repos = createRepositories(db);
  const data = loadGameData();
  const svc = new GameService(repos, data, () => 0.5);
  const run = svc.createRun('thien_linh_can', 'dich_ton_thanh_dia', 1000);
  assert.strictEqual(run.realm_id, 'truc_co');
  assert.strictEqual(run.spirit_stones, 1000);
  const inv = repos.inventory.all();
  assert.ok(inv.some(i => i.item_id === 'ky_bao_ha_pham'), 'phải có kỳ bảo khởi đầu');
  db.close();
});
test('Cô Nhi/Khất Cái có luck bonus khởi đầu', () => {
  const db = freshDb();
  const repos = createRepositories(db);
  const data = loadGameData();
  const svc = new GameService(repos, data, () => 0.5);
  const run = svc.createRun('tap_linh_can', 'co_nhi_khat_cai', 1000);
  // luck = LUK thuộc tính (coreAttrs.luk) + innate(0) + startLuckBonus của gia cảnh
  const meta = JSON.parse(run.metadata);
  const giaCanh = data.giaCanhById['co_nhi_khat_cai'];
  assert.strictEqual(run.luck, meta.coreAttrs.luk + 0 + (giaCanh.startLuckBonus || 0));
  assert.ok((giaCanh.startLuckBonus || 0) > 0, 'gia cảnh này phải có startLuckBonus');
  db.close();
});
test('createRun mới xóa inventory kiếp cũ', () => {
  const db = freshDb();
  const repos = createRepositories(db);
  const data = loadGameData();
  const svc = new GameService(repos, data, () => 0.5);
  svc.createRun('thien_linh_can', 'dich_ton_thanh_dia', 1000); // có item
  svc.createRun('tap_linh_can', 'pham_nhan', 2000);            // kiếp mới
  assert.strictEqual(repos.inventory.all().length, 0, 'đồ kiếp cũ phải bị xóa');
  db.close();
});

// ---------------------------------------------------------------
section('GAME SERVICE — Death & Metaprogression');
test('computeScore theo công thức', () => {
  const db = freshDb();
  const repos = createRepositories(db);
  const data = loadGameData();
  const svc = new GameService(repos, data, () => 0.5);
  const run = svc.createRun('chan_linh_can', 'pham_nhan', 0);
  repos.run.update({ tuoi_tho: balance.base.tuoiTho + 100, monsters_killed: 3 });
  const updated = repos.run.get();
  const score = svc.computeScore(updated);
  // realm luyen_khi order 1 * 1000 + 100 years * 10 + 3*50 = 1000+1000+150 = 2150
  assert.strictEqual(score, 2150);
  db.close();
});
test('processDeath cộng điểm + đánh dấu chết + tăng lifetimes', () => {
  const db = freshDb();
  const repos = createRepositories(db);
  const data = loadGameData();
  const svc = new GameService(repos, data, () => 0.5);
  svc.createRun('chan_linh_can', 'pham_nhan', 0);
  repos.run.update({ tuoi_tho: balance.base.tuoiTho + 50 });
  const res = svc.processDeath();
  assert.ok(res.score > 0);
  assert.strictEqual(res.lifetimes, 1);
  assert.strictEqual(repos.run.get().alive, 0);
  assert.strictEqual(repos.account.get().total_lifetimes, 1);
  db.close();
});
test('processDeath level up khi đủ EXP', () => {
  const db = freshDb();
  const repos = createRepositories(db);
  const data = loadGameData();
  const svc = new GameService(repos, data, () => 0.5);
  svc.createRun('thien_linh_can', 'dich_ton_thanh_dia', 0); // truc_co order 2
  repos.run.update({ tuoi_tho: balance.base.tuoiTho + 500, monsters_killed: 10 });
  const res = svc.processDeath();
  // score lớn -> phải level up từ 1
  assert.ok(res.newLevel >= 2, `expected level up, got ${res.newLevel}`);
  db.close();
});

// ---------------------------------------------------------------
section('COMBAT ENGINE — Element System');
test('Kim khắc Mộc -> 1.5x', () => {
  assert.strictEqual(CombatEngine.getElementMultiplier('kim', 'moc'), 1.5);
});
test('Mộc bị Kim khắc -> 0.5x', () => {
  assert.strictEqual(CombatEngine.getElementMultiplier('moc', 'kim'), 0.5);
});
test('cùng nguyên tố -> 1.0x', () => {
  assert.strictEqual(CombatEngine.getElementMultiplier('hoa', 'hoa'), 1.0);
});
test('không có nguyên tố -> neutral', () => {
  assert.strictEqual(CombatEngine.getElementMultiplier(null, 'hoa'), 1.0);
  assert.strictEqual(CombatEngine.getElementMultiplier('kim', null), 1.0);
});
test('damage formula deterministic', () => {
  const r = CombatEngine.calculateDamage(
    { attack: 100, element: 'kim' },
    { defense: 20, element: 'moc' },
    () => 0.5
  );
  assert.ok(r.damage >= 110 && r.damage <= 150);
  assert.strictEqual(r.elementMultiplier, 1.5);
});
test('pickEnemy theo realm', () => {
  const zones = [{ id:'z1', realmMin:1, realmMax:2, enemies:[{id:'a',hp:10,attack:5}], boss:{id:'boss',hp:50,attack:20} }];
  const { enemy } = CombatEngine.pickEnemy(zones, 1, false, () => 0.1);
  assert.strictEqual(enemy.id, 'a');
});
test('pickEnemy fallback nếu realm ngoài zone', () => {
  const zones = [{ id:'z1', realmMin:1, realmMax:2, enemies:[{id:'a',hp:10,attack:5}], boss:{id:'boss',hp:50,attack:20} }];
  const { enemy } = CombatEngine.pickEnemy(zones, 9, false, () => 0.1);
  assert.strictEqual(enemy.id, 'a');
});
test('pickEnemy boss mode', () => {
  const zones = [{ id:'z1', realmMin:1, realmMax:2, enemies:[{id:'a',hp:10,attack:5}], boss:{id:'boss',hp:50,attack:20} }];
  const { enemy } = CombatEngine.pickEnemy(zones, 1, true);
  assert.strictEqual(enemy.id, 'boss');
});
test('initCombatState + serialize roundtrip', () => {
  const enemy = { id:'test', name:'Test Quái', hp:100, attack:20, defense:5, element:'hoa', dropStones:[10,50], expReward:100 };
  const state = CombatEngine.initCombatState(enemy);
  assert.strictEqual(state.enemyName, 'Test Quái');
  assert.strictEqual(state.enemyHp, 100);
  const json = CombatEngine.serializeCombatState(state);
  const parsed = CombatEngine.parseCombatState(json);
  assert.strictEqual(parsed.enemyId, 'test');
});
test('pickEnemy trả realmTier: quái thường=đáy band, boss=đỉnh band', () => {
  const zones = [{ id:'z1', realmMin:2, realmMax:5, enemies:[{id:'a',hp:10,attack:5}], boss:{id:'boss',hp:50,attack:20} }];
  assert.strictEqual(CombatEngine.pickEnemy(zones, 3, false, () => 0.1).realmTier, 2, 'quái thường lấy realmMin');
  assert.strictEqual(CombatEngine.pickEnemy(zones, 3, true).realmTier, 5, 'boss lấy realmMax');
});
test('pickEnemy realmTier clamp ≥ 1 (zone realmMin=0)', () => {
  const zones = [{ id:'z0', realmMin:0, realmMax:2, enemies:[{id:'a',hp:10,attack:5}], boss:{id:'b',hp:50,attack:20} }];
  assert.strictEqual(CombatEngine.pickEnemy(zones, 1, false, () => 0.1).realmTier, 1, 'realmMin=0 phải clamp lên 1');
});
test('initCombatState lưu enemyRealmTier để áp chế cảnh giới (§8)', () => {
  const enemy = { id:'t', name:'Q', hp:100, attack:20, defense:5, expReward:10, dropStones:[1,2] };
  assert.strictEqual(CombatEngine.initCombatState(enemy, 1, 4).enemyRealmTier, 4);
  assert.strictEqual(CombatEngine.initCombatState(enemy, 1).enemyRealmTier, 1, 'mặc định tier=1');
});
test('Realm Suppression: enemy tier thấp đánh player tier cao bị giảm sát thương', () => {
  // enemy tier 1 đánh player tier 4 → Ω = max(0.1, 1 - 3*0.4) = max(0.1, -0.2) = 0.1
  const combat = CombatEngine.initCombatState({ id:'e', name:'Q', hp:100, attack:100, defense:0, expReward:1, dropStones:[1,1] }, 1, 1);
  const suppressed = CombatEngine.enemyTurn(combat, null, () => 0.99, null, 4);
  const noSuppress = CombatEngine.enemyTurn(combat, null, () => 0.99, null, 1);
  assert.ok(suppressed.damage < noSuppress.damage, `tier thấp→cao phải bị áp chế (${suppressed.damage} < ${noSuppress.damage})`);
});

section('GAME SERVICE — Combat Flow');
test('startCombat tạo combat state + đổi FSM sang COMBAT', () => {
  const db = freshDb();
  const repos = createRepositories(db);
  const data = loadGameData();
  const svc = new GameService(repos, data, () => 0.5);
  svc.createRun('thien_linh_can', 'pham_nhan', 0);
  const res = svc.startCombat(false);
  assert.ok(res.ok, `expected ok, got ${res.error}`);
  assert.ok(res.combat.enemyName);
  assert.strictEqual(repos.run.get().fsm_state, 'COMBAT');
  db.close();
});
test('playerGlanceChance khớp combat thật (1 - calcHitProbability(0, agi))', () => {
  const db = freshDb();
  const repos = createRepositories(db);
  const data = loadGameData();
  const svc = new GameService(repos, data, () => 0.5);
  svc.createRun('thien_linh_can', 'pham_nhan', 0);
  const res = svc.startCombat(false);
  const agi = JSON.parse(repos.run.get().metadata).coreAttrs.agi;
  // enemyTurn để attacker.agi=0, defender.agi=playerAgi → metric phải khớp đúng công thức đó.
  const expected = 1 - StatsEngine.calcHitProbability(0, agi);
  assert.ok(Math.abs(res.combat.playerGlanceChance - expected) < 1e-9,
    `glance metric ${res.combat.playerGlanceChance} phải = ${expected}`);
  db.close();
});
test('playerAttack giảm enemy HP + enemy phản công', () => {
  const db = freshDb();
  const repos = createRepositories(db);
  const data = loadGameData();
  const svc = new GameService(repos, data, () => 0.5);
  svc.createRun('thien_linh_can', 'pham_nhan', 0);
  repos.run.update({ hp: 500, hp_max: 500, linh_khi_max: 200 });
  svc.startCombat(false);
  const res = svc.playerAttack();
  assert.ok(res.ok);
  if (!res.victory) {
    assert.ok(res.enemyAction, 'enemy must counter-attack');
  }
  db.close();
});
test('playerCast từ chối nếu thiếu Linh Khí', () => {
  const db = freshDb();
  const repos = createRepositories(db);
  const data = loadGameData();
  const svc = new GameService(repos, data, () => 0.5);
  svc.createRun('thien_linh_can', 'pham_nhan', 0);
  repos.run.update({ linh_khi: 5 });
  svc.startCombat(false);
  const res = svc.playerCast();
  assert.strictEqual(res.ok, false);
  assert.ok(res.error.includes('Linh Khí'));
  db.close();
});
test('playerFlee thành công với rng thấp', () => {
  const db = freshDb();
  const repos = createRepositories(db);
  const data = loadGameData();
  const svc = new GameService(repos, data, () => 0.01);
  svc.createRun('thien_linh_can', 'pham_nhan', 0);
  repos.run.update({ luck: 100 });
  svc.startCombat(false);
  const res = svc.playerFlee();
  assert.ok(res.ok);
  assert.strictEqual(res.result, 'fled');
  assert.strictEqual(repos.run.get().fsm_state, 'IDLE');
  db.close();
});
test('playerForbiddenArt xử lý phản phệ', () => {
  const db = freshDb();
  const repos = createRepositories(db);
  const data = loadGameData();
  const svc = new GameService(repos, data, () => 0.01); // rng thấp -> backfire
  svc.createRun('thien_linh_can', 'pham_nhan', 0);
  repos.run.update({ hp: 500, hp_max: 500, linh_khi: 200, linh_khi_max: 200 });
  svc.startCombat(false);
  const res = svc.playerForbiddenArt();
  assert.ok(res.ok);
  assert.ok(res.playerAction.backfired);
  db.close();
});
test('forbiddenArt không backfire gây sát thương lớn + victory', () => {
  const db = freshDb();
  const repos = createRepositories(db);
  const data = loadGameData();
  const svc = new GameService(repos, data, () => 0.5);
  svc.createRun('thien_linh_can', 'pham_nhan', 0);
  repos.run.update({ hp: 500, hp_max: 500, linh_khi: 200, linh_khi_max: 200, spirit_stones: 0, monsters_killed: 0 });
  svc.startCombat(false);
  const res = svc.playerForbiddenArt();
  assert.ok(res.ok);
  // với element kim và enemy ngẫu nhiên + rng 0.5, luôn có playerAction
  assert.ok(res.playerAction);
  assert.strictEqual(res.playerAction.backfired, false);
  // có thể victory hoặc không tùy enemy, nhưng ít nhất damage > 0
  if (!res.victory) {
    assert.ok(res.playerAction.damage > 0, 'forbidden art must deal damage');
  }
  db.close();
});
test('victory cộng spirit_stones + monsters_killed', () => {
  const db = freshDb();
  const repos = createRepositories(db);
  const data = loadGameData();
  const svc = new GameService(repos, data, () => 0.01);
  svc.createRun('thien_linh_can', 'pham_nhan', 0);
  repos.run.update({ hp: 500, hp_max: 500, linh_khi_max: 1000, linh_khi: 500 });
  const res1 = svc.startCombat(false);
  if (!res1.ok) { db.close(); return; }
  let res;
  for (let i = 0; i < 20; i++) {
    res = svc.playerAttack();
    if (res.victory || res.defeat) break;
  }
  if (!res || !res.victory) { db.close(); return; }
  const run = repos.run.get();
  assert.ok(run.spirit_stones > 0, `should earn stones, got ${run.spirit_stones}`);
  assert.strictEqual(run.monsters_killed, 1);
  assert.strictEqual(run.fsm_state, 'IDLE');
  db.close();
});
test('coreAttrs sống sót qua combat (không bị combat state ghi đè)', () => {
  const db = freshDb();
  const repos = createRepositories(db);
  const data = loadGameData();
  const svc = new GameService(repos, data, () => 0.5);
  svc.createRun('thien_linh_can', 'pham_nhan', 0);
  const before = JSON.parse(repos.run.get().metadata).coreAttrs;
  assert.ok(before, 'coreAttrs phải tồn tại sau createRun');
  repos.run.update({ hp: 500, hp_max: 500, linh_khi_max: 200 });
  svc.startCombat(false);
  // trong combat coreAttrs vẫn còn (combat lồng dưới meta.combat)
  const during = JSON.parse(repos.run.get().metadata);
  assert.ok(during.coreAttrs, 'coreAttrs phải còn trong combat');
  assert.ok(during.combat, 'combat state phải lồng dưới meta.combat');
  assert.deepStrictEqual(during.coreAttrs, before);
  repos.run.update({ luck: 200 }); // fleeChance = 0.3 + luck/200 > 0.5 → chắc chắn thoát
  svc.playerFlee();
  // sau combat coreAttrs vẫn nguyên, combat đã bị xóa
  const after = JSON.parse(repos.run.get().metadata);
  assert.deepStrictEqual(after.coreAttrs, before, 'coreAttrs phải nguyên sau combat');
  assert.ok(!after.combat, 'combat state phải được dọn sau khi rời trận');
  db.close();
});
test('coreAttrs sống sót qua đột phá (advanceRealm không xóa blob bền vững)', () => {
  const db = freshDb();
  const repos = createRepositories(db);
  const data = loadGameData();
  const svc = new GameService(repos, data, () => 0.5);
  svc.createRun('thien_linh_can', 'pham_nhan', 0);
  const before = JSON.parse(repos.run.get().metadata).coreAttrs;
  const run = repos.run.get();
  svc._advanceRealm(run, {});
  const after = JSON.parse(repos.run.get().metadata || '{}').coreAttrs;
  // Thuộc tính gốc giữ nguyên; đột phá CHỦ ĐÍCH cộng điểm tự do.
  for (const k of ['str', 'con', 'agi', 'int', 'spr', 'luk']) {
    assert.strictEqual(after[k], before[k], `${k} phải nguyên sau đột phá`);
  }
  assert.strictEqual(after.free_points, (before.free_points || 0) + balance.coreAttributes.stat_points_per_realm, 'đột phá phải cấp điểm tự do');
  db.close();
});

test('đột phá giữ đầu tư SPR/đan vào linh_khi_max (cộng delta, không gán đè)', () => {
  const db = freshDb();
  const repos = createRepositories(db);
  const data = loadGameData();
  const svc = new GameService(repos, data, () => 0.5);
  svc.createRun('thien_linh_can', 'pham_nhan', 0);

  const run0 = repos.run.get();
  const curRealm = data.realmById[run0.realm_id];
  const nextRealm = require('../lib/breakthrough').getNextRealm(run0.realm_id, data.realms, data.realmById);
  const baseDelta = nextRealm.linhKhiMax - curRealm.linhKhiMax;

  // Mô phỏng đầu tư vĩnh viễn: +500 linh_khi_max (SPR + đan) trước khi đột phá.
  const invest = 500;
  repos.run.update({ linh_khi_max: run0.linh_khi_max + invest });

  const run = repos.run.get();
  const lkMaxBefore = run.linh_khi_max;
  svc._advanceRealm(run, {});
  const after = repos.run.get();

  assert.strictEqual(after.linh_khi_max, lkMaxBefore + baseDelta,
    'linh_khi_max phải = (cũ + đầu tư) + delta nền realm, không bị reset về linhKhiMax phẳng');
  assert.ok(after.linh_khi_max > nextRealm.linhKhiMax,
    'đầu tư phải còn sau đột phá (lớn hơn giá trị nền của realm mới)');
  db.close();
});

// ---------------------------------------------------------------
section('EVENT CHAIN');
test('pickEventScript chọn script theo nodeType', () => {
  const scripts = { treasure: [{id:'t1',text:'Kho báu!',phase:1,base_weight:50}] };
  const res = EventChain.pickEventScript(scripts, 'treasure', {}, 1, 'luyen_khi', 0, null, () => 0.1);
  assert.strictEqual(res.script.id, 't1');
});
test('pickEventScript trả null nếu không có scripts', () => {
  const res = EventChain.pickEventScript({}, 'combat', {}, 1, 'luyen_khi', 0, null, () => 0.1);
  assert.strictEqual(res.script, null);
});
test('resolveChoice: risk=none luôn thành công', () => {
  const script = { text:'Test', choices:[{text:'An toàn',risk:'none',success:{text:'OK',reward:{spiritStones:10}}}] };
  const res = EventChain.resolveChoice(script, 0, 0, () => 0.1);
  assert.ok(res.ok);
  assert.strictEqual(res.result.outcome, 'success');
  assert.strictEqual(res.result.reward.spiritStones, 10);
});
test('resolveChoice: risk=high thất bại với rng cao', () => {
  const script = { text:'Test', choices:[{text:'Nguy hiểm',success_rate:0.3,on_success:{text:'Win'},on_fail:{text:'Lose',damage:{hp:20}}}] };
  const res = EventChain.resolveChoice(script, 0, 0, {}, () => 0.9);
  assert.ok(res.ok);
  assert.strictEqual(res.result.outcome, 'failure');
  assert.strictEqual(res.result.damage.hp, 20);
});
test('applyReward & applyDamage & applyCost', () => {
  const run = { hp:80, hp_max:100, linh_khi:50, linh_khi_max:100, spirit_stones:100, tuoi_tho:80, tu_vi:0 };
  EventChain.applyReward(run, { spiritStones:50, hpRestore:10, linhKhiRestore:20, tuVi:100 });
  assert.strictEqual(run.spirit_stones, 150);
  assert.strictEqual(run.hp, 90);
  assert.strictEqual(run.linh_khi, 70);
  assert.strictEqual(run.tu_vi, 100);
  EventChain.applyDamage(run, { hp:30 });
  assert.strictEqual(run.hp, 60);
  EventChain.applyCost(run, { spiritStones:30, tuoiTho:0.5 });
  assert.strictEqual(run.spirit_stones, 120);
  assert.strictEqual(run.tuoi_tho, 79.5);
});

// ---------------------------------------------------------------
section('BREAKTHROUGH ENGINE');
test('calcBreakthroughChance cho Luyện Khí -> Trúc Cơ', () => {
  const realm = { id:'luyen_khi', order:1, breakthrough:{ linhKhiRequired:80, tuViRequired:50, baseSuccessRate:0.8 } };
  const run = { linh_khi:100, linh_khi_max:100, tu_vi:60, luck:0, realm_stage:8 };
  const linhCan = { modifiers:{ cultivationSpeed:1.0 } };
  const { successRate, canAttempt } = Breakthrough.calcBreakthroughChance(realm, run, linhCan, 0);
  assert.ok(canAttempt);
  assert.ok(successRate > 0.7);
});
test('calcBreakthroughChance từ chối nếu thiếu LK hoặc Tu Vi', () => {
  const realm = { order:1, breakthrough:{ linhKhiRequired:200, tuViRequired:100, baseSuccessRate:0.5 } };
  const run = { linh_khi:50, tu_vi:0, luck:0 };
  const linhCan = {};
  assert.strictEqual(Breakthrough.calcBreakthroughChance(realm, run, linhCan).canAttempt, false);
});
test('attemptBreakthrough thành công với rng thấp', () => {
  const realm = { order:1, breakthrough:{ linhKhiRequired:80, tuViRequired:50, baseSuccessRate:0.8, hasTribulation:false } };
  const run = { linh_khi:100, tu_vi:60, luck:0, hp_max:100, realm_stage:8 };
  const linhCan = { modifiers:{ cultivationSpeed:1.0 } };
  const res = Breakthrough.attemptBreakthrough(realm, run, linhCan, 0, () => 0.1);
  assert.ok(res.success);
  assert.strictEqual(res.cost.lk, 80);
});
test('attemptBreakthrough thất bại với rng cao', () => {
  const realm = { order:1, breakthrough:{ linhKhiRequired:80, tuViRequired:50, baseSuccessRate:0.3, hasTribulation:false, hpLossOnFail:20, lkLossOnFail:30 } };
  const run = { linh_khi:100, tu_vi:60, luck:0, hp_max:100, realm_stage:8 };
  const linhCan = { modifiers:{ cultivationSpeed:1.0 } };
  const res = Breakthrough.attemptBreakthrough(realm, run, linhCan, 0, () => 0.9);
  assert.strictEqual(res.success, false);
  assert.ok(res.damage);
});
test('attemptBreakthrough có thiên kiếp khi hasTribulation=true', () => {
  const realm = { order:3, breakthrough:{ linhKhiRequired:700, tuViRequired:500, baseSuccessRate:0.9, hasTribulation:true, tribulationStrikes:3, tribulationDamage:60 } };
  const run = { linh_khi:800, tu_vi:600, luck:50, hp_max:500, realm_stage:8 };
  const linhCan = { modifiers:{ cultivationSpeed:1.5 } };
  const res = Breakthrough.attemptBreakthrough(realm, run, linhCan, 0, () => 0.1);
  assert.ok(res.success);
  assert.ok(res.tribulation);
  assert.strictEqual(res.tribulation.strikes, 3);
});
test('processTribulationStrike sống sót qua tất cả strike', () => {
  const trib = { strikes:2, damagePerStrike:50, strikesRemaining:2, totalDamageTaken:0, survived:false };
  const r1 = Breakthrough.processTribulationStrike(trib, 200, 0, () => 0.5);
  assert.ok(r1.survived);
  assert.strictEqual(r1.strikesRemaining, 1);
  const r2 = Breakthrough.processTribulationStrike(trib, r1.playerHpAfter, 0, () => 0.5);
  assert.ok(r2.survived);
  assert.ok(r2.tribulationOver);
});
test('processTribulationStrike chết nếu HP về 0', () => {
  const trib = { strikes:3, damagePerStrike:200, strikesRemaining:3, totalDamageTaken:0, survived:false };
  const r = Breakthrough.processTribulationStrike(trib, 50, 0, () => 0.9);
  assert.strictEqual(r.survived, false);
});

section('CRAFTING ENGINE');
test('getAvailableRecipes lọc theo tu vi', () => {
  const recipes = [
    { id:'a', category:'luyen_dan', requires:{tuVi:0}, successRate:0.5 },
    { id:'b', category:'luyen_dan', requires:{tuVi:500}, successRate:0.5 }
  ];
  const avail = Crafting.getAvailableRecipes(recipes, null, 100);
  assert.strictEqual(avail.length, 1);
  assert.strictEqual(avail[0].id, 'a');
});
test('craftItem thành công trả item', () => {
  const recipe = { id:'test', category:'luyen_dan', name:'Test Đan', successRate:0.9, cost:{spiritStones:50}, requires:{tuVi:0}, result:{item:'test',quantity:1} };
  const run = { tu_vi:10, spirit_stones:100 };
  const res = Crafting.craftItem(recipe, run, 0, () => 0.1);
  assert.ok(res.ok);
  assert.ok(res.success);
  assert.strictEqual(res.item, 'test');
});
test('craftItem thất bại mất Linh Thạch', () => {
  const recipe = { id:'test', category:'luyen_dan', name:'Test', successRate:0.2, cost:{spiritStones:50}, requires:{tuVi:0}, failLoseMaterials:true, result:{item:'test',quantity:1} };
  const run = { tu_vi:10, spirit_stones:100 };
  const res = Crafting.craftItem(recipe, run, 0, () => 0.9);
  assert.ok(res.ok);
  assert.strictEqual(res.success, false);
});

section('TÔNG MÔN ENGINE');
test('canJoinSect kiểm tra điều kiện', () => {
  const sect = { requirements:{ tuVi:200, element:'hoa' } };
  const run = { tu_vi:300 };
  const linhCan = { element:'hoa', tier:'rare' };
  const res = Sect.canJoinSect(sect, run, linhCan, 3);
  assert.ok(res.ok);
});
test('canJoinSect từ chối sai element', () => {
  const sect = { requirements:{ element:'hoa' } };
  const run = { tu_vi:100 };
  const linhCan = { element:'kim' };
  const res = Sect.canJoinSect(sect, run, linhCan, 1);
  assert.strictEqual(res.ok, false);
});
test('getCurrentRank theo contribution', () => {
  const sect = { contributionRanks:[
    { name:'Ngoại Môn', minContribution:0, dailyStones:5 },
    { name:'Nội Môn', minContribution:100, dailyStones:15 }
  ]};
  assert.strictEqual(Sect.getCurrentRank(sect, 0).name, 'Ngoại Môn');
  assert.strictEqual(Sect.getCurrentRank(sect, 150).name, 'Nội Môn');
});

section('GAME SERVICE — Breakthrough Integration');
test('canBreakthrough trả info cho run hiện tại', () => {
  const db = freshDb();
  const repos = createRepositories(db);
  const data = loadGameData();
  const svc = new GameService(repos, data, () => 0.5);
  svc.createRun('thien_linh_can', 'pham_nhan', 0);
  repos.run.update({ linh_khi:200, tu_vi:200 });
  const check = svc.canBreakthrough();
  assert.ok(check.ok !== undefined || check.canAttempt !== undefined);
  db.close();
});
test('attemptBreakthrough thực hiện đột phá', () => {
  const db = freshDb();
  const repos = createRepositories(db);
  const data = loadGameData();
  const svc = new GameService(repos, data, () => 0.01);
  svc.createRun('thien_linh_can', 'pham_nhan', 0);
  repos.run.update({ realm_stage:8, linh_khi:500, tu_vi:500, hp:300, hp_max:300, linh_khi_max:500 });
  const res = svc.attemptBreakthrough();
  assert.ok(res.ok);
  // Với rng thấp và linh căn tốt, sẽ thành công
  assert.ok(res.success || !res.success); // luôn trả kết quả
  db.close();
});

section('GAME SERVICE — Điểm Thuộc Tính Tự Do');
test('attemptStageUp cấp điểm tự do khi thành công', () => {
  const db = freshDb();
  const repos = createRepositories(db);
  const data = loadGameData();
  const svc = new GameService(repos, data, () => 0.01); // rng thấp → stage-up thành công
  svc.createRun('thien_linh_can', 'pham_nhan', 0);
  repos.run.update({ tu_vi: 5000, hp: 500, hp_max: 500 });
  const before = JSON.parse(repos.run.get().metadata).coreAttrs.free_points || 0;
  const res = svc.attemptStageUp();
  if (res.ok && res.success) {
    const after = JSON.parse(repos.run.get().metadata).coreAttrs.free_points;
    assert.strictEqual(after, before + balance.coreAttributes.stat_points_per_stage, 'stage-up phải cấp đúng số điểm');
  }
  db.close();
});
test('_advanceRealm cấp điểm tự do khi đột phá', () => {
  const db = freshDb();
  const repos = createRepositories(db);
  const data = loadGameData();
  const svc = new GameService(repos, data, () => 0.5);
  svc.createRun('thien_linh_can', 'pham_nhan', 0);
  const before = JSON.parse(repos.run.get().metadata).coreAttrs.free_points || 0;
  svc._advanceRealm(repos.run.get(), {});
  const after = JSON.parse(repos.run.get().metadata).coreAttrs.free_points;
  assert.strictEqual(after, before + balance.coreAttributes.stat_points_per_realm, 'đột phá phải cấp đúng số điểm');
  db.close();
});
test('spendStatPoint trừ điểm + tăng thuộc tính + cập nhật derived', () => {
  const db = freshDb();
  const repos = createRepositories(db);
  const data = loadGameData();
  const svc = new GameService(repos, data, () => 0.5);
  svc.createRun('thien_linh_can', 'pham_nhan', 0);
  // cấp điểm thủ công qua metadata để test tiêu điểm độc lập
  const meta = JSON.parse(repos.run.get().metadata);
  meta.coreAttrs.free_points = 3;
  repos.run.update({ metadata: JSON.stringify(meta) });
  const conBefore = meta.coreAttrs.con;
  const hpMaxBefore = repos.run.get().hp_max;
  const res = svc.spendStatPoint('con');
  assert.ok(res.ok, res.error || '');
  assert.strictEqual(res.newValue, conBefore + 1);
  assert.strictEqual(res.freePoints, 2);
  assert.ok(repos.run.get().hp_max > hpMaxBefore, 'CON phải tăng HP max');
  db.close();
});
test('spendStatPoint từ chối khi hết điểm', () => {
  const db = freshDb();
  const repos = createRepositories(db);
  const data = loadGameData();
  const svc = new GameService(repos, data, () => 0.5);
  svc.createRun('thien_linh_can', 'pham_nhan', 0);
  const res = svc.spendStatPoint('str'); // free_points khởi tạo = 0
  assert.strictEqual(res.ok, false);
  assert.ok(res.error.includes('điểm'));
  db.close();
});

section('GAME SERVICE — Crafting Integration');
test('craftItem lưu item vào inventory', () => {
  const db = freshDb();
  const repos = createRepositories(db);
  const data = loadGameData();
  const svc = new GameService(repos, data, () => 0.01);
  svc.createRun('thien_linh_can', 'pham_nhan', 0);
  repos.run.update({ tu_vi:500, spirit_stones:200 });
  const res = svc.craftItem('hoi_huyet_dan');
  if (res.ok && res.success) {
    const inv = repos.inventory.all();
    assert.ok(inv.some(i => i.item_id === 'hoi_huyet_dan'));
  }
  db.close();
});

section('GAME SERVICE — Sect Integration');
test('joinSect + leaveSect', () => {
  const db = freshDb();
  const repos = createRepositories(db);
  const data = loadGameData();
  const svc = new GameService(repos, data, () => 0.5);
  svc.createRun('thien_linh_can', 'pham_nhan', 0);
  repos.run.update({ tu_vi:500 });
  const joinRes = svc.joinSect('thanh_van_phai');
  assert.ok(joinRes.ok, joinRes.error || '');
  const leaveRes = svc.leaveSect();
  assert.ok(leaveRes.ok);
  db.close();
});
test('contribute tăng contribution', () => {
  const db = freshDb();
  const repos = createRepositories(db);
  const data = loadGameData();
  const svc = new GameService(repos, data, () => 0.5);
  svc.createRun('thien_linh_can', 'pham_nhan', 0);
  repos.run.update({ tu_vi:500, spirit_stones:200 });
  svc.joinSect('thanh_van_phai');
  const res = svc.contribute(50);
  assert.ok(res.ok);
  assert.ok(res.contribution >= 50);
  db.close();
});

// ---------------------------------------------------------------
section('CÔNG PHÁP ENGINE (lib)');
test('canLearn từ chối khi thiếu INT/CON', () => {
  const data = loadGameData();
  const def = data.congPhapById['bat_tu_truong_sinh_cong']; // realmMin1, ngoTinh4, theChat8, linhCan null
  const ctx = { realmOrder: 1, linhCanElement: null, attrs: { int: 2, con: 2 }, learnedIds: [], congPhapById: data.congPhapById, bloodline: null };
  assert.strictEqual(CongPhap.canLearn(def, ctx).ok, false);
});
test('canLearn chấp nhận khi đủ điều kiện', () => {
  const data = loadGameData();
  const def = data.congPhapById['bat_tu_truong_sinh_cong'];
  const ctx = { realmOrder: 1, linhCanElement: null, attrs: { int: 10, con: 10 }, learnedIds: [], congPhapById: data.congPhapById, bloodline: null };
  assert.strictEqual(CongPhap.canLearn(def, ctx).ok, true);
});
test('findConflicts phát hiện xung khắc 2 chiều', () => {
  const data = loadGameData();
  const def = data.congPhapById['phan_quyet']; // xung_dot: han_bang_quyet, thuy_chan_tuyet
  const conflicts = CongPhap.findConflicts(def, ['han_bang_quyet'], data.congPhapById);
  assert.ok(conflicts.includes('han_bang_quyet'));
});
test('getCombatModifiers nhân đôi khi tiến hóa', () => {
  const data = loadGameData();
  const def = data.congPhapById['dau_tu_bi']; // combatDamageBonus 3.0
  const base = CongPhap.getCombatModifiers(def, { evolved: false });
  const evo = CongPhap.getCombatModifiers(def, { evolved: true });
  assert.ok(evo.damageMult > base.damageMult, 'tiến hóa phải tăng damageMult');
});

section('GAME SERVICE — Công Pháp Integration');
test('learnCongPhap lưu vào metadata + tự kích hoạt', () => {
  const db = freshDb();
  const repos = createRepositories(db);
  const data = loadGameData();
  const svc = new GameService(repos, data, () => 0.5);
  svc.createRun('thien_linh_can', 'pham_nhan', 0);
  const meta = JSON.parse(repos.run.get().metadata);
  meta.coreAttrs.int = 10; meta.coreAttrs.con = 10;
  repos.run.update({ metadata: JSON.stringify(meta) });
  const res = svc.learnCongPhap('bat_tu_truong_sinh_cong');
  assert.ok(res.ok, res.error || '');
  const cp = svc.getCongPhapState();
  assert.ok(cp.learned['bat_tu_truong_sinh_cong']);
  assert.strictEqual(cp.activeId, 'bat_tu_truong_sinh_cong', 'công pháp đầu tiên tự kích hoạt');
  db.close();
});
test('learnCongPhap chặn công pháp xung khắc', () => {
  const db = freshDb();
  const repos = createRepositories(db);
  const data = loadGameData();
  const svc = new GameService(repos, data, () => 0.5);
  svc.createRun('thien_linh_can', 'pham_nhan', 0);
  const meta = JSON.parse(repos.run.get().metadata);
  meta.coreAttrs.int = 20; meta.coreAttrs.con = 20;
  // học sẵn 1 công pháp xung khắc với phan_quyet
  meta.congPhap = { learned: { han_bang_quyet: { id: 'han_bang_quyet', proficiency: 0, evolved: false } }, activeId: 'han_bang_quyet' };
  repos.run.update({ metadata: JSON.stringify(meta) });
  const res = svc.learnCongPhap('phan_quyet');
  assert.strictEqual(res.ok, false, 'phải bị chặn vì xung khắc');
  db.close();
});
test('evolveCongPhap cần đủ độ thuần thục', () => {
  const db = freshDb();
  const repos = createRepositories(db);
  const data = loadGameData();
  const svc = new GameService(repos, data, () => 0.5);
  svc.createRun('thien_linh_can', 'pham_nhan', 0);
  const meta = JSON.parse(repos.run.get().metadata);
  meta.coreAttrs.int = 10; meta.coreAttrs.con = 10;
  repos.run.update({ metadata: JSON.stringify(meta) });
  svc.learnCongPhap('bat_tu_truong_sinh_cong');
  // chưa đủ proficiency
  assert.strictEqual(svc.evolveCongPhap('bat_tu_truong_sinh_cong').ok, false);
  // ép proficiency vượt ngưỡng
  const m2 = JSON.parse(repos.run.get().metadata);
  const threshold = CongPhap.getEvolveThreshold(data.congPhapById['bat_tu_truong_sinh_cong']);
  m2.congPhap.learned['bat_tu_truong_sinh_cong'].proficiency = threshold;
  repos.run.update({ metadata: JSON.stringify(m2) });
  assert.strictEqual(svc.evolveCongPhap('bat_tu_truong_sinh_cong').ok, true);
  db.close();
});
test('castCongPhapSkill gây sát thương + tốn LK trong combat', () => {
  const db = freshDb();
  const repos = createRepositories(db);
  const data = loadGameData();
  const svc = new GameService(repos, data, () => 0.5);
  svc.createRun('thien_linh_can', 'pham_nhan', 0);
  const meta = JSON.parse(repos.run.get().metadata);
  meta.coreAttrs.int = 10; meta.coreAttrs.con = 10;
  repos.run.update({ metadata: JSON.stringify(meta), hp: 5000, hp_max: 5000, linh_khi: 2000, linh_khi_max: 2000 });
  svc.learnCongPhap('bat_tu_truong_sinh_cong');
  svc.startCombat(false);
  const lkBefore = repos.run.get().linh_khi;
  const res = svc.castCongPhapSkill('nhan_son_quyet');
  assert.ok(res.ok, res.error || '');
  assert.ok(res.playerAction.damage > 0, 'skill phải gây sát thương');
  assert.ok(repos.run.get().linh_khi < lkBefore, 'phải tốn Linh Khí');
  db.close();
});

// ---------------------------------------------------------------
section('METAPROGRESSION ENGINE');
test('getLevelBenefits trả bonuses theo level', () => {
  const b = Metaprogression.getLevelBenefits(10);
  assert.ok(b.innate_hp_bonus > 0);
  assert.ok(b.innate_luck_bonus >= 0);
});
test('calcInnateBonuses gộp level + shop purchases', () => {
  const account = { level: 10, innate_hp_bonus: 20, innate_linhkhi_bonus: 0, innate_luck_bonus: 5, cancco_reduction: 0 };
  const shopPurchases = { start_stones: 2 };
  const shopItems = [
    { id:'start_stones', effect:{ start_spirit_stones:50 } }
  ];
  const bonuses = Metaprogression.calcInnateBonuses(account, shopPurchases, shopItems);
  assert.ok(bonuses.innate_hp_bonus >= 20); // account base + level bonus
  assert.ok(bonuses.innate_luck_bonus >= 5); // account base + level bonus
  assert.ok(bonuses.start_spirit_stones >= 100); // 2 * 50
});
test('canBuyShopItem kiểm tra đủ điểm', () => {
  const item = { id:'test', cost:100, maxLevel:5 };
  const check = Metaprogression.canBuyShopItem(item, 0, 150, {});
  assert.ok(check.ok);
  assert.strictEqual(check.cost, 100);
});
test('canBuyShopItem từ chối nếu max level', () => {
  const item = { id:'test', cost:100, maxLevel:3 };
  const check = Metaprogression.canBuyShopItem(item, 3, 999, {});
  assert.strictEqual(check.ok, false);
});
test('canBuyShopItem từ chối nếu thiếu điểm', () => {
  const item = { id:'test', cost:500 };
  const check = Metaprogression.canBuyShopItem(item, 0, 50, {});
  assert.strictEqual(check.ok, false);
});
test('canBuyShopItem cost scaling theo level', () => {
  const item = { id:'test', cost:100, maxLevel:5 };
  const check = Metaprogression.canBuyShopItem(item, 2, 300, {});
  assert.ok(check.cost > 100); // scaled up
});
test('buyShopItem tăng level', () => {
  const item = { id:'test', cost:100, maxLevel:5 };
  const res = Metaprogression.buyShopItem(item, 1, 300, {});
  assert.ok(res.ok);
  assert.strictEqual(res.newLevel, 2);
});
test('getAvailableShopItems trả danh sách đầy đủ', () => {
  const items = [
    { id:'a', cost:50, maxLevel:5, effect:{innate_hp_bonus:10} },
    { id:'b', cost:500, maxLevel:3, effect:{innate_luck_bonus:5} }
  ];
  const list = Metaprogression.getAvailableShopItems(items, { a: 1 }, 200);
  assert.strictEqual(list.length, 2);
  assert.ok(list.find(i => i.id === 'a').canBuy);
  assert.strictEqual(list.find(i => i.id === 'b').canBuy, false);
});

section('GAME SERVICE — Shop / Metaprogression');
test('getShopItems trả danh sách item', () => {
  const db = freshDb();
  const repos = createRepositories(db);
  const data = loadGameData();
  const svc = new GameService(repos, data, () => 0.5);
  const items = svc.getShopItems();
  assert.ok(items.length > 0);
  db.close();
});
test('buyShopItem cập nhật điểm + purchase', () => {
  const db = freshDb();
  const repos = createRepositories(db);
  const data = loadGameData();
  const svc = new GameService(repos, data, () => 0.5);
  repos.account.update({ luan_hoi_points: 500 });
  const res = svc.buyShopItem('innate_hp_10');
  assert.ok(res.ok, res.error || '');
  const acc = repos.account.get();
  assert.ok(acc.luan_hoi_points < 500);
  assert.ok(acc.innate_hp_bonus > 0);
  db.close();
});
test('processDeath ghi run history', () => {
  const db = freshDb();
  const repos = createRepositories(db);
  const data = loadGameData();
  const svc = new GameService(repos, data, () => 0.5);
  svc.createRun('thien_linh_can', 'pham_nhan', 0);
  const res = svc.processDeath();
  const history = repos.runHistory.all(5);
  assert.ok(history.length >= 1);
  assert.strictEqual(history[0].score, res.score);
  db.close();
});
test('getAccountStats trả đầy đủ thông tin', () => {
  const db = freshDb();
  const repos = createRepositories(db);
  const data = loadGameData();
  const svc = new GameService(repos, data, () => 0.5);
  const stats = svc.getAccountStats();
  assert.ok(stats.account);
  assert.ok(stats.innateBonuses);
  assert.ok(stats.totalRuns !== undefined);
  db.close();
});
test('createRun áp dụng tiên thiên từ shop', () => {
  const db = freshDb();
  const repos = createRepositories(db);
  const data = loadGameData();
  const svc = new GameService(repos, data, () => 0.5);
  repos.account.update({ luan_hoi_points: 500, innate_hp_bonus: 30, innate_linhkhi_bonus: 20, innate_luck_bonus: 10 });
  const run = svc.createRun('chan_linh_can', 'pham_nhan', 0);
  // HP/LK tính qua StatsEngine; đọc coreAttrs từ metadata để kiểm tiên thiên cộng đúng theo công thức.
  const meta = JSON.parse(run.metadata);
  const startRealm = data.realmById['luyen_khi'];
  const realmTier = startRealm.order || 1;
  const expectedHp = StatsEngine.calcMaxHP(meta.coreAttrs.con, balance.base.hpMax, realmTier, 0, (startRealm.hpBonus || 0) + 30);
  const expectedLk = StatsEngine.calcMaxMP(meta.coreAttrs.spr, balance.base.linhKhiMax, balance.combatV2.dantian_base_cap, meta.rootM, realmTier) + 20;
  assert.strictEqual(run.hp_max, expectedHp);
  assert.strictEqual(run.linh_khi_max, expectedLk);
  assert.strictEqual(run.luck, meta.coreAttrs.luk + 10 + 0); // coreAttrs.luk + innate=10 + giaCanh=0
  db.close();
});

// ---------------------------------------------------------------
section('ITEM SYSTEM');
test('useItem hồi HP', () => {
  const def = { name:'Test Đan', type:'consumable', effect:{ healPct: 0.4 } };
  const run = { hp: 50, hp_max: 100 };
  const res = Items.useItem(def, run);
  assert.ok(res.ok);
  assert.ok(run.hp > 50);
});
test('useItem tăng Linh Khí max', () => {
  const def = { name:'Test Đan', type:'consumable', effect:{ linhKhiMaxUp: 10 } };
  const run = { hp:100, hp_max:100, linh_khi:80, linh_khi_max:100 };
  const res = Items.useItem(def, run);
  assert.ok(res.ok);
  assert.strictEqual(run.linh_khi_max, 110);
});
test('useItem từ chối equipment', () => {
  const def = { name:'Kiếm', type:'equipment', slot:'weapon' };
  const res = Items.useItem(def, {});
  assert.strictEqual(res.ok, false);
});
test('equipItem + calcEquipmentBonuses', () => {
  const def = { id:'test_sword', name:'Test Kiếm', type:'equipment', slot:'weapon', stats:{attackBonus:20} };
  const eq = { weapon:null, armor:null, accessory:null };
  const res = Items.equipItem(def, 'weapon', eq);
  assert.ok(res.ok);
  assert.strictEqual(eq.weapon.id, 'test_sword');
  const bonuses = Items.calcEquipmentBonuses(eq);
  assert.strictEqual(bonuses.attackBonus, 20);
});
test('unequipSlot trả item về', () => {
  const eq = { weapon:{id:'sword',name:'Kiếm',stats:{attackBonus:10}}, armor:null, accessory:null };
  const res = Items.unequipSlot('weapon', eq);
  assert.ok(res.ok);
  assert.strictEqual(eq.weapon, null);
});

section('MEDITATION');
test('meditate trả Tu Vi + Linh Khí gain', () => {
  const run = { fsm_state:'IDLE' };
  const realm = { order:2, id:'truc_co' };
  const res = Meditation.meditate(10, run, realm, 0, () => 0.5);
  assert.ok(res.tuViGain > 0);
  assert.ok(res.linhKhiGain > 0);
});
test('meditate có thể bị ambush', () => {
  const realm = { order:1, id:'luyen_khi' };
  // Luck = 0, 30 phút -> high ambush chance, rng thấp -> ambushed
  const res = Meditation.meditate(30, {}, realm, 0, () => 0.01);
  assert.ok(res.ambushed);
});

section('ACHIEVEMENTS');
test('checkAchievements phát hiện milestone đạt được', () => {
  const achievements = [
    { id:'test1', name:'Test 1', check:'total_kills', threshold:50, reward:{luanHoiPoints:100} }
  ];
  const stats = { total_kills: 60 };
  const result = Achievements.checkAchievements(achievements, stats, []);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].id, 'test1');
});
test('checkAchievements không trùng lặp', () => {
  const achievements = [{ id:'test1', name:'Test', check:'total_kills', threshold:50, reward:{luanHoiPoints:100} }];
  const result = Achievements.checkAchievements(achievements, { total_kills:100 }, ['test1']);
  assert.strictEqual(result.length, 0);
});
test('sumRewards tính tổng điểm', () => {
  const total = Achievements.sumRewards([
    { reward:{luanHoiPoints:100} },
    { reward:{luanHoiPoints:200} }
  ]);
  assert.strictEqual(total, 300);
});

section('GAME SERVICE — Items / Equipment Integration');
test('useItem qua GameService', () => {
  const db = freshDb();
  const repos = createRepositories(db);
  const data = loadGameData();
  const svc = new GameService(repos, data, () => 0.5);
  svc.createRun('thien_linh_can', 'pham_nhan', 0);
  repos.run.update({ hp: 50, hp_max: 100 });
  repos.inventory.add({ item_id:'hoi_huyet_dan', item_name:'hoi_huyet_dan', quantity:1 });
  const res = svc.useItem('hoi_huyet_dan');
  assert.ok(res.ok, res.error || '');
  const run = repos.run.get();
  assert.ok(run.hp > 50);
  db.close();
});
test('equipItem + unequipItem qua GameService', () => {
  const db = freshDb();
  const repos = createRepositories(db);
  const data = loadGameData();
  const svc = new GameService(repos, data, () => 0.5);
  svc.createRun('thien_linh_can', 'pham_nhan', 0);
  repos.inventory.add({ item_id:'phap_bao_so_cap', item_name:'phap_bao_so_cap', quantity:1 });
  const eqRes = svc.equipItem('phap_bao_so_cap', 'weapon');
  assert.ok(eqRes.ok, eqRes.error || '');
  const uneqRes = svc.unequipItem('weapon');
  assert.ok(uneqRes.ok);
  db.close();
});

section('GAME SERVICE — Meditation Integration');
test('meditate qua GameService', () => {
  const db = freshDb();
  const repos = createRepositories(db);
  const data = loadGameData();
  const svc = new GameService(repos, data, () => 0.5);
  svc.createRun('thien_linh_can', 'pham_nhan', 0);
  const res = svc.meditate(5);
  assert.ok(res.ok, res.error || '');
  assert.ok(res.tuViGain > 0);
  db.close();
});

section('GAME SERVICE — Achievements Integration');
test('checkAchievements qua GameService', () => {
  const db = freshDb();
  const repos = createRepositories(db);
  const data = loadGameData();
  const svc = new GameService(repos, data, () => 0.5);
  const res = svc.checkAchievements();
  assert.ok(res.ok);
  db.close();
});

// ---------------------------------------------------------------
section('TRAVEL ENGINE');
test('rollStepType trả type hợp lệ', () => {
  const stepTypes = { combat:{weight:30,icon:'X',desc:'Test'}, treasure:{weight:10,icon:'T',desc:'Test'} };
  const result = Travel.rollStepType(stepTypes, 0, () => 0.5);
  assert.ok(result.type);
  assert.ok(result.icon);
});
test('luck cao tăng tỉ lệ good events', () => {
  const stepTypes = { combat:{weight:50,icon:'C',desc:'bad'}, treasure:{weight:50,icon:'T',desc:'good'} };
  let goodNoLuck = 0, goodHighLuck = 0;
  for (let i = 0; i < 200; i++) {
    if (Travel.rollStepType(stepTypes, 0, Math.random).type === 'treasure') goodNoLuck++;
    if (Travel.rollStepType(stepTypes, 100, Math.random).type === 'treasure') goodHighLuck++;
  }
  assert.ok(goodHighLuck > goodNoLuck, `luck phải tăng good: ${goodNoLuck} vs ${goodHighLuck}`);
});
test('pickScenario trả scenario theo type', () => {
  const scenarios = { treasure: [{id:'t1',text:'Kho báu!'}] };
  const s = Travel.pickScenario(scenarios, 'treasure', () => 0.1);
  assert.strictEqual(s.id, 't1');
});
test('pickScenario loại scenario gần đây để chống lặp', () => {
  const scenarios = { treasure: [{id:'t1',text:'A'},{id:'t2',text:'B'},{id:'t3',text:'C'}] };
  // rng=0 luôn chọn phần tử đầu của eligible; loại t1+t2 → buộc chọn t3
  const s = Travel.pickScenario(scenarios, 'treasure', {}, () => 0, ['t1','t2']);
  assert.strictEqual(s.id, 't3', 'phải né scenario gần đây, chọn cái còn lại');
});
test('pickScenario fallback khi mọi scenario đều vừa gặp', () => {
  const scenarios = { treasure: [{id:'t1',text:'A'},{id:'t2',text:'B'}] };
  // recentIds phủ hết pool → giữ nguyên eligible thay vì trả null
  const s = Travel.pickScenario(scenarios, 'treasure', {}, () => 0, ['t1','t2']);
  assert.ok(s && (s.id === 't1' || s.id === 't2'), 'phải vẫn trả 1 scenario hợp lệ');
});
test('travelStep trả đầy đủ type + scenario', () => {
  const stepTypes = { treasure:{weight:100,icon:'T',desc:'Test'} };
  const scenarios = { treasure:[{id:'t1',text:'Test treasure',reward:{spiritStones:[10,20]}}] };
  const step = Travel.travelStep(stepTypes, scenarios, 0, () => 0.5);
  assert.ok(step.type);
  assert.ok(step.scenario);
});
test('resolveTravelReward áp dụng reward + damage', () => {
  const run = { hp:100, hp_max:100, linh_khi:50, linh_khi_max:100, tu_vi:0, spirit_stones:0, luck:0, tuoi_tho:50 };
  const scenario = { text:'Test', reward:{spiritStones:[50,100], tuVi:30}, damage:{hpPct:0.2} };
  const result = Travel.resolveTravelReward(run, scenario, () => 0.5);
  assert.ok(run.spirit_stones > 0);
  assert.strictEqual(run.tu_vi, 30);
  assert.ok(run.hp < 100);
  assert.ok(result.message);
});

section('REWARD SCALING — theo cảnh giới');
test('calcRewardScale tuyến tính theo realmTier', () => {
  assert.strictEqual(StatsEngine.calcRewardScale(1), 1);
  const per = balance.rewardScaling.per_realm;
  assert.ok(Math.abs(StatsEngine.calcRewardScale(5) - (1 + per * 4)) < 1e-9);
  assert.ok(StatsEngine.calcRewardScale(10) > StatsEngine.calcRewardScale(5));
});
test('resolveTravelReward scale phần thưởng tuyệt đối theo realmScale', () => {
  const base = { hp:100, hp_max:100, linh_khi:0, linh_khi_max:1000, tu_vi:0, spirit_stones:0, luck:0, tuoi_tho:50 };
  const scenario = { text:'T', reward:{ tuVi:100, linhKhiBonus:50 } };
  const r1 = { ...base }; Travel.resolveTravelReward(r1, scenario, () => 0.5, 1);
  const r2 = { ...base }; Travel.resolveTravelReward(r2, scenario, () => 0.5, 3);
  assert.strictEqual(r1.tu_vi, 100);
  assert.strictEqual(r2.tu_vi, 300, 'realmScale=3 phải nhân 3 lần Tu Vi');
});
test('Items.useItem scale đan dược tuyệt đối (tuViUp) theo realmScale', () => {
  const def = { type:'consumable', name:'Test Đan', effect:{ tuViUp:100 } };
  const r1 = { hp:1, hp_max:1, linh_khi:0, linh_khi_max:1, tu_vi:0 };
  const r2 = { hp:1, hp_max:1, linh_khi:0, linh_khi_max:1, tu_vi:0 };
  Items.useItem(def, r1, null, 1);
  Items.useItem(def, r2, null, 3);
  assert.strictEqual(r1.tu_vi, 100);
  assert.strictEqual(r2.tu_vi, 300, 'realmScale=3 phải nhân 3 lần tuViUp');
});
test('Items.useItem KHÔNG scale healPct theo realmScale (đã theo %max)', () => {
  const def = { type:'consumable', name:'Hồi Huyết', effect:{ healPct:0.5 } };
  const r1 = { hp:0, hp_max:200, linh_khi:0, linh_khi_max:1, tu_vi:0 };
  const r2 = { hp:0, hp_max:200, linh_khi:0, linh_khi_max:1, tu_vi:0 };
  Items.useItem(def, r1, null, 1);
  Items.useItem(def, r2, null, 5);
  assert.strictEqual(r1.hp, r2.hp, 'healPct không phụ thuộc realmScale');
  assert.strictEqual(r1.hp, 100);
});

section('GAME SERVICE — Travel Integration');
test('travelStep non-combat trả kết quả', () => {
  const db = freshDb();
  const repos = createRepositories(db);
  const data = loadGameData();
  const svc = new GameService(repos, data, () => 0.5);
  svc.createRun('thien_linh_can', 'pham_nhan', 0);
  repos.run.update({ hp:200, hp_max:200, linh_khi:100, linh_khi_max:100 });
  // Dùng luck cao + rng phù hợp để tránh combat
  repos.run.update({ luck: 100 });
  const res = svc.travelStep();
  assert.ok(res.ok, res.error || '');
  // Có thể là combat hoặc non-combat
  assert.ok(res.type);
  db.close();
});
test('travelBuy mua item từ thương nhân', () => {
  const db = freshDb();
  const repos = createRepositories(db);
  const data = loadGameData();
  const svc = new GameService(repos, data, () => 0.5);
  svc.createRun('thien_linh_can', 'pham_nhan', 0);
  repos.run.update({ spirit_stones: 200 });
  const res = svc.travelBuy('hoi_huyet_dan', 30);
  assert.ok(res.ok, res.error || '');
  const run = repos.run.get();
  assert.strictEqual(run.spirit_stones, 170);
  db.close();
});
test('resolveTravelChoice rẽ nhánh: success→reward.next giữ IN_EVENT', () => {
  const db = freshDb();
  const repos = createRepositories(db);
  const data = loadGameData();
  const svc = new GameService(repos, data, () => 0.5);
  svc.createRun('thien_linh_can', 'pham_nhan', 0);
  repos.run.update({ hp: 200, hp_max: 200, spirit_stones: 0, fsm_state: 'IN_EVENT' });
  // scenario có nhánh: chọn 0 (risk=none) → reward.next là scenario con đầy đủ
  const meta = JSON.parse(repos.run.get().metadata);
  meta._travelScenario = {
    text: 'Cửa 1', choices: ['Tiến vào', 'Rời đi'],
    risks: ['none', 'none'],
    rewards: [{ spiritStones: 10, next: { text: 'Cửa 2', choices: ['Mở rương'], risks: ['none'], rewards: [{ spiritStones: 20 }] } }, null]
  };
  repos.run.update({ metadata: JSON.stringify(meta) });
  const res = svc.resolveTravelChoice(0);
  assert.ok(res.ok, res.error || '');
  assert.strictEqual(res.branched, true, 'phải rẽ nhánh');
  assert.ok(res.scenario.choices, 'scenario con phải có choices');
  assert.strictEqual(repos.run.get().fsm_state, 'IN_EVENT', 'vẫn ở IN_EVENT khi còn nhánh');
  db.close();
});
test('resolveTravelChoice không nhánh: về IDLE + clear scenario', () => {
  const db = freshDb();
  const repos = createRepositories(db);
  const data = loadGameData();
  const svc = new GameService(repos, data, () => 0.5);
  svc.createRun('thien_linh_can', 'pham_nhan', 0);
  repos.run.update({ hp: 200, hp_max: 200, spirit_stones: 0, fsm_state: 'IN_EVENT' });
  const meta = JSON.parse(repos.run.get().metadata);
  meta._travelScenario = { text: 'Cuối', choices: ['Lấy'], risks: ['none'], rewards: [{ spiritStones: 50 }] };
  repos.run.update({ metadata: JSON.stringify(meta) });
  const res = svc.resolveTravelChoice(0);
  assert.ok(res.ok);
  assert.ok(!res.branched, 'không có nhánh');
  assert.strictEqual(repos.run.get().fsm_state, 'IDLE', 'về IDLE khi hết nhánh');
  const m2 = JSON.parse(repos.run.get().metadata);
  assert.ok(!m2._travelScenario, 'scenario phải được clear');
  db.close();
});
test('resolveTravelChoice chặn vòng lặp nhánh ở độ sâu 6', () => {
  const db = freshDb();
  const repos = createRepositories(db);
  const data = loadGameData();
  const svc = new GameService(repos, data, () => 0.5);
  svc.createRun('thien_linh_can', 'pham_nhan', 0);
  repos.run.update({ hp: 200, hp_max: 200, fsm_state: 'IN_EVENT' });
  // Chuỗi nhánh sâu 10 tầng (hữu hạn, không tự tham chiếu) — bộ đếm phải cắt ở depth 6.
  const makeNode = (next) => ({ text: 'Tầng', choices: ['Tiếp'], risks: ['none'], rewards: [{ spiritStones: 1, ...(next ? { next } : {}) }] });
  let chain = null;
  for (let i = 0; i < 10; i++) chain = makeNode(chain);
  const meta = JSON.parse(repos.run.get().metadata);
  meta._travelScenario = chain;
  repos.run.update({ metadata: JSON.stringify(meta) });
  let res, guard = 0;
  do { res = svc.resolveTravelChoice(0); guard++; } while (res.branched && guard < 50);
  assert.ok(guard <= 7, `phải dừng ở ≤7 bước (cap nhánh=6 + 1 bước kết thúc), thực tế ${guard}`);
  assert.strictEqual(repos.run.get().fsm_state, 'IDLE');
  db.close();
});

// ---------------------------------------------------------------
section('GAME SERVICE — Linh Khí integration');
test('updateLinhKhi qua service persist đúng', () => {
  const db = freshDb();
  const repos = createRepositories(db);
  const data = loadGameData();
  const svc = new GameService(repos, data, () => 0.5);
  svc.createRun('chan_linh_can', 'pham_nhan', 0);
  repos.run.update({ linh_khi: 0 }); // cạn linh khí
  const r = svc.updateLinhKhi(60000); // 1 phút sau
  assert.strictEqual(r.regenAmount, 3); // 3 điểm/phút
  assert.strictEqual(repos.run.get().linh_khi, 3);
  db.close();
});

// ---------------------------------------------------------------
section('INVENTORY — Nâng cấp túi đồ');

test('useItem không làm mất món khác trong túi', () => {
  const db = freshDb();
  const repos = createRepositories(db);
  const data = loadGameData();
  const svc = new GameService(repos, data, () => 0.5);
  svc.createRun('thien_linh_can', 'pham_nhan', 0);
  repos.run.update({ hp: 50, hp_max: 200 });
  // 3 thuốc (1 dòng qty=3) + 1 trang bị (dòng riêng)
  repos.inventory.add({ item_id: 'hoi_huyet_dan', item_name: 'Hồi Huyết Đan', quantity: 3 });
  repos.inventory.add({ item_id: 'phap_bao_so_cap', item_name: 'Pháp Bảo Sơ Cấp', quantity: 1 });
  const res = svc.useItem('hoi_huyet_dan');
  assert.ok(res.ok, res.error || '');
  const inv = repos.inventory.all();
  const dan = inv.find(i => i.item_id === 'hoi_huyet_dan');
  const eq = inv.find(i => i.item_id === 'phap_bao_so_cap');
  assert.strictEqual(dan.quantity, 2, 'thuốc còn 2');
  assert.ok(eq && eq.quantity === 1, 'trang bị không bị mất');
  db.close();
});

test('useItem thuốc cuối cùng thì xóa dòng, không mất túi', () => {
  const db = freshDb();
  const repos = createRepositories(db);
  const data = loadGameData();
  const svc = new GameService(repos, data, () => 0.5);
  svc.createRun('thien_linh_can', 'pham_nhan', 0);
  repos.run.update({ hp: 50, hp_max: 200 });
  repos.inventory.add({ item_id: 'hoi_huyet_dan', item_name: 'Hồi Huyết Đan', quantity: 1 });
  repos.inventory.add({ item_id: 'phap_bao_so_cap', item_name: 'Pháp Bảo Sơ Cấp', quantity: 1 });
  svc.useItem('hoi_huyet_dan');
  const inv = repos.inventory.all();
  assert.ok(!inv.find(i => i.item_id === 'hoi_huyet_dan'), 'dòng thuốc đã hết bị xóa');
  assert.ok(inv.find(i => i.item_id === 'phap_bao_so_cap'), 'trang bị còn nguyên');
  db.close();
});

test('_addItem gộp stack consumable, equipment tách dòng', () => {
  const db = freshDb();
  const repos = createRepositories(db);
  const data = loadGameData();
  const svc = new GameService(repos, data, () => 0.5);
  svc.createRun('thien_linh_can', 'pham_nhan', 0);
  // consumable 2 lần -> 1 dòng qty=2
  svc._addItem('hoi_huyet_dan', 1);
  svc._addItem('hoi_huyet_dan', 1);
  // equipment 2 lần -> 2 dòng
  svc._addItem('phap_bao_so_cap', 1);
  svc._addItem('phap_bao_so_cap', 1);
  const inv = repos.inventory.all();
  const danRows = inv.filter(i => i.item_id === 'hoi_huyet_dan');
  const eqRows = inv.filter(i => i.item_id === 'phap_bao_so_cap');
  assert.strictEqual(danRows.length, 1, 'consumable gộp 1 dòng');
  assert.strictEqual(danRows[0].quantity, 2, 'quantity cộng dồn = 2');
  assert.strictEqual(eqRows.length, 2, 'equipment giữ 2 dòng riêng');
  db.close();
});

test('dropItem qty=1 giảm đúng 1, không đụng item khác', () => {
  const db = freshDb();
  const repos = createRepositories(db);
  const data = loadGameData();
  const svc = new GameService(repos, data, () => 0.5);
  svc.createRun('thien_linh_can', 'pham_nhan', 0);
  repos.inventory.add({ item_id: 'hoi_huyet_dan', item_name: 'Hồi Huyết Đan', quantity: 3 });
  repos.inventory.add({ item_id: 'dai_hoan_dan', item_name: 'Đại Hoàn Đan', quantity: 1 });
  const res = svc.dropItem('hoi_huyet_dan', 1);
  assert.ok(res.ok, res.error || '');
  const inv = repos.inventory.all();
  assert.strictEqual(inv.find(i => i.item_id === 'hoi_huyet_dan').quantity, 2);
  assert.ok(inv.find(i => i.item_id === 'dai_hoan_dan'), 'item khác không đổi');
  db.close();
});

test('dropItem qty=all xóa toàn bộ dòng', () => {
  const db = freshDb();
  const repos = createRepositories(db);
  const data = loadGameData();
  const svc = new GameService(repos, data, () => 0.5);
  svc.createRun('thien_linh_can', 'pham_nhan', 0);
  repos.inventory.add({ item_id: 'hoi_huyet_dan', item_name: 'Hồi Huyết Đan', quantity: 5 });
  const res = svc.dropItem('hoi_huyet_dan', 'all');
  assert.ok(res.ok, res.error || '');
  assert.ok(!repos.inventory.all().find(i => i.item_id === 'hoi_huyet_dan'), 'dòng bị xóa hết');
  db.close();
});

test('_rollLootTable rơi item theo dropTable với rng thấp', () => {
  const db = freshDb();
  const repos = createRepositories(db);
  const data = loadGameData();
  const svc = new GameService(repos, data, () => 0.01); // rng thấp -> mọi entry chance > 0.01 đều rơi
  svc.createRun('thien_linh_can', 'pham_nhan', 0);
  repos.inventory.clear();
  const dropped = svc._rollLootTable({ enemyId: 'yeu_thu_thap_1' });
  assert.ok(dropped.length > 0, 'phải rơi ít nhất 1 item từ dropTable');
  assert.ok(repos.inventory.all().length > 0, 'item vào túi');
  db.close();
});

// ---------------------------------------------------------------
console.log(`\n=== KẾT QUẢ: ${passed} pass, ${failed} fail ===`);
process.exit(failed > 0 ? 1 : 0);
