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
    backgroundColor: '#000000',
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
    realms: data.realms
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
