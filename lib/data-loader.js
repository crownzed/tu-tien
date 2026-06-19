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

  cache = {
    linhCan: character.linh_can,
    giaCanh: character.gia_canh,
    events: events.events,
    realms: realms.realms,
    // lookup maps tiện tra cứu
    linhCanById: index(character.linh_can),
    giaCanhById: index(character.gia_canh),
    eventById: index(events.events),
    realmById: index(realms.realms)
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
