/**
 * renderer.js — UI Controller for Tu Tiên Giới
 * Light Xianxia Aesthetic with Typewriter Engine.
 * ALL game logic stays in GameService (main process).
 */

// ── State ──
let state = null;
let gameData = null;

// ── Audio System ──
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
function playSound(type) {
  if (audioCtx.state === 'suspended') audioCtx.resume();
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  let freq, wave, vol, duration;
  if (type === 'type')     { freq = 600 + Math.random()*200; wave = 'square';   vol = 0.008; duration = 0.025; }
  else if (type === 'enter'){ freq = 400; wave = 'sine';     vol = 0.04; duration = 0.1; }
  else if (type === 'error'){ freq = 150; wave = 'sawtooth'; vol = 0.06; duration = 0.25; }
  else if (type === 'success'){ freq = 800; wave = 'sine';   vol = 0.04; duration = 0.18; }
  else return;
  osc.type = wave;
  osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
  gain.gain.setValueAtTime(vol, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
  osc.connect(gain); gain.connect(audioCtx.destination);
  osc.start(); osc.stop(audioCtx.currentTime + duration);
}

// ── Typewriter Engine ──
let typewriterQueue = [];
let typewriterRunning = false;

async function typewrite(text, type = '', speed = 25) {
  return new Promise(resolve => {
    typewriterQueue.push({ text, type, speed, resolve });
    if (!typewriterRunning) processTypewriterQueue();
  });
}

async function processTypewriterQueue() {
  if (typewriterQueue.length === 0) { typewriterRunning = false; return; }
  typewriterRunning = true;
  const { text, type, speed, resolve } = typewriterQueue.shift();
  const entry = addLogEntry('', type);
  entry.classList.add('typewriter');
  for (let i = 0; i < text.length; i++) {
    entry.textContent = text.slice(0, i + 1);
    if (text[i] !== ' ') playSound('type');
    scrollLogToBottom();
    await new Promise(r => setTimeout(r, speed));
  }
  entry.classList.remove('typewriter');
  entry.style.borderRight = 'none';
  resolve();
  processTypewriterQueue();
}

// ── Data Helpers ──
async function refreshState() { state = await window.game.getState(); }

async function tickLinhKhi() {
  if (!state.run || state.run.alive === 0) return;
  const r = await window.game.updateLinhKhi();
  if (r && r.regenAmount > 0) {
    state.run.linh_khi = r.newValue;
    addLogEntry(`[REGEN] Linh Khí +${r.regenAmount}`, 'system');
  }
}

// ── Log System ──
function log(text, type = '') {
  if (type === 'error') playSound('error');
  if (type === 'success') playSound('success');
  addLogEntry(text, type);
}

function addLogEntry(text, type = '') {
  const inner = document.getElementById('log-inner');
  const entry = document.createElement('div');
  entry.className = `log-entry ${type}`;
  entry.textContent = text || '';
  inner.appendChild(entry);
  while (inner.children.length > 300) inner.firstChild.remove();
  scrollLogToBottom();
  return entry;
}

function scrollLogToBottom() {
  const main = document.getElementById('main-log');
  if (main) main.scrollTop = main.scrollHeight;
}

// ── Status Bar ──
function renderStats() {
  const run = state.run;
  const set = (id, val) => { const e = document.getElementById(id); if (e) e.textContent = val; };
  const $ = (id) => document.getElementById(id);

  // Header badges
  if (state.account) {
    set('hdr-level', `LV.${state.account.level}`);
    set('hdr-dlh', `💎 ${state.account.luan_hoi_points} ĐLH`);
  }

  // State badge with human-readable labels
  const STATE_LABELS = {
    'IDLE': 'Tự Do',
    'IN_EVENT': 'Đối Thoại',
    'COMBAT': 'Chiến Đấu',
    'MEDITATING': 'Nhập Định',
    'TRIBULATION': 'Thiên Kiếp',
    'CRAFTING': 'Chế Tạo',
    'DEAD': 'Tử Vong',
    'NO_RUN': 'Chưa Sinh'
  };

  const badge = $('#state-badge');
  if (badge) {
    if (!run || run.alive === 0) {
      badge.textContent = run ? 'Tử Vong' : 'Chưa Sinh';
      badge.dataset.state = run ? 'DEAD' : 'NO_RUN';
    } else {
      const label = STATE_LABELS[run.fsm_state] || run.fsm_state;
      badge.textContent = label;
      badge.dataset.state = run.fsm_state;
    }
  }

  if (!run || run.alive === 0) {
    renderAsciiBar('hp-fill', 'hp-empty', 0); set('hp-pct', '--'); set('hp-val', '--/--');
    renderAsciiBar('lk-fill', 'lk-empty', 0); set('lk-pct', '--'); set('lk-val', '--/--');
    set('tuvi-val', '--'); set('exp-val', '--'); set('stones-val', '--'); set('tho-val', '--'); set('luck-val', '--'); set('realm-val', '--');
    return;
  }

  const hpPct = Math.max(0, run.hp / run.hp_max);
  renderAsciiBar('hp-fill', 'hp-empty', hpPct);
  set('hp-pct', `${Math.round(hpPct*100)}%`);
  set('hp-val', `${run.hp}/${run.hp_max}`);

  const lkPct = Math.max(0, run.linh_khi / run.linh_khi_max);
  renderAsciiBar('lk-fill', 'lk-empty', lkPct);
  set('lk-pct', `${Math.round(lkPct*100)}%`);
  set('lk-val', `${run.linh_khi}/${run.linh_khi_max}`);

  set('tuvi-val', run.tu_vi);
  set('exp-val', run.run_exp != null ? `${run.run_exp} EXP` : '0 EXP');
  set('stones-val', run.spirit_stones);
  set('tho-val', `${Math.floor(run.tuoi_tho)}/${Math.floor(run.tuoi_tho_max)} YRS`);
  set('luck-val', run.luck);

  // Realm name
  if (gameData?.realms) {
    const realm = gameData.realms.find(r => r.id === run.realm_id);
    set('realm-val', realm?.name || run.realm_id);
  }
}

function renderAsciiBar(fillId, emptyId, pct) {
  const fill = document.getElementById(fillId);
  if (!fill) return;
  fill.style.width = `${Math.max(0, Math.min(100, pct * 100))}%`;
  fill.textContent = '';
  const empty = document.getElementById(emptyId);
  if (empty) empty.textContent = '';
}

// ── Quick Actions ──
let currentChoices = [];

function updateQuickActions(buttons) {
  currentChoices = buttons;
  const container = document.getElementById('quick-actions');
  if (!container) return;
  container.innerHTML = '';
  buttons.forEach(b => {
    const btn = document.createElement('button');
    btn.className = `action-btn${b.primary ? ' primary' : ''}`;
    btn.textContent = b.label;
    btn.addEventListener('click', async () => {
      if (isBusy) return;
      playSound('enter'); isBusy = true;
      try { await executeChoice(b); } finally { isBusy = false; }
    });
    container.appendChild(btn);
  });
}

// ── Modal System ──
function showModal(title, bodyHtml) {
  let overlay = document.getElementById('modal-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'modal-overlay';
    overlay.innerHTML = `<div class="modal-panel">
      <div class="modal-header-bar"><span class="modal-title-text" id="modal-title-text"></span><button class="modal-close-x" id="modal-close-x">✕</button></div>
      <div class="modal-body-scroll" id="modal-body-scroll"></div></div>`;
    document.body.appendChild(overlay);
    document.getElementById('modal-close-x').addEventListener('click', hideModal);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) hideModal(); });
  }
  document.getElementById('modal-title-text').textContent = title;
  document.getElementById('modal-body-scroll').innerHTML = bodyHtml;
  overlay.style.display = 'flex';
}
function hideModal() {
  const overlay = document.getElementById('modal-overlay');
  if (overlay) overlay.style.display = 'none';
}
// Escape key closes modal
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    hideModal();
  }
});

// ── Combat Overlay ──
function showCombatOverlay(combat) {
  const ov = document.getElementById('combat-overlay');
  if (!ov) return;
  document.getElementById('enemy-name').textContent = combat.enemyName;
  document.getElementById('enemy-hp-text').textContent = `${combat.enemyHp}/${combat.enemyMaxHp}`;
  document.getElementById('enemy-stats').textContent =
    `ATK:${combat.enemyAttack} | DEF:${combat.enemyDefense}${combat.enemyElement ? ` | ${combat.enemyElement.toUpperCase()}` : ''}`;
  renderAsciiBar('enemy-hp-fill', 'enemy-hp-empty', Math.max(0, combat.enemyHp / combat.enemyMaxHp));
  document.getElementById('combat-log').innerHTML = '';
  ov.style.display = 'flex';

  // Wire combat action buttons
  document.getElementById('combat-actions').querySelectorAll('button').forEach(btn => {
    const action = btn.dataset.action;
    btn.onclick = async () => {
      if (isBusy) return;
      playSound('enter'); isBusy = true;
      try { await executeChoice({ action }); } finally { isBusy = false; }
    };
  });
}
function updateCombatOverlay(combat) {
  if (!combat) return;
  renderAsciiBar('enemy-hp-fill', 'enemy-hp-empty', Math.max(0, combat.enemyHp / combat.enemyMaxHp));
  document.getElementById('enemy-hp-text').textContent = `${combat.enemyHp}/${combat.enemyMaxHp}`;
}
function addCombatLog(text) {
  const el = document.getElementById('combat-log');
  if (!el) return;
  const d = document.createElement('div');
  d.textContent = text;
  el.appendChild(d);
  el.scrollTop = el.scrollHeight;
}
function hideCombatOverlay() {
  const ov = document.getElementById('combat-overlay');
  if (ov) ov.style.display = 'none';
}

// ── Old wrappers (backward compat) ──
function renderCombatHUD(c) { showCombatOverlay(c); }
function updateCombatHUD(c) { updateCombatOverlay(c); }
function removeCombatHUD() { hideCombatOverlay(); }

// ── Choice System ──
function showIdleChoices() {
  const run = state.run;
  if (!run || run.alive === 0) {
    updateQuickActions([{ label: '🔱 Bắt đầu kiếp mới', action: 'command', cmd: 'start', primary: true }]);
    return;
  }

  switch (run.fsm_state) {
    case 'IDLE':
      updateQuickActions([
        { label: '🚶 Đi tiếp', action: 'travel', primary: true },
        { label: '🗺️ Bản đồ', action: 'command', cmd: 'map' },
        { label: '🧘 Thiền', action: 'command', cmd: 'meditate 10' },
        { label: '⬆️ Đột phá', action: 'command', cmd: 'breakthrough' },
        { label: '🎒 Túi đồ', action: 'command', cmd: 'inventory' },
      ]);
      break;

    case 'IN_EVENT':
      // Đang trong sự kiện — chỉ cho chọn, không cho di chuyển
      updateQuickActions([]);  // Choices are rendered in log area
      break;

    case 'COMBAT':
      // Combat actions handled by combat overlay buttons
      updateQuickActions([]);
      break;

    case 'MEDITATING':
      updateQuickActions([
        { label: '🔓 Thức tỉnh / Dừng thiền', action: 'command', cmd: 'meditate 0', primary: true },
      ]);
      break;

    case 'TRIBULATION':
      updateQuickActions([
        { label: '⚡ Chịu lôi kiếp', action: 'command', cmd: 'endure', primary: true },
      ]);
      break;

    case 'DEAD':
      updateQuickActions([
        { label: '🔱 Luân hồi chuyển thế', action: 'command', cmd: 'start', primary: true },
      ]);
      break;

    default:
      updateQuickActions([{ label: '📊 Xem trạng thái', action: 'command', cmd: 'status' }]);
  }
}

function renderCombatChoices() {
  // Combat uses overlay buttons (wired in showCombatOverlay)
}

function showChoices(choices) {
  currentChoices = choices;
  const inner = document.getElementById('log-inner');
  if (!inner) return;
  const card = document.createElement('div');
  card.className = 'log-entry system';
  let html = '<div class="choice-list">';
  choices.forEach((c, i) => {
    const cls = c.primary ? 'primary' : c.danger ? 'danger' : '';
    html += `<button class="choice-btn ${cls}" data-idx="${i}">[${i+1}] ${c.label}</button>`;
  });
  html += '</div>';
  card.innerHTML = html;
  inner.appendChild(card);
  scrollLogToBottom();
  card.querySelectorAll('.choice-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const idx = parseInt(btn.dataset.idx);
      if (isBusy || idx >= currentChoices.length) return;
      playSound('enter'); isBusy = true;
      try { await executeChoice(currentChoices[idx]); } finally { isBusy = false; }
    });
  });
}

// ── Choice Executor ──
async function executeChoice(choice) {
  if (!choice) return;
  if (choice.action === 'command')       { await dispatch(choice.cmd); }
  else if (choice.action === 'travel')   { await doTravelStep(); }
  else if (choice.action === 'attack')   { await combatAction(() => window.game.playerAttack()); }
  else if (choice.action === 'cast')     { await combatAction(() => window.game.playerCast()); }
  else if (choice.action === 'flee')     { await combatActionFlee(); }
  else if (choice.action === 'forbidden_art') { await combatAction(() => window.game.playerForbiddenArt()); }
  else if (choice.action === 'endure')   {
    await commands.endure.run([]);
    await refreshState();
    if (state.run?.fsm_state === 'TRIBULATION') {
      showChoices([{ label: '⚡ Chịu đạo lôi kiếp tiếp theo', action: 'endure', primary: true }]);
    } else { showIdleChoices(); }
  }
  else if (choice.action === 'choose_event') {
    const res = await window.game.resolveTravelChoice(choice.choiceIndex);
    if (!res.ok) { log(`[LỖI] ${res.error}`, 'error'); return; }
    log(res.message, res.outcome === 'success' ? 'success' : 'error');
    await refreshState(); renderStats(); showIdleChoices();
  }
  else if (choice.action === 'buy_item') {
    const res = await window.game.travelBuy(choice.itemId, choice.cost);
    log(res.ok ? res.message : `[LỖI] ${res.error}`, res.ok ? 'success' : 'error');
    await refreshState(); renderStats(); showIdleChoices();
  }
}

async function combatAction(fn) {
  const res = await fn();
  if (!res.ok) { addCombatLog(`[LỖI] ${res.error}`); return; }
  if (res.combat?.log) res.combat.log.forEach(l => addCombatLog(l));
  await handleCombatResult(res);
}

async function combatActionFlee() {
  const res = await window.game.playerFlee();
  if (!res.ok) { addCombatLog(`[LỖI] ${res.error}`); return; }
  if (res.result === 'fled') {
    hideCombatOverlay(); await refreshState(); renderStats();
    log('Đã thoát khỏi combat.', 'success');
    showIdleChoices();
  } else {
    addCombatLog('Chạy thất bại!');
    await refreshState(); renderStats();
  }
}

async function handleCombatResult(res) {
  await refreshState(); renderStats();
  if (res.victory) {
    hideCombatOverlay();
    log(`🎉 Chiến thắng! Nhận ${res.rewards?.spiritStones || 0} Linh Thạch, +${res.rewards?.expReward || 0} EXP.${res.rewards?.leveledUp ? ` ⬆️ RUN LV.${res.rewards.runLevel}!` : ''}`, 'success');
    if (state.run) log(`HP còn: ${state.run.hp}/${state.run.hp_max}`, 'info');
    await window.game.completeCombatNode();
    showIdleChoices();
  } else if (res.defeat) {
    hideCombatOverlay();
    log('💀 Tử trận trong combat!', 'error');
    // Tự động xử lý death + hiển thị tổng kết
    await processDeathAndShowSummary();
  } else {
    // Combat continuing — update overlay, keep fighting
    if (res.combat) updateCombatOverlay(res.combat);
    else {
      const view = await window.game.getCombatView();
      if (view?.combat) updateCombatOverlay(view.combat);
    }
    renderCombatChoices();
  }
}

// ═══════════════════════════════════════════════
// COMMAND REGISTRY — game logic intact
// ═══════════════════════════════════════════════
const commands = {
  help: {
    desc: 'Hiện danh sách lệnh',
    run: () => {
      log('=== LỆNH KHẢ DỤNG ===', 'system');
      Object.entries(commands).forEach(([name, c]) => log(`  ${name.padEnd(14)} - ${c.desc}`, 'dim'));
    }
  },

  start: {
    desc: 'Khởi đầu kiếp mới (roll Linh Căn + Gia Cảnh)',
    run: async () => {
      const lc = await window.game.rollLinhCan();
      await typewrite(`${tierIcon(lc.def.tier)} ${lc.def.name}${pityTag(lc)}`, tierClass(lc.def.tier));
      log(`   ${lc.def.desc}`, 'dim');

      const gc = await window.game.rollGiaCanh();
      await typewrite(`${tierIcon(gc.def.tier)} ${gc.def.name}${pityTag(gc)}`, tierClass(gc.def.tier));
      log(`   ${gc.def.desc}`, 'dim');

      const run = await window.game.createRun({ linhCanId: lc.result, giaCanhId: gc.result });
      await refreshState(); renderStats();
      const realm = gameData.realms.find(r => r.id === run.realm_id);
      log(`Chuyển sinh hoàn tất. Cảnh giới: ${realm?.name || '?'}.`, 'success');
      // Show map
      const view = await window.game.getMapView();
      if (view?.mapState) renderMapModal(view.mapState);
      showIdleChoices();
    }
  },

  status: {
    desc: 'Xem trạng thái đầy đủ',
    run: async () => {
      await refreshState(); renderStats();
      const { run, account } = state;
      
      let html = '<div class="status-grid-2">';
      // Tài khoản
      html += `<div class="status-block">
        <h3 style="color:var(--gold); border-bottom:1px solid rgba(184,134,11,0.2); padding-bottom:5px;">👤 Tài khoản</h3>
        <p><b>Level:</b> ${account.level}</p>
        <p><b>Điểm Luân Hồi:</b> <span class="gold-text">${account.luan_hoi_points}</span></p>
        <p><b>Tổng kiếp:</b> ${account.total_lifetimes}</p>
      </div>`;

      if (!run || run.alive === 0) {
        html += '<div class="status-block"><h3>💀 Chưa có kiếp sống</h3><p>Nhập "start" để đầu thai.</p></div>';
      } else {
        const lc = gameData.linhCan.find(x => x.id === run.linh_can_id);
        const gc = gameData.giaCanh.find(x => x.id === run.gia_canh_id);
        const realm = gameData.realms.find(x => x.id === run.realm_id);
        
        html += `<div class="status-block">
          <h3 style="color:var(--jade); border-bottom:1px solid rgba(39,174,96,0.2); padding-bottom:5px;">✨ Hình Tướng & Thân Thế</h3>
          <p><b>Cảnh Giới:</b> <span class="jade-text font-bold">${realm?.name||'?'}</span></p>
          <p><b>Linh Căn:</b> ${lc?.name||'?'}</p>
          <p><b>Gia Cảnh:</b> ${gc?.name||'?'}</p>
        </div>
        
        <div class="status-block">
          <h3 style="color:var(--crimson); border-bottom:1px solid rgba(192,57,43,0.2); padding-bottom:5px;">🔥 Thuộc Tính & Sinh Tồn</h3>
          <p><b>Khí Huyết:</b> ${run.hp}/${run.hp_max} ❤️</p>
          <p><b>Chân Nguyên:</b> ${run.linh_khi}/${run.linh_khi_max} 💧</p>
          <p><b>Tu Vi:</b> ${run.tu_vi} ☯️</p>
          <p><b>Thọ Nguyên:</b> ${Math.floor(run.tuoi_tho)}/${Math.floor(run.tuoi_tho_max)} ⏳</p>
        </div>
        
        <div class="status-block">
          <h3 style="color:var(--gold); border-bottom:1px solid rgba(184,134,11,0.2); padding-bottom:5px;">💎 Tài Nguyên & Khác</h3>
          <p><b>Linh Thạch:</b> ${run.spirit_stones}</p>
          <p><b>Cơ Duyên:</b> ${run.luck}</p>
          <p><b>Số địch đã hạ:</b> ${run.monsters_killed}</p>
        </div>`;
      }
      html += '</div>';
      showModal('📜 Hồ Sơ Nhân Vật', html);
    }
  },

  map: {
    desc: 'Hiển thị bản đồ',
    requiresAlive: true,
    run: async () => {
      await refreshState();
      if (state.run.fsm_state === 'COMBAT') { log('Đang trong combat!', 'warning'); return; }
      const view = await window.game.getMapView();
      if (!view?.mapState) { log('Chưa có bản đồ. Gõ "start".', 'warning'); return; }
      renderMapModal(view.mapState);
    }
  },

  enter: {
    desc: 'Vào node hiện tại trên bản đồ',
    requiresAlive: true,
    run: async () => {
      await refreshState();
      if (state.run.fsm_state === 'COMBAT') { log('Đang chiến đấu!', 'warning'); return; }
      const res = await window.game.enterNode();
      if (!res.ok) { log(`[LỖI] ${res.error}`, 'error'); return; }
      await handleNodeResult(res);
    }
  },

  next: {
    desc: 'Chọn node tiếp theo: next <số>',
    requiresAlive: true,
    run: async (args) => {
      const idx = parseInt(args[1], 10);
      if (isNaN(idx)) { log('Usage: next <số>. Xem map để biết các node.', 'error'); return; }
      const res = await window.game.selectNode(idx);
      if (!res.ok) { log(`[LỖI] ${res.error}`, 'error'); return; }
      log(`Đã chọn: ${res.currentNode.icon} ${res.currentNode.desc}`, 'success');
      renderMapModal(res.mapState);
    }
  },

  choose: {
    desc: 'Chọn trong event: choose <số>',
    requiresAlive: true,
    run: async (args) => {
      const idx = parseInt(args[1], 10);
      if (isNaN(idx)) { log('Usage: choose <số>', 'error'); return; }
      const res = await window.game.resolveChoice(idx);
      if (!res.ok) { log(`[LỖI] ${res.error}`, 'error'); return; }
      log(res.result.outcomeText, res.result.outcome === 'success' ? 'success' : 'error');
      if (res.result.reward) log(`  → Thưởng: ${JSON.stringify(res.result.reward)}`, 'info');
      if (res.result.damage) log(`  → Thiệt hại: ${JSON.stringify(res.result.damage)}`, 'error');
      if (res.died) { await refreshState(); renderStats(); log('💀 Tử vong!', 'error'); return; }
      await refreshState(); renderStats();
      if (res.mapState) renderMapModal(res.mapState);
      showIdleChoices();
    }
  },

  attack: {
    desc: 'Tấn công thường', requiresAlive: true, requiresCombat: true,
    run: async () => {
      const res = await window.game.playerAttack();
      if (!res.ok) { log(`[LỖI] ${res.error}`, 'error'); return; }
      res.combat?.log?.forEach(l => addCombatLog(l));
      await handleCombatResult(res);
    }
  },
  cast: {
    desc: 'Thi pháp (tốn 20 LK)', requiresAlive: true, requiresCombat: true,
    run: async () => {
      const res = await window.game.playerCast();
      if (!res.ok) { log(`[LỖI] ${res.error}`, 'error'); return; }
      res.combat?.log?.forEach(l => addCombatLog(l));
      await handleCombatResult(res);
    }
  },
  flee: {
    desc: 'Bỏ chạy (Luck-based)', requiresAlive: true, requiresCombat: true,
    run: async () => {
      const res = await window.game.playerFlee();
      if (!res.ok) { log(`[LỖI] ${res.error}`, 'error'); return; }
      if (res.result === 'fled') { hideCombatOverlay(); await refreshState(); renderStats(); log('Đã thoát.', 'success'); showIdleChoices(); }
      else { log('Chạy thất bại!', 'error'); await refreshState(); renderStats(); }
    }
  },
  forbidden_art: {
    desc: 'Cấm thuật (tốn 20% HP + 30 LK)', requiresAlive: true, requiresCombat: true,
    run: async () => {
      const res = await window.game.playerForbiddenArt();
      if (!res.ok) { log(`[LỖI] ${res.error}`, 'error'); return; }
      res.combat?.log?.forEach(l => addCombatLog(l));
      await handleCombatResult(res);
    }
  },

  inventory: {
    desc: 'Xem túi đồ + trang bị',
    run: async () => {
      await refreshState();
      const inv = state.inventory;
      const defs = gameData?.itemDefs || {};
      const eq = await window.game.getEquipmentView();
      let html = '';
      
      // Trang bị đang mặc
      if (eq && (eq.weapon || eq.armor || eq.accessory)) {
        html += '<div style="margin-bottom:1.5rem;">';
        html += '<h3 style="color:var(--gold); border-bottom:1px solid rgba(184,134,11,0.2); padding-bottom:5px; margin-bottom:10px;">⚔️ Trang Bị Hiện Tại</h3>';
        html += '<div class="inv-grid" style="grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));">';
        
        const renderEq = (item, type, icon) => {
          if (!item) return `<div class="inv-card" style="opacity:0.6; border:1px dashed #e9ecef;"><div class="inv-card-title" style="color:var(--text-dim);">${icon} Trống</div><div class="inv-card-sub">[${type}]</div></div>`;
          return `<div class="inv-card" style="border-color:var(--jade); background:var(--jade-light);">
            <div class="inv-card-title" style="color:var(--jade);">${icon} ${item.name}</div>
            <div class="inv-card-sub" style="color:var(--jade);">[${type}]</div>
            <div class="inv-card-btns"><button onclick="window.dispatch('unequip ${type}')">Tháo</button></div>
          </div>`;
        };
        html += renderEq(eq.weapon, 'weapon', '🔪');
        html += renderEq(eq.armor, 'armor', '🛡️');
        html += renderEq(eq.accessory, 'accessory', '💍');
        html += '</div></div>';
      }
      
      // Túi đồ
      html += '<h3 style="color:var(--text-main); border-bottom:1px solid #e9ecef; padding-bottom:5px; margin-bottom:10px;">🎒 Hành Trang</h3>';
      if (!inv.length) { 
        html += '<p style="color:var(--text-dim); font-style:italic;">Túi đồ trống không, gió thổi qua lanh lảnh...</p>'; 
      } else {
        html += '<div class="inv-grid">';
        inv.forEach(it => {
          const d = defs[it.item_id];
          const typeStr = d?.type==='equipment' ? `[${d.slot}]` : d?.type==='consumable' ? '[Đan Dược]' : '[Vật Phẩm]';
          html += `<div class="inv-card">
            <div class="inv-card-title">${d?.icon||'📦'} ${d?.name||it.item_name} <span style="color:var(--gold)">x${it.quantity}</span></div>
            <div class="inv-card-sub" style="font-style:italic;">${d?.desc||''} <br>${typeStr}</div>
            <div class="inv-card-btns">`;
          if (d?.type === 'consumable') html += `<button style="background:var(--jade-light); border-color:var(--jade); font-weight:bold;" onclick="window._modalUse('${it.item_id}')">Dùng</button>`;
          if (d?.type === 'equipment') html += `<button onclick="window._modalEquip('${it.item_id}','${d.slot}')">Trang bị</button>`;
          html += `</div></div>`;
        });
        html += '</div>';
      }
      showModal('🎒 Quản Lý Hành Trang', html);
    }
  },

  meditate: {
    desc: 'Thiền định: meditate [phút] (default 10, max 60, 0 = thức tỉnh)',
    requiresAlive: true,
    run: async (args) => {
      await refreshState();
      if (state.run.fsm_state === 'MEDITATING') {
        // Người chơi muốn thức tỉnh
        if (args[1] === '0' || args[1] === 'stop') {
          const res = await window.game.transition('IDLE');
          if (!res.ok) { log(`[LỖI] ${res.error}`, 'error'); return; }
          log('Đã thức tỉnh khỏi nhập định.', 'success');
          await refreshState(); renderStats(); showIdleChoices();
          return;
        }
        log('Đang nhập định. Gõ "meditate 0" để thức tỉnh.', 'warning');
        return;
      }
      if (state.run.fsm_state !== 'IDLE') { log(`Không thể thiền khi ${state.run.fsm_state}.`, 'error'); return; }
      const mins = Math.min(60, Math.max(1, parseInt(args[1], 10) || 10));
      log(`Bắt đầu thiền ${mins} phút...`, 'system');
      const res = await window.game.meditate(mins);
      if (!res.ok) { log(`[LỖI] ${res.error}`, 'error'); return; }
      await typewrite(res.message, res.ambushed ? 'error' : 'success');
      await refreshState(); renderStats();
      if (res.ambushed && res.combat) {
        showCombatOverlay(res.combat);
        res.combat.log.forEach(l => addCombatLog(l));
      } else { showIdleChoices(); }
    }
  },

  breakthrough: {
    desc: 'Đột phá cảnh giới',
    requiresAlive: true,
    run: async () => {
      await refreshState();
      if (state.run.fsm_state === 'TRIBULATION') { log('Đang thiên kiếp! Gõ "endure".', 'warning'); return; }
      if (state.run.fsm_state !== 'IDLE') { log(`Không thể đột phá khi ${state.run.fsm_state}.`, 'error'); return; }
      const check = await window.game.canBreakthrough();
      if (!check.ok) { log(`[LỖI] ${check.error}`, 'error'); return; }
      if (!check.canAttempt) { log(`[LỖI] ${check.reason}`, 'error'); return; }
      log(`Đột phá: Tỉ lệ ${(check.successRate*100).toFixed(1)}%`, 'system');
      const res = await window.game.attemptBreakthrough();
      if (!res.ok) { log(`[LỖI] ${res.error}`, 'error'); return; }
      await typewrite(res.message, res.success ? 'success' : 'error');
      await refreshState(); renderStats();
      if (res.tauHoa) {
        // Tẩu hỏa nhập ma → chết
        log('💀 TẨU HỎA NHẬP MA — tử vong!', 'error');
        await processDeathAndShowSummary();
      } else if (res.tribulation) {
        log(`⚡ THIÊN KIẾP! ${res.strikes} đạo. Gõ "endure".`, 'error');
        showChoices([{ label: '⚡ Chịu lôi kiếp', action: 'endure', primary: true }]);
      } else if (res.success) {
        log(`Cảnh giới mới: ${state.run.realm_id.toUpperCase()}!`, 'success');
        showIdleChoices();
      }
    }
  },

  endure: {
    desc: 'Chịu 1 đạo lôi kiếp',
    requiresAlive: true, requiresTribulation: true,
    run: async () => {
      const res = await window.game.endureTribulation();
      if (!res.ok) { log(`[LỖI] ${res.error}`, 'error'); return; }
      log(res.message, res.died ? 'error' : res.tribulationOver ? 'success' : 'warning');
      await refreshState(); renderStats();
      if (res.died) {
        await processDeathAndShowSummary();
      } else if (res.tribulationOver) { log(`Cảnh giới mới: ${state.run.realm_id.toUpperCase()}!`, 'success'); showIdleChoices(); }
    }
  },

  craft: {
    desc: 'Chế tạo: craft [category] | craft make <id>',
    requiresAlive: true,
    run: async (args) => {
      if (args[1] === 'make') {
        const rid = args[2]; if (!rid) { log('Usage: craft make <id>', 'error'); return; }
        const res = await window.game.craftItem(rid);
        log(res.message, res.success ? 'success' : 'error');
        await refreshState(); renderStats();
        return;
      }
      const recipes = await window.game.getCraftingRecipes(args[1] || null);
      if (!recipes.length) { log('Không có recipe khả dụng.', 'dim'); return; }
      const cats = gameData?.recipeCategories || {};
      let html = '<div class="shop-list">';
      recipes.forEach(r => {
        const cat = cats[r.category];
        html += `<div class="shop-row">
          <div class="shop-info"><div class="shop-item-name">${cat?.icon||'?'} ${r.name}</div><div class="shop-item-desc">${r.desc} (${(r.successRate*100).toFixed(0)}% - ${r.cost?.spiritStones||0} LS)</div></div>
          <button class="shop-buy-btn" onclick="window._craftMake('${r.id}')">Chế tạo</button></div>`;
      });
      html += '</div>';
      showModal('⚒️ Chế tạo', html);
    }
  },

  sect: {
    desc: 'Tông môn: sect list | join <id> | leave | contribute <amount>',
    requiresAlive: true,
    run: async (args) => {
      const sub = args[1];
      if (sub === 'list') {
        const sects = await window.game.listSects();
        let html = '<div class="shop-list">';
        sects.forEach(s => {
          html += `<div class="shop-row"><div class="shop-info">
            <div class="shop-item-name">${s.canJoin?'✅':'❌'} ${s.sect.name} (${s.sect.tier})</div>
            <div class="shop-item-desc">${s.sect.desc}${!s.canJoin?` — ${s.reason}`:''}</div>
          </div>${s.canJoin?`<button class="shop-buy-btn" onclick="window._sectJoin('${s.sect.id}')">Gia nhập</button>`:''}</div>`;
        });
        html += '</div>';
        showModal('🏛️ Tông môn', html);
        return;
      }
      if (sub === 'join') {
        const res = await window.game.joinSect(args[2]);
        log(res.ok ? res.message : `[LỖI] ${res.error}`, res.ok ? 'success' : 'error');
        return;
      }
      if (sub === 'leave') {
        const res = await window.game.leaveSect();
        log(res.ok ? res.message : `[LỖI] ${res.error}`, res.ok ? 'warning' : 'error');
        return;
      }
      if (sub === 'contribute') {
        const amt = parseInt(args[2], 10);
        if (isNaN(amt)) { log('Usage: sect contribute <amount>', 'error'); return; }
        const res = await window.game.contribute(amt);
        log(res.message, res.rankedUp ? 'success' : 'info');
        await refreshState(); renderStats();
        return;
      }
      const sst = await window.game.getSectState();
      if (!sst) { log('Chưa gia nhập tông môn. Gõ "sect list".', 'dim'); return; }
      log(`Tông môn: ${sst.sectId} | Cống hiến: ${sst.contribution}`, 'info');
    }
  },

  shop: {
    desc: 'Cửa hàng Luân Hồi: shop | shop buy <id>',
    run: async (args) => {
      if (args[1] === 'buy') {
        const res = await window.game.buyShopItem(args[2]);
        if (!res.ok) { log(`[LỖI] ${res.error}`, 'error'); return; }
        log(`✅ Đã mua: ${res.item} (Cấp ${res.newLevel}). Còn ${res.remainingPoints} ĐLH.`, 'success');
        hideModal(); return;
      }
      const items = await window.game.getShopItems();
      if (!items.length) { log('Shop trống.', 'dim'); return; }
      const cats = gameData?.shop?.categories || {};
      let html = '<div class="shop-list">';
      let lastCat = '';
      items.forEach(it => {
        if (it.category !== lastCat) {
          html += `<div style="color:var(--neon-cyan);font-weight:600;margin-top:8px">${cats[it.category]?.icon||'?'} ${cats[it.category]?.name||it.category}</div>`;
          lastCat = it.category;
        }
        html += `<div class="shop-row">
          <div class="shop-info"><div class="shop-item-name">${it.name} ${it.currentLevel}/${it.maxLevel||'∞'}</div><div class="shop-item-desc">${it.desc}</div></div>
          <span class="shop-item-cost">${it.maxed?'MAX':it.canBuy?`${it.cost} ĐLH`:`Khóa`}</span>
          <button class="shop-buy-btn" ${!it.canBuy?'disabled':''} onclick="window._shopBuy('${it.id}')">Mua</button></div>`;
      });
      html += '</div>';
      showModal('🛒 Cửa hàng Luân Hồi', html);
    }
  },

  achievements: {
    desc: 'Xem thành tựu',
    run: async () => {
      const check = await window.game.checkAchievements();
      if (check.newUnlocks?.length) {
        log('🏆 THÀNH TỰU MỚI! 🏆', 'success');
        check.newUnlocks.forEach(a => log(`  ⭐ ${a.name} (+${a.reward.luanHoiPoints} ĐLH)`, 'success'));
      }
      const list = await window.game.getAchievementsView();
      let html = '<div class="shop-list">';
      list.forEach(a => {
        html += `<div class="shop-row"><div class="shop-info">
          <div class="shop-item-name">${a.unlocked?'✅':'🔒'} ${a.name}</div>
          <div class="shop-item-desc">${a.desc} — +${a.reward.luanHoiPoints} ĐLH</div>
        </div></div>`;
      });
      html += '</div>';
      showModal('🏆 Thành tựu', html);
    }
  },

  account: {
    desc: 'Xem tài khoản vĩnh viễn',
    run: async () => {
      const stats = await window.game.getAccountStats();
      let html = '<div class="status-grid-2">';
      html += `<div class="status-block"><h3>👤 Tài khoản</h3><p>Lv.${stats.account.level} | ${stats.account.total_exp} EXP</p><p>Điểm Luân Hồi: ${stats.account.luan_hoi_points}</p><p>Tổng kiếp: ${stats.account.total_lifetimes}</p><p>Điểm cao nhất: ${stats.bestScore}</p></div>`;
      html += `<div class="status-block"><h3>📊 Tiên thiên</h3><p>HP +${stats.innateBonuses.innate_hp_bonus}</p><p>LK +${stats.innateBonuses.innate_linhkhi_bonus}</p><p>Luck +${stats.innateBonuses.innate_luck_bonus}</p><p>Shop: ${stats.purchasedCount} lần mua</p></div>`;
      html += '</div>';
      showModal('👤 Tài khoản vĩnh viễn', html);
    }
  },

  history: {
    desc: 'Xem lịch sử các kiếp',
    run: async () => {
      const hist = await window.game.getRunHistory(10);
      if (!hist.length) { log('Chưa có kiếp nào.', 'dim'); return; }
      log('=== LỊCH SỬ LUÂN HỒI ===', 'system');
      hist.forEach(h => {
        const d = new Date(h.ended_at).toLocaleDateString('vi-VN');
        log(`${d} | ${h.realm_name.padEnd(12)} | Điểm:${String(h.score).padStart(6)} | Giết:${String(h.monsters_killed).padStart(3)}`, 'dim');
      });
    }
  },

  travel: {
    desc: 'Đi lang thang — gặp sự kiện ngẫu nhiên',
    requiresAlive: true,
    run: async () => {
      await refreshState();
      if (state.run.fsm_state === 'COMBAT') { log('Đang chiến đấu!', 'warning'); return; }
      if (state.run.fsm_state !== 'IDLE') { log(`Không thể đi khi ${state.run.fsm_state}.`, 'error'); return; }
      await doTravelStep();
    }
  },

  đi: {
    desc: 'Đi lang thang (alias của travel)',
    requiresAlive: true,
    run: async () => {
      await refreshState();
      if (state.run.fsm_state !== 'IDLE') { log(`Không thể đi khi ${state.run.fsm_state}.`, 'error'); return; }
      await doTravelStep();
    }
  },

  use: {
    desc: 'Sử dụng vật phẩm: use <id>',
    requiresAlive: true,
    run: async (args) => {
      const id = args[1]; if (!id) { log('Usage: use <itemId>', 'error'); return; }
      const res = await window.game.useItem(id);
      log(res.ok ? res.message : `[LỖI] ${res.error}`, res.ok ? 'success' : 'error');
      await refreshState(); renderStats();
    }
  },

  equip: {
    desc: 'Trang bị: equip <id>',
    requiresAlive: true,
    run: async (args) => {
      const id = args[1]; if (!id) { log('Usage: equip <itemId>', 'error'); return; }
      const def = gameData?.itemDefs?.[id];
      if (!def) { log('Không tìm thấy vật phẩm.', 'error'); return; }
      if (def.type !== 'equipment') { log(`Dùng "use ${id}" thay vì equip.`, 'error'); return; }
      const res = await window.game.equipItem(id, def.slot);
      log(res.ok ? res.message : `[LỖI] ${res.error}`, res.ok ? 'success' : 'error');
      await refreshState();
    }
  },

  unequip: {
    desc: 'Tháo trang bị: unequip <weapon|armor|accessory>',
    requiresAlive: true,
    run: async (args) => {
      const slot = args[1];
      if (!['weapon','armor','accessory'].includes(slot)) { log('Slot: weapon|armor|accessory', 'error'); return; }
      const res = await window.game.unequipItem(slot);
      log(res.ok ? res.message : `[LỖI] ${res.error}`, res.ok ? 'success' : 'error');
      await refreshState();
    }
  },

  die: {
    desc: 'Kết thúc kiếp hiện tại (tự sát)',
    requiresAlive: true,
    run: async () => {
      await processDeathAndShowSummary();
    }
  },

  clear: { desc: 'Xóa màn hình', run: () => { const el = document.getElementById('log-inner'); if (el) el.innerHTML = ''; } },
};

// ── Dispatcher ──
async function dispatch(raw) {
  log(raw, 'dim');
  const args = raw.split(/\s+/);
  const name = args[0].toLowerCase();
  const cmd = commands[name];
  if (!cmd) { log(`Lệnh không tồn tại: '${name}'. Gõ "help".`, 'error'); return; }

  if (cmd.requiresAlive) {
    await refreshState();
    if (!state.run || state.run.alive === 0) { log('Cần có kiếp sống. Gõ "start".', 'error'); return; }
  }
  if (cmd.requiresCombat) {
    await refreshState();
    if (!state.run || state.run.fsm_state !== 'COMBAT') { log('Không trong combat.', 'error'); return; }
  }
  if (cmd.requiresTribulation) {
    await refreshState();
    if (!state.run || state.run.fsm_state !== 'TRIBULATION') { log('Không trong thiên kiếp.', 'error'); return; }
  }

  try { await cmd.run(args); }
  catch (e) { log(`[LỖI] ${e.message}`, 'error'); console.error(e); }
}

// ── Cosmetic helpers ──
function tierIcon(t) { return {legendary:'🌟',mythic:'⚡',rare:'✦',common:'·'}[t]||'·'; }
function tierClass(t) { return {legendary:'success',mythic:'success',rare:'info',common:'warning'}[t]||''; }
function pityTag(r) { return r.resetPity?' [PITY RESET]':` (pity ${r.pityCount+1})`; }

// ── Map Modal ──
function renderMapModal(mapState) {
  if (!mapState?.layers) return;
  const ntypes = gameData?.map?.nodeTypes || {};

  // Calculate total layers for progress
  const totalLayers = mapState.layers.length;
  const currentLayer = mapState.currentLayer;
  const progress = Math.round((currentLayer / Math.max(1, totalLayers - 1)) * 100);

  let html = '';

  // Progress indicator
  html += `<div style="text-align:center;margin-bottom:12px;">
    <div class="progress-track" style="height:6px;margin-bottom:6px;">
      <div class="progress-fill mp-fill" style="width:${progress}%;"></div>
    </div>
    <span style="font-size:12px;color:var(--text-dim);">Tiến độ: ${currentLayer}/${totalLayers} lớp</span>
  </div>`;

  // Timeline layers
  html += '<div style="max-height:55vh;overflow-y:auto;">';
  mapState.layers.forEach((layer, li) => {
    const isPast = li < currentLayer;
    const isCurrent = li === currentLayer;
    const isFuture = li > currentLayer;
    const isLast = li === totalLayers - 1;

    // Layer header with icon
    const layerIcon = isPast ? '✅' : isCurrent ? '📍' : isLast ? '👑' : '🔒';
    const layerLabel = isLast ? `BOSS CUỐI` : `Tầng ${li + 1}`;
    const opacity = isPast ? '0.5' : isCurrent ? '1' : '0.6';

    html += `<div style="opacity:${opacity};margin-bottom:10px;padding:8px 12px;border-radius:8px;${isCurrent?'background:var(--jade-light);border:1px solid var(--jade);':''}${isPast?'background:#f8f9fa;':''}${isFuture?'background:#fff;':''}">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
        <span style="font-weight:700;font-size:14px;">${layerIcon} ${layerLabel} ${isLast?'👑':''}</span>
        ${isCurrent ? '<span style="font-size:11px;color:var(--jade);font-weight:700;">← HIỆN TẠI</span>' : ''}
      </div>
      <div class="map-node-row" style="gap:6px;">`;

    layer.forEach((node, ni) => {
      const st = mapState.nodeStates[node.id] || 'locked';
      let cls = '';
      if (st === 'cleared' || isPast) cls = 'done';
      else if (isCurrent && ni === mapState.currentNodeIndex) cls = 'active';
      else if (st === 'locked' || isFuture) cls = '';

      const isCurrentNode = isCurrent && ni === mapState.currentNodeIndex;

      html += `<div class="map-node-chip ${cls}" style="color:${node.color || '#333'};border-color:${node.color || '#ccc'};">
        ${node.icon || '?'} ${node.desc}${isCurrentNode ? ' ◀' : ''}
      </div>`;
    });

    html += '</div>';

    // Show available next nodes when at current layer
    if (isCurrent && currentLayer < totalLayers - 1) {
      const conns = mapState.connections[currentLayer];
      const cn = layer[mapState.currentNodeIndex];
      const reachable = (conns && cn) ? (conns[cn.id] || []) : [];
      const nextLayer = mapState.layers[currentLayer + 1];

      if (reachable.length > 0) {
        html += '<div style="margin-top:8px;font-size:12px;color:var(--text-dim);">⬇ Có thể tiến đến:</div>';
        html += '<div class="map-node-row" style="gap:6px;margin-top:4px;">';
        reachable.forEach(nid => {
          const target = nextLayer.find(n => n.id === nid);
          if (target) {
            const targetIdx = nextLayer.indexOf(target);
            html += `<div class="map-node-chip" style="color:${target.color};border-color:${target.color};cursor:pointer;"
              onclick="window._mapSelectNode(${targetIdx})" title="Bấm để chọn node này">
              ➡ ${target.icon} ${target.desc}
            </div>`;
          }
        });
        html += '</div>';
      }
    }

    html += '</div>';
  });
  html += '</div>';

  // Action buttons at bottom
  html += '<div style="display:flex;gap:8px;margin-top:12px;border-top:1px solid #e9ecef;padding-top:12px;">';

  // Enter current node button
  if (currentLayer < totalLayers) {
    const cn = mapState.layers[currentLayer]?.[mapState.currentNodeIndex];
    const nodeState = cn ? mapState.nodeStates[cn.id] : 'locked';
    if (nodeState !== 'cleared') {
      html += `<button class="shop-buy-btn" onclick="window._mapEnterNode()" style="flex:1;">⚡ Vào ${cn?.desc || 'node'}</button>`;
    }
  }

  html += `<button class="shop-buy-btn" onclick="window._closeMap()" style="flex:1;background:#fff;border-color:#ccc;color:var(--text-dim);">✕ Đóng</button>`;
  html += '</div>';

  // Legend
  html += '<div style="margin-top:8px;font-size:10px;color:var(--text-dim);text-align:center;">';
  for (const def of Object.values(ntypes)) {
    html += `${def.icon} ${def.desc} &nbsp;`;
  }
  html += '</div>';

  showModal('🗺️ Bản Đồ Hành Trình', html);

  // Wire modal body close handlers
  setTimeout(() => {
    const closeBtn = document.querySelector('#modal-overlay .modal-close-x');
    if (closeBtn) closeBtn.onclick = hideModal;
  }, 50);
}

// ── Node Handler ──
async function handleNodeResult(res) {
  if (res.action === 'combat') {
    showCombatOverlay(res.combat);
    res.combat.log.forEach(l => addCombatLog(l));
  } else if (res.action === 'event') {
    log(`=== ${res.node.icon} ${res.node.desc} ===`, 'system');
    await typewrite(res.script.text, 'narrator');
    const choices = res.script.choices.map((c, i) => {
      const riskTag = c.risk==='none'?'':` [Rủi ro: ${c.risk}]`;
      return { label: `${c.text}${riskTag}`, action: 'command', cmd: `choose ${i}` };
    });
    showChoices(choices);
  } else {
    log(`=== ${res.node.icon} ${res.node.desc} ===`, 'system');
    if (res.result) log(res.result.text, 'success');
    await refreshState(); renderStats();
    showIdleChoices();
  }
}

// ── Travel Logic ──
async function doTravelStep() {
  const res = await window.game.travelStep();
  if (!res.ok) { log(`[LỖI] ${res.error}`, 'error'); return; }
  log(`── ${res.icon||'❓'} ${res.scenario.text} ──`, 'system');

  if (res.type === 'combat') {
    showCombatOverlay(res.combat);
    res.combat.log.forEach(l => addCombatLog(l));
    return;
  }
  if (res.result) {
    log(res.result.message, res.result.damage?'error':'success');
    await refreshState(); renderStats();
  }
  if (res.scenario.shop) {
    const shopChoices = res.scenario.shop.map((s, i) => ({
      label: `Mua ${gameData?.itemDefs?.[s.item]?.name||s.item} (${s.cost} LS)`, action: 'buy_item', itemId: s.item, cost: s.cost
    }));
    shopChoices.push({ label: 'Không mua — đi tiếp', action: 'travel' });
    showChoices(shopChoices);
    return;
  }
  if (res.scenario.choices) {
    const eventChoices = res.scenario.choices.map((text, i) => ({
      label: text, action: 'choose_event', choiceIndex: i
    }));
    showChoices(eventChoices);
    return;
  }
  showIdleChoices();
}

// ── Death & Rebirth ──
async function processDeathAndShowSummary() {
  const res = await window.game.processDeath();
  if (!res) { log('[LỖI] Không thể xử lý tử vong.', 'error'); return; }

  await refreshState(); renderStats();

  // Hiển thị tổng kết kiếp vừa qua
  log('══════════════════════════════', 'system');
  log('  💀 KIẾP ĐÃ KẾT THÚC', 'error');
  log(`  Điểm kiếp này: ${res.score}`, 'warning');
  log(`  Tổng số kiếp đã sống: ${res.lifetimes}`, 'info');
  if (res.leveledUp) {
    log(`  ⬆️ TÀI KHOẢN THĂNG CẤP! Level ${res.newLevel}`, 'success');
  }

  // Lấy stats để hiển thị tiên thiên
  const stats = await window.game.getAccountStats();
  if (stats) {
    log('── CHỈ SỐ TIÊN THIÊN (áp dụng kiếp sau) ──', 'system');
    if (stats.innateBonuses.innate_hp_bonus > 0) log(`  ❤️ HP +${stats.innateBonuses.innate_hp_bonus}`, 'success');
    if (stats.innateBonuses.innate_linhkhi_bonus > 0) log(`  💠 Linh Khí +${stats.innateBonuses.innate_linhkhi_bonus}`, 'success');
    if (stats.innateBonuses.innate_luck_bonus > 0) log(`  🍀 Cơ Duyên +${stats.innateBonuses.innate_luck_bonus}`, 'success');
    if (stats.innateBonuses.start_spirit_stones > 0) log(`  💎 Linh Thạch khởi đầu +${stats.innateBonuses.start_spirit_stones}`, 'dim');
    log(`  Điểm Luân Hồi: ${stats.account.luan_hoi_points} — gõ "shop" để mua nâng cấp`, 'info');
  }

  log('══════════════════════════════', 'system');
  log('Gõ "start" hoặc bấm nút để chuyển sinh kiếp mới.', 'dim');

  // Kiểm tra thành tựu mới
  const ach = await window.game.checkAchievements();
  if (ach.newUnlocks?.length) {
    log('🏆 THÀNH TỰU MỚI!', 'success');
    ach.newUnlocks.forEach(a => log(`  ⭐ ${a.name} (+${a.reward.luanHoiPoints} ĐLH)`, 'success'));
  }

  updateQuickActions([{ label: '🔱 Chuyển sinh kiếp mới', action: 'command', cmd: 'start', primary: true }]);
}

// ── Window Helpers (for modal button onclick) ──
window._modalUse = async (id) => { hideModal(); await commands.use.run(['use', id]); };
window._modalEquip = async (id, slot) => { hideModal(); await commands.equip.run(['equip', id]); };
window._shopBuy = async (id) => { await commands.shop.run(['shop', 'buy', id]); };
window._craftMake = async (id) => { await commands.craft.run(['craft', 'make', id]); };
window._sectJoin = async (id) => { await commands.sect.run(['sect', 'join', id]); };

// Map modal interactive helpers
window._mapSelectNode = async (idx) => {
  hideModal();
  await commands.next.run(['next', String(idx)]);
  const view = await window.game.getMapView();
  if (view?.mapState) renderMapModal(view.mapState);
};
window._mapEnterNode = async () => {
  hideModal();
  await commands.enter.run([]);
};
window._closeMap = () => hideModal();

// ═══════════════════════════════════════════════
// BOOTSTRAP
// ═══════════════════════════════════════════════
let isBusy = false;
let commandHistory = [];
let historyIndex = -1;

window.addEventListener('error', (e) => {
  const el = document.getElementById('log-inner') || document.body;
  el.innerHTML += `<div style="color:var(--neon-red);padding:8px;border:1px solid var(--neon-red);margin:4px">RENDERER ERROR: ${e.message} at ${e.filename}:${e.lineno}</div>`;
});

window.addEventListener('DOMContentLoaded', async () => {
  try {
    gameData = await window.game.getData();
    await refreshState();
    await tickLinhKhi();
    renderStats();

    if (!state.run || state.run.alive === 0) {
      log('Tu Tiên Giới — Hệ thống sẵn sàng.', 'system');
      log('Chưa có kiếp sống. Bấm nút bên dưới hoặc gõ "start".', 'warning');
      updateQuickActions([{ label: '🔱 Bắt đầu kiếp mới', action: 'command', cmd: 'start', primary: true }]);
    } else {
      log('Kiếp tu hành tiếp tục.', 'system');
      showIdleChoices();
    }

    setInterval(async () => { await tickLinhKhi(); renderStats(); }, 15000);

    // ── Navigation Bar Handlers ──
    document.querySelectorAll('.nav-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (isBusy) return;
        const nav = btn.dataset.nav;
        playSound('enter');
        if (nav === 'status') {
          await commands.status.run([]);
        } else if (nav === 'inventory') {
          await commands.inventory.run([]);
        } else if (nav === 'shop') {
          await commands.shop.run([]);
        } else if (nav === 'map') {
          await commands.map.run([]);
        }
      });
    });

    // ── Input Handling ──
    const input = document.getElementById('cmd-input');
    if (!input) return;

    input.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') {
        if (isBusy) return;
        playSound('enter');
        const raw = input.value.trim();
        input.value = '';
        if (!raw) return;

        // Number = choice shortcut
        const num = parseInt(raw, 10);
        if (!isNaN(num) && num >= 1 && num <= currentChoices.length && raw === String(num)) {
          isBusy = true;
          try { await executeChoice(currentChoices[num - 1]); } finally { isBusy = false; }
          return;
        }

        if (commandHistory[commandHistory.length - 1] !== raw) commandHistory.push(raw);
        historyIndex = commandHistory.length;
        isBusy = true;
        try { await dispatch(raw); } finally { isBusy = false; }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (historyIndex > 0) { historyIndex--; input.value = commandHistory[historyIndex]; }
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (historyIndex < commandHistory.length - 1) { historyIndex++; input.value = commandHistory[historyIndex]; }
        else { historyIndex = commandHistory.length; input.value = ''; }
      } else if (e.key === 'Tab') {
        e.preventDefault();
        const raw = input.value.trim(); if (!raw) return;
        const matches = Object.keys(commands).filter(c => c.startsWith(raw.toLowerCase()));
        if (matches.length === 1) input.value = matches[0] + ' ';
        else if (matches.length > 1) log(`Gợi ý: ${matches.join(' | ')}`, 'dim');
      }
    });

    // Scroll indicator hide on scroll
    const mainLog = document.getElementById('main-log');
    if (mainLog) {
      mainLog.addEventListener('scroll', () => {
        const ind = document.getElementById('scroll-indicator');
        if (ind) ind.style.opacity = mainLog.scrollTop + mainLog.clientHeight >= mainLog.scrollHeight - 20 ? '0' : '1';
      });
    }
  } catch (e) {
    const el = document.getElementById('log-inner') || document.body;
    el.innerHTML += `<div style="color:var(--neon-red);padding:8px;border:1px solid var(--neon-red)">BOOTSTRAP ERROR: ${e.message}\n${e.stack}</div>`;
  }
});
