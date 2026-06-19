// Preload — bridge an toàn renderer <-> main. Chỉ expose API cần thiết.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('game', {
  getState:      () => ipcRenderer.invoke('game:getState'),
  getData:       () => ipcRenderer.invoke('game:getData'),
  rollLinhCan:   () => ipcRenderer.invoke('game:rollLinhCan'),
  rollGiaCanh:   () => ipcRenderer.invoke('game:rollGiaCanh'),
  createRun:     (payload) => ipcRenderer.invoke('game:createRun', payload),
  updateLinhKhi: () => ipcRenderer.invoke('game:updateLinhKhi'),
  transition:    (toState) => ipcRenderer.invoke('game:transition', toState),
  rollEvent:     () => ipcRenderer.invoke('game:rollEvent'),
  processDeath:  () => ipcRenderer.invoke('game:processDeath'),
  addItem:       (item) => ipcRenderer.invoke('game:addItem', item)
});
