/**
 * db/migrations.js
 * Schema versioning qua PRAGMA user_version.
 * Mỗi migration là 1 bước tăng version. Chạy tuần tự, idempotent.
 *
 * Mô hình roguelite:
 *  - account   : BỀN VỮNG qua các kiếp (level, điểm luân hồi, tiên thiên, pity)
 *  - run       : KIẾP HIỆN TẠI, xóa khi chết/rebirth (HP, tu vi, linh căn, FSM)
 *  - inventory : thuộc run hiện tại (đồ mất khi chết)
 */

const MIGRATIONS = [
  // v1: khởi tạo schema nền
  (db) => {
    db.exec(`
      CREATE TABLE account (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        level INTEGER NOT NULL DEFAULT 1,
        total_exp INTEGER NOT NULL DEFAULT 0,
        luan_hoi_points INTEGER NOT NULL DEFAULT 0,
        total_lifetimes INTEGER NOT NULL DEFAULT 0,
        -- chỉ số tiên thiên (cộng vào kiếp mới)
        innate_hp_bonus INTEGER NOT NULL DEFAULT 0,
        innate_linhkhi_bonus INTEGER NOT NULL DEFAULT 0,
        innate_luck_bonus INTEGER NOT NULL DEFAULT 0,
        cancco_reduction REAL NOT NULL DEFAULT 0
      );

      -- pity thuộc account (bền vững qua các kiếp — đúng GDD)
      CREATE TABLE pity_counters (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        linh_can_rolls INTEGER NOT NULL DEFAULT 0,
        gia_canh_rolls INTEGER NOT NULL DEFAULT 0
      );

      -- run hiện tại; id=1 nếu đang sống, không có row nếu chưa tạo kiếp
      CREATE TABLE run (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        alive INTEGER NOT NULL DEFAULT 1,
        realm_id TEXT NOT NULL DEFAULT 'luyen_khi',
        linh_can_id TEXT,
        gia_canh_id TEXT,
        hp INTEGER NOT NULL,
        hp_max INTEGER NOT NULL,
        linh_khi INTEGER NOT NULL,
        linh_khi_max INTEGER NOT NULL,
        tu_vi INTEGER NOT NULL DEFAULT 0,
        tuoi_tho REAL NOT NULL,
        tuoi_tho_max REAL NOT NULL,
        luck INTEGER NOT NULL DEFAULT 0,
        spirit_stones INTEGER NOT NULL DEFAULT 0,
        fsm_state TEXT NOT NULL DEFAULT 'IDLE',
        linh_khi_last_update INTEGER NOT NULL,
        started_at INTEGER NOT NULL,
        monsters_killed INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE inventory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id TEXT NOT NULL,
        item_name TEXT NOT NULL,
        quantity INTEGER NOT NULL DEFAULT 1,
        metadata TEXT
      );

      INSERT OR IGNORE INTO account (id) VALUES (1);
      INSERT OR IGNORE INTO pity_counters (id) VALUES (1);
    `);
  },
  // v2: thêm cột metadata cho combat state / dữ liệu mở rộng khác
  (db) => {
    db.exec(`ALTER TABLE run ADD COLUMN metadata TEXT`);
  },
  // v3: thêm cột map_state cho map/event system
  (db) => {
    db.exec(`ALTER TABLE run ADD COLUMN map_state TEXT`);
  },
  // v4: run_history table + account metadata
  (db) => {
    db.exec(`
      CREATE TABLE run_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ended_at INTEGER NOT NULL,
        realm_id TEXT NOT NULL,
        realm_name TEXT NOT NULL,
        score INTEGER NOT NULL,
        monsters_killed INTEGER NOT NULL,
        spirit_stones_earned INTEGER NOT NULL,
        years_lived REAL NOT NULL,
        cause_of_death TEXT DEFAULT 'unknown'
      );
      ALTER TABLE account ADD COLUMN metadata TEXT;
    `);
  },
  // v5: run_exp — EXP tích lũy trong kiếp
  (db) => {
    db.exec(`ALTER TABLE run ADD COLUMN run_exp INTEGER NOT NULL DEFAULT 0`);
  }
  // v3... thêm vào đây khi schema đổi. KHÔNG sửa migration cũ.
];

/**
 * Chạy tất cả migration chưa áp dụng.
 * @param {Database} db - better-sqlite3 instance
 * @returns {{ from:number, to:number }}
 */
function runMigrations(db) {
  const from = db.pragma('user_version', { simple: true });
  let version = from;

  const applyAll = db.transaction(() => {
    for (let i = version; i < MIGRATIONS.length; i++) {
      MIGRATIONS[i](db);
      version = i + 1;
      db.pragma(`user_version = ${version}`);
    }
  });
  applyAll();

  return { from, to: version };
}

module.exports = { runMigrations, MIGRATION_COUNT: MIGRATIONS.length };
