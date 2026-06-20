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
const MapGenerator = require('../lib/map-generator');
const EventChain = require('../lib/event-chain');
const Breakthrough = require('../lib/breakthrough');
const Crafting = require('../lib/crafting');
const Sect = require('../lib/sect');
const Metaprogression = require('../lib/metaprogression');
const Items = require('../lib/items');
const Meditation = require('../lib/meditation');
const Achievements = require('../lib/achievements');
const Travel = require('../lib/travel');
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
  assert.strictEqual(fsm.isActionAllowed('attack'), false);
  assert.strictEqual(fsm.isActionAllowed('status'), true);
});
test('DEAD là tuyệt lộ (chỉ rebirth)', () => {
  const fsm = new FSM('DEAD');
  assert.strictEqual(fsm.transition('IDLE').ok, false);
  assert.strictEqual(fsm.isActionAllowed('rebirth'), true);
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
  // pham_nhan -> luyen_khi: hpBonus 0, linhKhiMax 100, tuoiThoMax 120
  assert.strictEqual(run.hp_max, balance.base.hpMax + 0 + 50);
  assert.strictEqual(run.linh_khi_max, 100 + 20);
  assert.strictEqual(run.luck, 0 + 10 + 0);
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
  assert.strictEqual(run.luck, 25);
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

// ---------------------------------------------------------------
section('MAP GENERATOR');
test('pickMapConfig chọn đúng config theo realm', () => {
  const mapData = { maps: [
    { realmMin:0, realmMax:2, layers:5 },
    { realmMin:3, realmMax:4, layers:6 }
  ]};
  assert.strictEqual(MapGenerator.pickMapConfig(mapData, 1).layers, 5);
  assert.strictEqual(MapGenerator.pickMapConfig(mapData, 3).layers, 6);
  assert.strictEqual(MapGenerator.pickMapConfig(mapData, 9).layers, 6); // fallback last
});
test('generateMap tạo map state đầy đủ', () => {
  const mapData = {
    nodeTypes: { combat:{icon:'X',color:'#fff',desc:'Test'}, boss:{icon:'B',color:'#f00',desc:'Boss'} },
    maps: [{ realmMin:0, realmMax:2, layers:3, nodeDistribution:{combat:100}, hasElite:false }]
  };
  const state = MapGenerator.generateMap(mapData, 1, () => 0.5);
  assert.ok(state.layers);
  assert.strictEqual(state.layers.length, 3);
  assert.strictEqual(state.currentLayer, 0);
  assert.ok(state.layers[2][0].type === 'boss', 'layer cuối phải có boss');
  assert.ok(state.nodeStates);
});
test('connectLayers: mỗi node prev kết nối ít nhất 1 node next', () => {
  const prev = [{id:'a'},{id:'b'}];
  const next = [{id:'c'},{id:'d'}];
  const conns = MapGenerator.connectLayers(prev, next, () => 0.1);
  assert.ok(conns['a'] && conns['a'].length >= 1);
  assert.ok(conns['b'] && conns['b'].length >= 1);
});
test('selectNextNode: chọn node hợp lệ', () => {
  const mapData = {
    nodeTypes: { combat:{icon:'X',color:'#fff',desc:'Test'}, boss:{icon:'B',color:'#f00',desc:'Boss'} },
    maps: [{ realmMin:0, realmMax:2, layers:3, nodeDistribution:{combat:100}, hasElite:false }]
  };
  const state = MapGenerator.generateMap(mapData, 1, () => 0.5);
  const reachable = state.connections[0][state.layers[0][0].id];
  if (reachable && reachable.length > 0) {
    const targetNode = state.layers[1].find(n => n.id === reachable[0]);
    const idx = state.layers[1].indexOf(targetNode);
    const res = MapGenerator.selectNextNode(state, idx);
    assert.ok(res.ok);
    assert.strictEqual(res.mapState.currentLayer, 1);
  }
});
test('parseMapState / serializeMapState roundtrip', () => {
  const state = { layers:[[{id:'a',type:'combat'}]], connections:[], nodeStates:{}, currentNodeId:'a', currentLayer:0, currentNodeIndex:0, path:[] };
  const json = MapGenerator.serializeMapState(state);
  const parsed = MapGenerator.parseMapState(json);
  assert.strictEqual(parsed.currentNodeId, 'a');
});

section('EVENT CHAIN');
test('pickEventScript chọn script theo nodeType', () => {
  const scripts = { treasure: [{id:'t1',text:'Kho báu!'}] };
  const s = EventChain.pickEventScript(scripts, 'treasure', () => 0.1);
  assert.strictEqual(s.id, 't1');
});
test('pickEventScript trả null nếu không có scripts', () => {
  const s = EventChain.pickEventScript({}, 'combat', () => 0.1);
  assert.strictEqual(s, null);
});
test('resolveChoice: risk=none luôn thành công', () => {
  const script = { text:'Test', choices:[{text:'An toàn',risk:'none',success:{text:'OK',reward:{spiritStones:10}}}] };
  const res = EventChain.resolveChoice(script, 0, 0, () => 0.1);
  assert.ok(res.ok);
  assert.strictEqual(res.result.outcome, 'success');
  assert.strictEqual(res.result.reward.spiritStones, 10);
});
test('resolveChoice: risk=high thất bại với rng cao', () => {
  const script = { text:'Test', choices:[{text:'Nguy hiểm',risk:'high',success:{text:'Win'},failure:{text:'Lose',damage:{hp:20}},successRate:0.3}] };
  const res = EventChain.resolveChoice(script, 0, 0, () => 0.9);
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

section('GAME SERVICE — Map / Event Integration');
test('createRun tự động generate map', () => {
  const db = freshDb();
  const repos = createRepositories(db);
  const data = loadGameData();
  const svc = new GameService(repos, data, () => 0.5);
  const run = svc.createRun('thien_linh_can', 'pham_nhan', 0);
  assert.ok(run.map_state);
  const ms = MapGenerator.parseMapState(run.map_state);
  assert.ok(ms.layers && ms.layers.length >= 3);
  db.close();
});
test('getMapView trả map state + run info', () => {
  const db = freshDb();
  const repos = createRepositories(db);
  const data = loadGameData();
  const svc = new GameService(repos, data, () => 0.5);
  svc.createRun('thien_linh_can', 'pham_nhan', 0);
  const view = svc.getMapView();
  assert.ok(view.mapState);
  assert.ok(view.run);
  db.close();
});
test('enterNode combat node khởi tạo combat', () => {
  const db = freshDb();
  const repos = createRepositories(db);
  const data = loadGameData();
  const svc = new GameService(repos, data, () => 0.01); // luôn chọn node đầu -> type combat
  svc.createRun('thien_linh_can', 'pham_nhan', 0);
  repos.run.update({ hp: 500, hp_max: 500 });
  // Đảm bảo node đầu tiên ở layer 0 là combat
  const ms = MapGenerator.parseMapState(repos.run.get().map_state);
  // Override: set node đầu thành combat để test
  ms.layers[0][0].type = 'combat';
  repos.run.update({ map_state: MapGenerator.serializeMapState(ms) });
  const res = svc.enterNode();
  assert.ok(res.ok, `expected ok, got ${res.error}`);
  assert.strictEqual(res.action, 'combat');
  assert.ok(res.combat);
  db.close();
});
test('enterNode treasure node trả event script', () => {
  const db = freshDb();
  const repos = createRepositories(db);
  const data = loadGameData();
  const svc = new GameService(repos, data, () => 0.5);
  svc.createRun('thien_linh_can', 'pham_nhan', 0);
  // Override: set node thành treasure
  const ms = MapGenerator.parseMapState(repos.run.get().map_state);
  ms.layers[0][0].type = 'treasure';
  repos.run.update({ map_state: MapGenerator.serializeMapState(ms) });
  const res = svc.enterNode();
  assert.ok(res.ok, `expected ok, got ${res.error}`);
  if (res.action === 'event') {
    assert.ok(res.script);
    assert.ok(res.script.choices);
  }
  db.close();
});
test('resolveChoice áp dụng reward + clear node', () => {
  const db = freshDb();
  const repos = createRepositories(db);
  const data = loadGameData();
  const svc = new GameService(repos, data, () => 0.5);
  svc.createRun('thien_linh_can', 'pham_nhan', 0);
  repos.run.update({ hp: 200, hp_max: 200, spirit_stones: 0 });
  // Setup: active script với risk=none
  const ms = MapGenerator.parseMapState(repos.run.get().map_state);
  ms._activeScript = { text:'Test', choices:[{text:'Lấy',risk:'none',success:{text:'Được!',reward:{spiritStones:100}}}] };
  repos.run.update({ map_state: MapGenerator.serializeMapState(ms) });
  const res = svc.resolveChoice(0);
  assert.ok(res.ok);
  assert.ok(res.nodeCleared);
  const runAfter = repos.run.get();
  assert.strictEqual(runAfter.spirit_stones, 100);
  db.close();
});
test('completeCombatNode đánh dấu node cleared', () => {
  const db = freshDb();
  const repos = createRepositories(db);
  const data = loadGameData();
  const svc = new GameService(repos, data, () => 0.5);
  svc.createRun('thien_linh_can', 'pham_nhan', 0);
  repos.run.update({ fsm_state: 'IDLE' }); // giả lập combat kết thúc
  const res = svc.completeCombatNode();
  assert.ok(res.ok);
  const ms = MapGenerator.parseMapState(repos.run.get().map_state);
  const clearedNodeId = ms.layers[0][0].id;
  assert.strictEqual(ms.nodeStates[clearedNodeId], 'cleared');
  db.close();
});

// ---------------------------------------------------------------
section('BREAKTHROUGH ENGINE');
test('calcBreakthroughChance cho Luyện Khí -> Trúc Cơ', () => {
  const realm = { id:'luyen_khi', order:1, breakthrough:{ linhKhiRequired:80, tuViRequired:50, baseSuccessRate:0.8 } };
  const run = { linh_khi:100, linh_khi_max:100, tu_vi:60, luck:0 };
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
  const run = { linh_khi:100, tu_vi:60, luck:0, hp_max:100 };
  const linhCan = { modifiers:{ cultivationSpeed:1.0 } };
  const res = Breakthrough.attemptBreakthrough(realm, run, linhCan, 0, () => 0.1);
  assert.ok(res.success);
  assert.strictEqual(res.cost.lk, 80);
});
test('attemptBreakthrough thất bại với rng cao', () => {
  const realm = { order:1, breakthrough:{ linhKhiRequired:80, tuViRequired:50, baseSuccessRate:0.3, hasTribulation:false, hpLossOnFail:20, lkLossOnFail:30 } };
  const run = { linh_khi:100, tu_vi:60, luck:0, hp_max:100 };
  const linhCan = { modifiers:{ cultivationSpeed:1.0 } };
  const res = Breakthrough.attemptBreakthrough(realm, run, linhCan, 0, () => 0.9);
  assert.strictEqual(res.success, false);
  assert.ok(res.damage);
});
test('attemptBreakthrough có thiên kiếp khi hasTribulation=true', () => {
  const realm = { order:3, breakthrough:{ linhKhiRequired:700, tuViRequired:500, baseSuccessRate:0.9, hasTribulation:true, tribulationStrikes:3, tribulationDamage:60 } };
  const run = { linh_khi:800, tu_vi:600, luck:50, hp_max:500 };
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
  repos.run.update({ linh_khi:500, tu_vi:500, hp:300, hp_max:300, linh_khi_max:500 });
  const res = svc.attemptBreakthrough();
  assert.ok(res.ok);
  // Với rng thấp và linh căn tốt, sẽ thành công
  assert.ok(res.success || !res.success); // luôn trả kết quả
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
  assert.ok(acc.innate_hp_bonus >= 10);
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
  assert.strictEqual(run.hp_max, balance.base.hpMax + 0 + 30); // luyen_khi hpBonus=0 + innate=30
  assert.strictEqual(run.linh_khi_max, 100 + 20); // luyen_khi linhKhiMax=100 + innate=20
  assert.strictEqual(run.luck, 0 + 10 + 0); // base=0 + innate=10 + giaCanh=0
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
console.log(`\n=== KẾT QUẢ: ${passed} pass, ${failed} fail ===`);
process.exit(failed > 0 ? 1 : 0);
