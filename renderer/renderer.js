/**
 * renderer.js — UI controller mỏng.
 * KHÔNG chứa luật chơi (luật nằm ở main/GameService).
 * Chỉ: gọi API, render text, command registry.
 */

let state = null;   // { account, run, pity, inventory }
let gameData = null; // { linhCan, giaCanh, events, realms }

// ---------- bootstrap ----------
window.addEventListener('DOMContentLoaded', async () => {
  gameData = await window.game.getData();
  await refreshState();
  await tickLinhKhi();
  renderStats();

  if (!state.run || state.run.alive === 0) {
    log('Chưa có kiếp sống. Gõ "start" để khởi đầu vòng luân hồi.', 'warning');
  } else {
    log('Kiếp tu hành tiếp tục. Gõ "help" để xem lệnh.', 'dim');
  }

  // tick Linh Khí mỗi 15s (an toàn — time-delta đã fix mất tiến trình)
  setInterval(async () => { await tickLinhKhi(); renderStats(); }, 15000);

  const input = document.getElementById('input');
  input.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      const raw = input.value.trim();
      input.value = '';
      if (raw) await dispatch(raw);
    }
  });
});

// ---------- data helpers ----------
async function refreshState() { state = await window.game.getState(); }

async function tickLinhKhi() {
  if (!state.run || state.run.alive === 0) return;
  const r = await window.game.updateLinhKhi();
  if (r && r.regenAmount > 0) {
    state.run.linh_khi = r.newValue;
    log(`[REGEN] Linh Khí +${r.regenAmount}`, 'info');
  }
}

// ---------- rendering ----------
function log(text, type = '') {
  const out = document.getElementById('output');
  const line = document.createElement('div');
  line.className = `log-line ${type}`;
  line.textContent = `> ${text}`;
  out.appendChild(line);
  out.scrollTop = out.scrollHeight;
}

function renderStats() {
  const run = state.run;
  const $ = (id) => document.getElementById(id);
  if (!run || run.alive === 0) {
    $('hp-display').textContent = '--/--';
    $('linhkhi-display').textContent = '--/--';
    $('tuvi-display').textContent = '--';
    $('tuoitho-display').textContent = '--/--';
    $('fsm-display').textContent = run ? 'DEAD' : 'NO_RUN';
    return;
  }
  $('hp-display').textContent = `${run.hp}/${run.hp_max}`;
  $('linhkhi-display').textContent = `${run.linh_khi}/${run.linh_khi_max}`;
  $('tuvi-display').textContent = run.tu_vi;
  $('tuoitho-display').textContent = `${Math.floor(run.tuoi_tho)}/${Math.floor(run.tuoi_tho_max)}`;
  $('fsm-display').textContent = run.fsm_state;

  const hpPct = (run.hp / run.hp_max) * 100;
  $('hp-display').className = 'stat-value' + (hpPct <= 25 ? ' red' : hpPct <= 50 ? ' yellow' : '');
}

// ---------- command registry ----------
const commands = {
  help: {
    desc: 'Hiện danh sách lệnh',
    run: () => {
      log('=== LỆNH KHẢ DỤNG ===', 'info');
      Object.entries(commands).forEach(([name, c]) => log(`  ${name.padEnd(14)} - ${c.desc}`));
    }
  },

  start: {
    desc: 'Khởi đầu kiếp mới (roll Linh Căn + Gia Cảnh)',
    run: async () => {
      const lc = await window.game.rollLinhCan();
      log('=== LINH CĂN ===', 'info');
      log(`${tierIcon(lc.def.tier)} ${lc.def.name}${pityTag(lc)}`, tierClass(lc.def.tier));
      log(`   ${lc.def.desc}`, 'dim');

      const gc = await window.game.rollGiaCanh();
      log('=== GIA CẢNH ===', 'info');
      log(`${tierIcon(gc.def.tier)} ${gc.def.name}${pityTag(gc)}`, tierClass(gc.def.tier));
      log(`   ${gc.def.desc}`, 'dim');

      const run = await window.game.createRun({ linhCanId: lc.result, giaCanhId: gc.result });
      await refreshState();
      renderStats();
      const realm = gameData.realms.find(r => r.id === run.realm_id);
      log(`Chuyển sinh hoàn tất. Cảnh giới khởi đầu: ${realm.name}.`, 'success');
      log('Gõ "explore" để bắt đầu hành trình.', 'dim');
    }
  },

  status: {
    desc: 'Xem trạng thái đầy đủ',
    run: async () => {
      await refreshState(); renderStats();
      const { run, account } = state;
      log('=== TÀI KHOẢN (bền vững) ===', 'info');
      log(`  Level: ${account.level}  |  Điểm Luân Hồi: ${account.luan_hoi_points}  |  Số kiếp: ${account.total_lifetimes}`);
      if (!run || run.alive === 0) { log('Chưa có kiếp sống. Gõ "start".', 'warning'); return; }
      const lc = gameData.linhCan.find(x => x.id === run.linh_can_id);
      const gc = gameData.giaCanh.find(x => x.id === run.gia_canh_id);
      const realm = gameData.realms.find(x => x.id === run.realm_id);
      log('=== KIẾP HIỆN TẠI ===', 'info');
      log(`  Cảnh giới: ${realm.name}  |  Linh Căn: ${lc ? lc.name : '?'}  |  Gia Cảnh: ${gc ? gc.name : '?'}`);
      log(`  HP ${run.hp}/${run.hp_max}  Linh Khí ${run.linh_khi}/${run.linh_khi_max}  Tu Vi ${run.tu_vi}`);
      log(`  Tuổi thọ ${Math.floor(run.tuoi_tho)}/${Math.floor(run.tuoi_tho_max)}  Luck ${run.luck}  Linh thạch ${run.spirit_stones}`);
      log(`  State: ${run.fsm_state}  |  Đã giết: ${run.monsters_killed}`);
    }
  },

  explore: {
    desc: 'Thám hiểm — roll sự kiện ngẫu nhiên',
    requiresAlive: true,
    run: async () => {
      const { event } = await window.game.rollEvent();
      log('=== SỰ KIỆN ===', 'info');
      const cls = event.isGood ? 'success' : (event.category === 'combat' || event.category === 'hazard' ? 'error' : 'warning');
      log(event.text, cls);
      log(`[${event.category}] (combat/event chain sẽ implement ở bước sau)`, 'dim');
    }
  },

  inventory: {
    desc: 'Xem túi đồ',
    run: async () => {
      await refreshState();
      const inv = state.inventory;
      if (!inv.length) { log('Túi đồ trống.', 'dim'); return; }
      log('=== TÚI ĐỒ ===', 'info');
      inv.forEach(it => log(`  [${it.id}] ${it.item_name} x${it.quantity}`));
    }
  },

  pity: {
    desc: 'Xem bộ đếm pity',
    run: async () => {
      await refreshState();
      const p = state.pity;
      log('=== PITY ===', 'info');
      log(`  Linh Căn: ${p.linh_can_rolls}/50 (hard pity 50)`);
      log(`  Gia Cảnh: ${p.gia_canh_rolls}/40 (hard pity 40)`);
    }
  },

  die: {
    desc: '[TEST] Kết thúc kiếp này, tính điểm luân hồi',
    requiresAlive: true,
    run: async () => {
      const res = await window.game.processDeath();
      await refreshState(); renderStats();
      log('💀 Thân tử đạo tiêu.', 'error');
      log(`Điểm kiếp này: ${res.score}  |  Tổng số kiếp: ${res.lifetimes}`, 'warning');
      if (res.leveledUp) log(`⬆️ Tài khoản lên Level ${res.newLevel}!`, 'success');
      log('Gõ "start" để bắt đầu kiếp mới.', 'dim');
    }
  },

  clear: { desc: 'Xóa màn hình', run: () => { document.getElementById('output').innerHTML = ''; } }
};

// ---------- dispatcher ----------
async function dispatch(raw) {
  log(raw, 'dim');
  const name = raw.toLowerCase().split(/\s+/)[0];
  const cmd = commands[name];
  if (!cmd) { log(`Lệnh không tồn tại: '${name}'. Gõ "help".`, 'error'); return; }

  if (cmd.requiresAlive) {
    await refreshState();
    if (!state.run || state.run.alive === 0) {
      log('[LỖI] Cần có kiếp sống. Gõ "start" trước.', 'error');
      return;
    }
  }
  try { await cmd.run(); }
  catch (e) { log(`[LỖI] ${e.message}`, 'error'); }
}

// ---------- cosmetic helpers ----------
function tierIcon(tier) {
  return { legendary: '🌟', mythic: '⚡', rare: '✦', common: '·' }[tier] || '·';
}
function tierClass(tier) {
  return { legendary: 'success', mythic: 'success', rare: 'info', common: 'warning' }[tier] || '';
}
function pityTag(roll) {
  return roll.resetPity ? ' [PITY RESET]' : ` (pity ${roll.pityCount + 1})`;
}
