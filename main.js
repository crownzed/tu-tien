// Electron Main Process — mỏng, chỉ wire IPC tới GameService.
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const Database = require('better-sqlite3');

const { runMigrations } = require('./db/migrations');
const { createRepositories } = require('./db/repositories');
const { loadGameData } = require('./lib/data-loader');
const { GameService } = require('./lib/game-service');

let mainWindow;
let db;
let svc;
let repos;
let data;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    backgroundColor: '#f2efe8',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  mainWindow.loadFile('renderer/index.html');
  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools();
  }
}

function initGame() {
  const dbPath = path.join(app.getPath('userData'), 'save.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  const mig = runMigrations(db);
  console.log(`[DB] migrations ${mig.from} -> ${mig.to} @ ${dbPath}`);

  repos = createRepositories(db);
  data = loadGameData();
  svc = new GameService(repos, data);
  console.log('[GAME] service ready');
}

// ---------- IPC: state queries ----------
ipcMain.handle('game:getState', () => {
  return {
    account: repos.account.get(),
    run: repos.run.get(),
    pity: repos.pity.get(),
    inventory: repos.inventory.all()
  };
});

ipcMain.handle('game:getData', () => {
  // gửi content cho renderer (read-only)
  return {
    linhCan: data.linhCan,
    giaCanh: data.giaCanh,
    events: data.events,
    realms: data.realms,
    itemDefs: data.itemDefs,
    map: data.map,
    shop: data.shop,
    recipeCategories: data.recipeCategories
  };
});

// ---------- IPC: character creation ----------
ipcMain.handle('game:rollLinhCan', () => svc.rollLinhCan());
ipcMain.handle('game:rollGiaCanh', () => svc.rollGiaCanh());
ipcMain.handle('game:createRun', (e, { linhCanId, giaCanhId }) =>
  svc.createRun(linhCanId, giaCanhId));

// ---------- IPC: linh khi / fsm ----------
ipcMain.handle('game:updateLinhKhi', () => svc.updateLinhKhi());
ipcMain.handle('game:transition', (e, toState) => svc.transitionState(toState));

// ---------- IPC: events / death ----------
ipcMain.handle('game:rollEvent', () => {
  const run = repos.run.get();
  const luck = run ? run.luck : 0;
  const RNGEngine = require('./lib/rng-engine');
  const id = RNGEngine.rollEvent(data.events, luck);
  return { event: data.eventById[id] };
});
ipcMain.handle('game:processDeath', () => svc.processDeath());

// ---------- IPC: combat ----------
ipcMain.handle('game:startCombat', (e, opts) => svc.startCombat(opts?.isBoss || false));
ipcMain.handle('game:getCombatView', () => svc.getCombatView());
ipcMain.handle('game:playerAttack', () => svc.playerAttack());
ipcMain.handle('game:playerCast', () => svc.playerCast());
ipcMain.handle('game:playerFlee', () => svc.playerFlee());
ipcMain.handle('game:playerForbiddenArt', () => svc.playerForbiddenArt());

// ---------- IPC: map / event chain ----------
ipcMain.handle('game:getMapView', () => svc.getMapView());
ipcMain.handle('game:selectNode', (e, nodeIndex) => svc.selectNode(nodeIndex));
ipcMain.handle('game:enterNode', () => svc.enterNode());
ipcMain.handle('game:resolveChoice', (e, choiceIndex) => svc.resolveChoice(choiceIndex));
ipcMain.handle('game:completeCombatNode', () => svc.completeCombatNode());

// ---------- IPC: breakthrough / tribulation ----------
ipcMain.handle('game:canBreakthrough', () => svc.canBreakthrough());
ipcMain.handle('game:attemptBreakthrough', () => svc.attemptBreakthrough());
ipcMain.handle('game:endureTribulation', () => svc.endureTribulation());

// ---------- IPC: crafting ----------
ipcMain.handle('game:getCraftingRecipes', (e, category) => svc.getCraftingRecipes(category));
ipcMain.handle('game:craftItem', (e, recipeId) => svc.craftItem(recipeId));

// ---------- IPC: sect ----------
ipcMain.handle('game:getSectState', () => svc.getSectState());
ipcMain.handle('game:listSects', () => svc.listSects());
ipcMain.handle('game:joinSect', (e, sectId) => svc.joinSect(sectId));
ipcMain.handle('game:leaveSect', () => svc.leaveSect());
ipcMain.handle('game:contribute', (e, amount) => svc.contribute(amount));

// ---------- IPC: shop / metaprogression ----------
ipcMain.handle('game:getShopItems', () => svc.getShopItems());
ipcMain.handle('game:buyShopItem', (e, itemId) => svc.buyShopItem(itemId));
ipcMain.handle('game:getRunHistory', (e, limit) => svc.getRunHistory(limit || 10));
ipcMain.handle('game:getAccountStats', () => svc.getAccountStats());

// ---------- IPC: items / equipment ----------
ipcMain.handle('game:useItem', (e, itemId) => svc.useItem(itemId));
ipcMain.handle('game:equipItem', (e, itemId, slot) => svc.equipItem(itemId, slot));
ipcMain.handle('game:unequipItem', (e, slot) => svc.unequipItem(slot));
ipcMain.handle('game:getEquipmentView', () => svc.getEquipmentView());

// ---------- IPC: meditation ----------
ipcMain.handle('game:meditate', (e, minutes) => svc.meditate(minutes || 10));

// ---------- IPC: achievements ----------
ipcMain.handle('game:checkAchievements', () => svc.checkAchievements());
ipcMain.handle('game:getAchievementsView', () => svc.getAchievementsView());

// ---------- IPC: travel ----------
ipcMain.handle('game:travelStep', () => svc.travelStep());
ipcMain.handle('game:travelBuy', (e, itemId, cost) => svc.travelBuy(itemId, cost));
ipcMain.handle('game:resolveTravelChoice', (e, choiceIndex) => svc.resolveTravelChoice(choiceIndex));

// ---------- IPC: inventory ----------
ipcMain.handle('game:addItem', (e, item) => { repos.inventory.add(item); return { ok: true }; });

// ---------- lifecycle ----------
app.whenReady().then(() => {
  initGame();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    if (db) db.close();
    app.quit();
  }
});
app.on('before-quit', () => { if (db) db.close(); });
