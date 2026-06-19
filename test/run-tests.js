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
section('GAME SERVICE — Linh Khí integration');
test('updateLinhKhi qua service persist đúng', () => {
  const db = freshDb();
  const repos = createRepositories(db);
  const data = loadGameData();
  const svc = new GameService(repos, data, () => 0.5);
  svc.createRun('chan_linh_can', 'pham_nhan', 0);
  repos.run.update({ linh_khi: 0 }); // cạn linh khí
  const r = svc.updateLinhKhi(120000); // 2 phút sau
  assert.strictEqual(r.regenAmount, 2);
  assert.strictEqual(repos.run.get().linh_khi, 2);
  db.close();
});

// ---------------------------------------------------------------
console.log(`\n=== KẾT QUẢ: ${passed} pass, ${failed} fail ===`);
process.exit(failed > 0 ? 1 : 0);
