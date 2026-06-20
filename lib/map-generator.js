/**
 * lib/map-generator.js
 * Map Generation Engine — sinh bản đồ node-based cho mỗi kiếp.
 * Data-driven, không phụ thuộc Electron/DOM. Test được bằng node.
 */

const balance = require('../config/balance');

let _nodeIdCounter = 0;

function resetNodeIds() { _nodeIdCounter = 0; }

function nextNodeId() {
  _nodeIdCounter++;
  return `n${_nodeIdCounter}`;
}

/**
 * Chọn map config phù hợp realm order.
 * @param {object} mapData - data/map.json (có .maps array)
 * @param {number} realmOrder
 * @returns {object} map config entry
 */
function pickMapConfig(mapData, realmOrder) {
  const entry = mapData.maps.find(m => realmOrder >= m.realmMin && realmOrder <= m.realmMax);
  if (entry) return entry;
  return mapData.maps[mapData.maps.length - 1];
}

/**
 * Sinh 1 layer node.
 * @param {object} mapCfg - config cho map này
 * @param {object} nodeTypes - data/map.json nodeTypes
 * @param {boolean} isLast - layer cuối (boss)
 * @param {() => number} rng
 * @returns {Array<object>} array of node objects
 */
function generateLayer(mapCfg, nodeTypes, isLast, rng) {
  const { nodesPerLayer } = balance.map;
  const count = nodesPerLayer.min + Math.floor(rng() * (nodesPerLayer.max - nodesPerLayer.min + 1));
  const nodes = [];

  if (isLast) {
    // Layer cuối: 1 node boss + các node thường hướng về boss
    const bossNode = makeNode('boss', nodeTypes);
    nodes.push(bossNode);
    // Thêm 1-2 node khác kết nối vào boss
    const extra = Math.max(0, count - 1);
    for (let i = 0; i < extra; i++) {
      nodes.push(makeNode(null, nodeTypes, mapCfg, rng));
    }
    return nodes;
  }

  const pool = buildNodePool(mapCfg);
  for (let i = 0; i < count; i++) {
    const type = pickFromPool(pool, rng);
    nodes.push(makeNode(type, nodeTypes));
  }
  return nodes;
}

function makeNode(type, nodeTypes) {
  const t = nodeTypes[type] || nodeTypes.combat;
  return {
    id: nextNodeId(),
    type,
    icon: t.icon,
    color: t.color,
    desc: t.desc
  };
}

function buildNodePool(mapCfg) {
  const pool = [];
  const dist = mapCfg.nodeDistribution;
  for (const [type, weight] of Object.entries(dist)) {
    for (let i = 0; i < weight; i++) pool.push(type);
  }
  return pool;
}

function pickFromPool(pool, rng) {
  return pool[Math.floor(rng() * pool.length)];
}

/**
 * Tạo connections giữa 2 layer liền kề.
 * Mỗi node trong layer hiện tại kết nối đến ít nhất 1 node trong layer tiếp theo.
 * Connection density điều khiển số connection phụ thêm.
 * @returns {object} { fromId -> [toId, ...] }
 */
function connectLayers(prevLayer, nextLayer, rng) {
  const density = balance.map.connectionDensity;
  const connections = {};

  for (const prevNode of prevLayer) {
    // Luôn kết nối đến ít nhất 1 node
    const target = pickRandom(nextLayer, rng);
    connections[prevNode.id] = [target.id];

    // Thêm connections phụ dựa trên density
    for (const nextNode of nextLayer) {
      if (nextNode.id === target.id) continue;
      if (rng() < density) {
        connections[prevNode.id].push(nextNode.id);
      }
    }
  }

  // Đảm bảo mỗi node ở next layer được kết nối từ ít nhất 1 node prev layer
  for (const nextNode of nextLayer) {
    const hasConnection = Object.values(connections).some(ids => ids.includes(nextNode.id));
    if (!hasConnection) {
      const src = pickRandom(prevLayer, rng);
      connections[src.id].push(nextNode.id);
    }
  }

  return connections;
}

function pickRandom(arr, rng) {
  return arr[Math.min(arr.length - 1, Math.floor(rng() * arr.length))];
}

/**
 * Sinh toàn bộ map state.
 * @param {object} mapData - data/map.json
 * @param {number} realmOrder
 * @param {() => number} rng
 * @returns {object} mapState
 */
function generateMap(mapData, realmOrder, rng = Math.random) {
  resetNodeIds();
  const mapCfg = pickMapConfig(mapData, realmOrder);
  const nodeTypes = mapData.nodeTypes;
  const numLayers = mapCfg.layers;

  const layers = [];
  const allConnections = [];
  const nodeStates = {};

  for (let i = 0; i < numLayers; i++) {
    const isLast = (i === numLayers - 1);
    const layer = generateLayer(mapCfg, nodeTypes, isLast, rng);
    layers.push(layer);
    for (const node of layer) {
      nodeStates[node.id] = i === 0 ? 'available' : 'locked';
    }
  }

  // Tạo connections
  for (let i = 0; i < layers.length - 1; i++) {
    allConnections.push(connectLayers(layers[i], layers[i + 1], rng));
  }

  return {
    layers,
    connections: allConnections,
    nodeStates,
    currentNodeId: layers[0][0] ? layers[0][0].id : null,
    currentLayer: 0,
    currentNodeIndex: 0,
    path: [],
    mapCfgId: mapCfg.realmMin
  };
}

/**
 * Serialize / deserialize map state.
 */
function parseMapState(json) {
  if (!json) return null;
  try { return JSON.parse(json); } catch { return null; }
}

function serializeMapState(state) {
  return JSON.stringify(state);
}

/**
 * Chọn node ở layer tiếp theo.
 * @returns {{ ok:boolean, error?:string }}
 */
function selectNextNode(mapState, nodeIndex) {
  if (mapState.currentLayer >= mapState.layers.length - 1) {
    return { ok: false, error: 'Đã ở layer cuối' };
  }

  const currentConnections = mapState.connections[mapState.currentLayer];
  if (!currentConnections) return { ok: false, error: 'Không có connections cho layer này' };

  const currentNode = mapState.layers[mapState.currentLayer][mapState.currentNodeIndex];
  const nextLayer = mapState.layers[mapState.currentLayer + 1];

  if (nodeIndex < 0 || nodeIndex >= nextLayer.length) {
    return { ok: false, error: `Node index ${nodeIndex} không hợp lệ (0-${nextLayer.length - 1})` };
  }

  const targetNode = nextLayer[nodeIndex];
  const allowedTargets = currentConnections[currentNode.id] || [];

  if (!allowedTargets.includes(targetNode.id)) {
    return { ok: false, error: `Không thể đến node "${targetNode.desc}" từ đây` };
  }

  // Đánh dấu node cũ đã qua
  mapState.nodeStates[currentNode.id] = 'cleared';
  mapState.path.push(currentNode.id);

  // Chuyển đến node mới
  mapState.currentLayer++;
  mapState.currentNodeIndex = nodeIndex;
  mapState.currentNodeId = targetNode.id;
  mapState.nodeStates[targetNode.id] = 'current';

  // Mở khóa các node có thể đến từ node mới
  if (mapState.currentLayer < mapState.layers.length - 1) {
    const nextConns = mapState.connections[mapState.currentLayer];
    const reachable = nextConns[targetNode.id] || [];
    const nextLayerNodes = mapState.layers[mapState.currentLayer + 1];
    for (const node of nextLayerNodes) {
      if (reachable.includes(node.id) && mapState.nodeStates[node.id] === 'locked') {
        mapState.nodeStates[node.id] = 'available';
      }
    }
  }

  return { ok: true, mapState };
}

/**
 * Đánh dấu node hiện tại đã cleared, trả về danh sách node khả dụng tiếp theo.
 */
function clearCurrentNode(mapState) {
  const cn = mapState.layers[mapState.currentLayer][mapState.currentNodeIndex];
  mapState.nodeStates[cn.id] = 'cleared';

  // Nếu là layer cuối -> map hoàn thành
  if (mapState.currentLayer >= mapState.layers.length - 1) {
    mapState.mapComplete = true;
  }

  return mapState;
}

module.exports = {
  generateMap,
  generateLayer,
  connectLayers,
  selectNextNode,
  clearCurrentNode,
  parseMapState,
  serializeMapState,
  pickMapConfig,
  resetNodeIds
};
