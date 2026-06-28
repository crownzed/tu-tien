/**
 * lib/data-loader.js
 * Load + cache content JSON. Single entry point cho data layer.
 * Validate cơ bản để fail-fast nếu data hỏng.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

function loadJSON(file) {
  const full = path.join(DATA_DIR, file);
  const raw = fs.readFileSync(full, 'utf8');
  return JSON.parse(raw);
}

let cache = null;

function loadGameData() {
  if (cache) return cache;

  const character = loadJSON('character.json');
  const events = loadJSON('events.json');
  const realms = loadJSON('realms.json');
  const enemies = loadJSON('enemies.json');
  const recipes = loadJSON('recipes.json');
  const sects = loadJSON('sects.json');
  const shop = loadJSON('shop.json');
  const items = loadJSON('items.json');
  const achievements = loadJSON('achievements.json');
  const travel = loadJSON('travel.json');
  const congPhap = loadJSON('cong-phap.json');

  // Validate fail-fast
  if (!Array.isArray(character.linh_can) || character.linh_can.length === 0) {
    throw new Error('data/character.json: linh_can rỗng hoặc sai định dạng');
  }
  if (!Array.isArray(character.gia_canh) || character.gia_canh.length === 0) {
    throw new Error('data/character.json: gia_canh rỗng hoặc sai định dạng');
  }
  if (!Array.isArray(events.events) || events.events.length === 0) {
    throw new Error('data/events.json: events rỗng');
  }
  if (!Array.isArray(realms.realms) || realms.realms.length === 0) {
    throw new Error('data/realms.json: realms rỗng');
  }
  if (!Array.isArray(enemies.zones) || enemies.zones.length === 0) {
    throw new Error('data/enemies.json: zones rỗng');
  }
  if (!Array.isArray(recipes.recipes) || recipes.recipes.length === 0) {
    throw new Error('data/recipes.json: recipes rỗng');
  }
  if (!Array.isArray(sects.sects) || sects.sects.length === 0) {
    throw new Error('data/sects.json: sects rỗng');
  }
  if (!Array.isArray(shop.items) || shop.items.length === 0) {
    throw new Error('data/shop.json: items rỗng');
  }
  if (!items.items || Object.keys(items.items).length === 0) {
    throw new Error('data/items.json: items rỗng');
  }
  if (!Array.isArray(achievements.achievements) || achievements.achievements.length === 0) {
    throw new Error('data/achievements.json: achievements rỗng');
  }
  if (!travel.stepTypes || !travel.scenarios) {
    throw new Error('data/travel.json: stepTypes hoặc scenarios rỗng');
  }
  if (!Array.isArray(congPhap.cong_phap) || congPhap.cong_phap.length === 0) {
    throw new Error('data/cong-phap.json: cong_phap rỗng hoặc sai định dạng');
  }
  const cpSeen = new Set();
  for (const cp of congPhap.cong_phap) {
    if (!cp.id) throw new Error(`data/cong-phap.json: công pháp "${cp.ten || '?'}" thiếu id`);
    if (cpSeen.has(cp.id)) throw new Error(`data/cong-phap.json: id trùng "${cp.id}"`);
    cpSeen.add(cp.id);
  }

  cache = {
    linhCan: character.linh_can,
    giaCanh: character.gia_canh,
    events: events.events,
    realms: realms.realms,
    enemies: enemies.zones,
    eventScripts: events.eventScripts || {},
    recipes: recipes.recipes,
    recipeCategories: recipes.categories || {},
    sects: sects.sects,
    shop: shop,
    itemDefs: items.items,
    achievements: achievements.achievements,
    travel: travel,
    congPhap: congPhap.cong_phap,
    // lookup maps tiện tra cứu
    linhCanById: index(character.linh_can),
    giaCanhById: index(character.gia_canh),
    eventById: index(events.events),
    realmById: index(realms.realms),
    congPhapById: index(congPhap.cong_phap)
  };
  return cache;
}

function index(arr) {
  const m = {};
  for (const item of arr) m[item.id] = item;
  return m;
}

/** Reset cache (dùng cho test/hot-reload) */
function clearCache() { cache = null; }

module.exports = { loadGameData, clearCache, DATA_DIR };
