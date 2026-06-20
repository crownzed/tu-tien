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
  addItem:       (item) => ipcRenderer.invoke('game:addItem', item),
  // combat
  startCombat:       (opts) => ipcRenderer.invoke('game:startCombat', opts),
  getCombatView:     () => ipcRenderer.invoke('game:getCombatView'),
  playerAttack:      () => ipcRenderer.invoke('game:playerAttack'),
  playerCast:        () => ipcRenderer.invoke('game:playerCast'),
  playerFlee:        () => ipcRenderer.invoke('game:playerFlee'),
  playerForbiddenArt:() => ipcRenderer.invoke('game:playerForbiddenArt'),
  // map / event chain
  getMapView:        () => ipcRenderer.invoke('game:getMapView'),
  selectNode:        (nodeIndex) => ipcRenderer.invoke('game:selectNode', nodeIndex),
  enterNode:         () => ipcRenderer.invoke('game:enterNode'),
  resolveChoice:     (choiceIndex) => ipcRenderer.invoke('game:resolveChoice', choiceIndex),
  completeCombatNode:() => ipcRenderer.invoke('game:completeCombatNode'),
  // breakthrough
  canBreakthrough:    () => ipcRenderer.invoke('game:canBreakthrough'),
  attemptBreakthrough:() => ipcRenderer.invoke('game:attemptBreakthrough'),
  endureTribulation:  () => ipcRenderer.invoke('game:endureTribulation'),
  // crafting
  getCraftingRecipes: (category) => ipcRenderer.invoke('game:getCraftingRecipes', category),
  craftItem:          (recipeId) => ipcRenderer.invoke('game:craftItem', recipeId),
  // sect
  getSectState:       () => ipcRenderer.invoke('game:getSectState'),
  listSects:          () => ipcRenderer.invoke('game:listSects'),
  joinSect:           (sectId) => ipcRenderer.invoke('game:joinSect', sectId),
  leaveSect:          () => ipcRenderer.invoke('game:leaveSect'),
  contribute:         (amount) => ipcRenderer.invoke('game:contribute', amount),
  // shop / metaprogression
  getShopItems:       () => ipcRenderer.invoke('game:getShopItems'),
  buyShopItem:        (itemId) => ipcRenderer.invoke('game:buyShopItem', itemId),
  getRunHistory:      (limit) => ipcRenderer.invoke('game:getRunHistory', limit),
  getAccountStats:    () => ipcRenderer.invoke('game:getAccountStats'),
  // items / equipment
  useItem:            (itemId) => ipcRenderer.invoke('game:useItem', itemId),
  equipItem:          (itemId, slot) => ipcRenderer.invoke('game:equipItem', itemId, slot),
  unequipItem:        (slot) => ipcRenderer.invoke('game:unequipItem', slot),
  getEquipmentView:   () => ipcRenderer.invoke('game:getEquipmentView'),
  // meditation
  meditate:           (minutes) => ipcRenderer.invoke('game:meditate', minutes),
  // achievements
  checkAchievements:  () => ipcRenderer.invoke('game:checkAchievements'),
  getAchievementsView:() => ipcRenderer.invoke('game:getAchievementsView'),
  // travel
  travelStep:         () => ipcRenderer.invoke('game:travelStep'),
  travelBuy:          (itemId, cost) => ipcRenderer.invoke('game:travelBuy', itemId, cost),
  resolveTravelChoice:(choiceIndex) => ipcRenderer.invoke('game:resolveTravelChoice', choiceIndex)
});
