/**
 * db/repositories.js
 * Tách toàn bộ DB access ra khỏi logic. Mỗi repo nhận db instance.
 * Logic/IPC chỉ gọi repo, không viết SQL trực tiếp.
 */

class AccountRepo {
  constructor(db) { this.db = db; }

  get() {
    return this.db.prepare('SELECT * FROM account WHERE id = 1').get();
  }

  update(fields) {
    const keys = Object.keys(fields);
    if (keys.length === 0) return;
    const setClause = keys.map(k => `${k} = @${k}`).join(', ');
    this.db.prepare(`UPDATE account SET ${setClause} WHERE id = 1`).run(fields);
  }
}

class PityRepo {
  constructor(db) { this.db = db; }

  get() {
    return this.db.prepare('SELECT * FROM pity_counters WHERE id = 1').get();
  }

  increment(column) {
    this.db.prepare(`UPDATE pity_counters SET ${column} = ${column} + 1 WHERE id = 1`).run();
  }

  reset(column) {
    this.db.prepare(`UPDATE pity_counters SET ${column} = 0 WHERE id = 1`).run();
  }
}

class RunRepo {
  constructor(db) { this.db = db; }

  /** Run hiện tại, hoặc undefined nếu chưa có kiếp nào */
  get() {
    return this.db.prepare('SELECT * FROM run WHERE id = 1').get();
  }

  exists() {
    return !!this.get();
  }

  /** Tạo kiếp mới (ghi đè run cũ nếu có) */
  create(runData) {
    this.db.prepare('DELETE FROM run WHERE id = 1').run();
    this.db.prepare('DELETE FROM inventory').run();
    const cols = Object.keys(runData);
    const placeholders = cols.map(c => `@${c}`).join(', ');
    this.db.prepare(
      `INSERT INTO run (id, ${cols.join(', ')}) VALUES (1, ${placeholders})`
    ).run(runData);
    return this.get();
  }

  update(fields) {
    const keys = Object.keys(fields);
    if (keys.length === 0) return;
    const setClause = keys.map(k => `${k} = @${k}`).join(', ');
    this.db.prepare(`UPDATE run SET ${setClause} WHERE id = 1`).run(fields);
  }

  /** Đánh dấu chết (giữ row để tính điểm, alive=0) */
  markDead() {
    this.db.prepare('UPDATE run SET alive = 0, fsm_state = ? WHERE id = 1').run('DEAD');
  }
}

class InventoryRepo {
  constructor(db) { this.db = db; }

  all() {
    return this.db.prepare('SELECT * FROM inventory ORDER BY id').all();
  }

  add(item) {
    this.db.prepare(
      'INSERT INTO inventory (item_id, item_name, quantity, metadata) VALUES (?, ?, ?, ?)'
    ).run(item.item_id, item.item_name, item.quantity ?? 1, item.metadata ?? null);
  }

  clear() {
    this.db.prepare('DELETE FROM inventory').run();
  }
}

function createRepositories(db) {
  return {
    account: new AccountRepo(db),
    pity: new PityRepo(db),
    run: new RunRepo(db),
    inventory: new InventoryRepo(db)
  };
}

module.exports = { createRepositories, AccountRepo, PityRepo, RunRepo, InventoryRepo };
