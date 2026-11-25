// game.js — Gzowo 2049 entry module: three.js renderer, cyber city, robots FSM, player controller, fixed-timestep loop and event-bus wiring for database/multiplayer/ai.

import * as THREE from 'three';
import * as database from './database.js';
import * as multiplayer from './multiplayer.js';
import * as ai from './ai.js';
import * as avatars from './avatars.js';
import * as nav from './nav.js';
import * as manipulator from './manipulator.js';

export const bus = new EventTarget();

export const state = {
  mode: 'menu',
  playerId: '',
  playerName: '',
  lobbyId: '',
  player: { p: { x: 0, y: 0, z: 20 }, ry: Math.PI, vel: { x: 0, z: 0 }, anim: 'idle', arrested: false },
  remotePlayers: new Map(),
  robots: new Map(),
  walls: new Map(),
  wanted: [],
  tick: 0
};

const STEP = 1 / 60;
const ACCENT = 0x00f0c8;
const ALERT = 0xff3860;
const SEEK_ARRIVE = 1.2;
const LERP = 1 - Math.pow(0.001, STEP);
const WORLD_BOUND = 100;
const NAV_CELL = 2;
const REPLAN_INTERVAL = 1.5;
const REPLAN_MOVE2 = 4;
// Waypoint-advance radius (1.5m) must exceed SEEK_ARRIVE (1.2m), else a robot can
// halt between the two thresholds — seek stops moving but the waypoint never advances.
const WAYPOINT_ARRIVE2 = 2.25;
const STUCK_TIME = 2;
const STUCK_DIST2 = 0.04;
const MAX_REPLAN_FAILS = 3;
const REPLANS_PER_STEP = 2;
let replanBudget = 0;

// Four prison cells along the north wall (z=-88). Each is ~4x4m with three walls
// (back + two sides) and an open south side facing the yard. Every cell wall is a
// destructible wall (registered in state.walls + nav) so DESTROY_WALL breaks a
// prisoner out. sit = interior seat point; mouth = the open side the robot enters.
const CELLS = [60, 68, 76, 84].map((x, i) => ({
  index: i,
  sit: { x, z: -84 },
  mouth: { x, z: -81 },
  wallIds: ['wall_c' + (i + 1) + '_a', 'wall_c' + (i + 1) + '_b', 'wall_c' + (i + 1) + '_c']
}));
const CELL_WALL_DEFS = [];
const CELL_WALL_INDEX = new Map();
for (const c of CELLS) {
  const x = c.sit.x;
  CELL_WALL_DEFS.push(
    { id: c.wallIds[0], x, z: -86, len: 4, h: 3, rot: 0 },
    { id: c.wallIds[1], x: x - 2, z: -84, len: 4, h: 3, rot: Math.PI / 2 },
    { id: c.wallIds[2], x: x + 2, z: -84, len: 4, h: 3, rot: Math.PI / 2 }
  );
  for (const wid of c.wallIds) CELL_WALL_INDEX.set(wid, c.index);
}
const GATE_WP = { x: 70, z: -52 };

const SQUARE_CORNERS = [
  { x: 16, z: 16 }, { x: 16, z: -16 }, { x: -16, z: -16 }, { x: -16, z: 16 }
];
const PRISON_ROUTE = [
  { x: 0, z: -20 }, { x: 28, z: -28 }, { x: 56, z: -49 }, { x: 70, z: -56 }, { x: 56, z: -49 }, { x: 28, z: -28 }
];
const SE_ROUTE = [
  { x: 28, z: 28 }, { x: 56, z: 28 }, { x: 56, z: 56 }, { x: 28, z: 56 }
];

const ROSTER = [
  { id: 'robot_vox7', name: 'VOX-7', role: 'civilian', color: '#00f0c8', x: 4, z: 4, duty: 'patrol_square' },
  { id: 'robot_lumen', name: 'LUMEN', role: 'civilian', color: '#7df9ff', x: -6, z: 2, duty: 'wander' },
  { id: 'robot_byte', name: 'BAJT', role: 'civilian', color: '#ffd166', x: 10, z: -10, duty: 'patrol_square' },
  { id: 'robot_echo', name: 'ECHO', role: 'civilian', color: '#c084fc', x: -12, z: 12, duty: 'wander' },
  { id: 'robot_rdza', name: 'RDZA', role: 'civilian', color: '#ff8c42', x: 30, z: 30, duty: 'patrol_se' },
  { id: 'robot_neon', name: 'NEON', role: 'civilian', color: '#f472b6', x: -30, z: -30, duty: 'wander' },
  { id: 'robot_zlom', name: 'ZŁOM', role: 'civilian', color: '#9ca3af', x: -56, z: 0, duty: 'idle' },
  { id: 'robot_strag', name: 'STRAŻ-1', role: 'police', color: '#3b82f6', x: 70, z: -56, duty: 'guard_gate' },
  { id: 'robot_patrol', name: 'PATROL-2', role: 'police', color: '#2563eb', x: 0, z: -20, duty: 'patrol_prison' },
  { id: 'robot_orzel', name: 'ORZEŁ-3', role: 'police', color: '#60a5fa', x: 20, z: 0, duty: 'patrol_square' }
];

const WALL_DEFS = [
  { id: 'wall_p_s1', x: 58, z: -52, len: 12, h: 4, rot: 0 },
  { id: 'wall_p_s2', x: 82, z: -52, len: 12, h: 4, rot: 0 },
  { id: 'wall_p_n1', x: 58, z: -88, len: 12, h: 4, rot: 0 },
  { id: 'wall_p_n2', x: 70, z: -88, len: 12, h: 4, rot: 0 },
  { id: 'wall_p_n3', x: 82, z: -88, len: 12, h: 4, rot: 0 },
  { id: 'wall_p_w1', x: 52, z: -58, len: 12, h: 4, rot: Math.PI / 2 },
  { id: 'wall_p_w2', x: 52, z: -70, len: 12, h: 4, rot: Math.PI / 2 },
  { id: 'wall_p_w3', x: 52, z: -82, len: 12, h: 4, rot: Math.PI / 2 },
  { id: 'wall_p_e1', x: 88, z: -58, len: 12, h: 4, rot: Math.PI / 2 },
  { id: 'wall_p_e2', x: 88, z: -70, len: 12, h: 4, rot: Math.PI / 2 },
  { id: 'wall_p_e3', x: 88, z: -82, len: 12, h: 4, rot: Math.PI / 2 },
  { id: 'wall_sq_n', x: 0, z: -8, len: 8, h: 2, rot: 0 },
  { id: 'wall_sq_s', x: 0, z: 8, len: 8, h: 2, rot: 0 },
  { id: 'wall_sq_w', x: -8, z: 0, len: 8, h: 2, rot: Math.PI / 2 },
  { id: 'wall_sq_e', x: 8, z: 0, len: 8, h: 2, rot: Math.PI / 2 },
  { id: 'wall_st_1', x: 0, z: -42, len: 8, h: 2.5, rot: 0 },
  { id: 'wall_st_2', x: 0, z: 42, len: 8, h: 2.5, rot: 0 },
  { id: 'wall_st_3', x: -42, z: 0, len: 8, h: 2.5, rot: Math.PI / 2 },
  { id: 'wall_st_4', x: 42, z: 0, len: 8, h: 2.5, rot: Math.PI / 2 },
  { id: 'wall_st_5', x: 28, z: -42, len: 8, h: 2.5, rot: 0 },
  { id: 'wall_st_6', x: -28, z: 42, len: 8, h: 2.5, rot: 0 },
  { id: 'wall_st_7', x: 42, z: -28, len: 8, h: 2.5, rot: Math.PI / 2 },
  { id: 'wall_st_8', x: -42, z: 28, len: 8, h: 2.5, rot: Math.PI / 2 },
  { id: 'wall_st_9', x: 14, z: -70, len: 8, h: 2.5, rot: 0 },
  { id: 'wall_st_10', x: -70, z: 14, len: 8, h: 2.5, rot: Math.PI / 2 },
  { id: 'wall_st_11', x: 56, z: -42, len: 8, h: 2.5, rot: 0 },
  { id: 'wall_st_12', x: -42, z: 56, len: 8, h: 2.5, rot: Math.PI / 2 }
].concat(CELL_WALL_DEFS);

let renderer, scene, camera, dirLight;
let playerMesh;
let playerAvatar = null;
const robotMeshes = new Map();
const remoteMeshes = new Map();
const robotAvatars = new Map();
const remoteAvatars = new Map();
const ROBOT_H = 1.4;
const PLAYER_H = 1.5;
const REMOTE_ACCENT = 0x7df9ff;
let manipulatorInst = null;
const buildingBoxes = [];
const keys = new Set();
let camPitch = 0.15;
let pointerLocked = false;
let loopStarted = false;
let snapSeq = 0;
let lastSnapSeq = -1;
const cellOccupied = new Set();
let cellRR = 0;
let playerArrest = null;

const chatterRng = mulberry32(0xC4A77E5);
const chatter = { acc: 0, next: 45 + 0xC4A7 % 30, active: null };

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function el(id) { return document.getElementById(id); }
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function dist2(ax, az, bx, bz) { const dx = ax - bx, dz = az - bz; return dx * dx + dz * dz; }

// --- color name / selector resolution (fleet commands) ---------------------
const COLOR_PL = {
  red: 'czerwony', orange: 'pomarańczowy', yellow: 'żółty', green: 'zielony',
  teal: 'turkusowy', blue: 'niebieski', purple: 'fioletowy', pink: 'różowy',
  gray: 'szary', white: 'biały'
};
// selector words (PL + EN, with and without diacritics) -> canonical bucket.
const COLOR_WORDS = {
  czerwony: 'red', czerwoni: 'red', red: 'red',
  pomaranczowy: 'orange', 'pomarańczowy': 'orange', orange: 'orange',
  zolty: 'yellow', 'żółty': 'yellow', yellow: 'yellow',
  zielony: 'green', zieloni: 'green', zielonych: 'green', green: 'green', greens: 'green',
  turkusowy: 'teal', teal: 'teal', cyan: 'teal',
  niebieski: 'blue', niebiescy: 'blue', niebieskich: 'blue', blue: 'blue', blues: 'blue',
  fioletowy: 'purple', purple: 'purple',
  rozowy: 'pink', 'różowy': 'pink', pink: 'pink',
  szary: 'gray', gray: 'gray', grey: 'gray',
  bialy: 'white', 'biały': 'white', white: 'white'
};
// green and teal robots read as each other in casual speech ("złap zielonych").
const COLOR_EQUIV = { green: ['green', 'teal'], teal: ['teal', 'green'] };

function stripDia(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l');
}

function colorBucket(hex) {
  const c = new THREE.Color(hex);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  const h = hsl.h * 360;
  if (hsl.l > 0.9 && hsl.s < 0.2) return 'white';
  if (hsl.s < 0.18) return 'gray';
  if (h < 15 || h >= 345) return 'red';
  if (h < 40) return 'orange';
  if (h < 70) return 'yellow';
  if (h < 160) return 'green';
  if (h < 200) return 'teal';
  if (h < 255) return 'blue';
  if (h < 300) return 'purple';
  return 'pink';
}

export function colorNamePL(hex) { return COLOR_PL[colorBucket(hex)] || 'nieznany'; }

function roleIds(role) {
  const out = [];
  for (const r of state.robots.values()) if (r.role === role) out.push(r.id);
  return out;
}

// Resolve a fleet-command selector string to a list of robot ids. Empty selector
// falls back to the single robot being spoken to. Host-authoritative — clients
// never resolve locally, they forward the raw selector inside the intent.
export function resolveSelector(selector, speakerId) {
  const raw = (selector == null ? '' : String(selector)).trim().toLowerCase();
  if (!raw) return speakerId ? [speakerId] : [];
  if (raw === 'all' || raw === 'wszyscy' || raw === 'wszystkie' || raw === 'everyone') return [...state.robots.keys()];
  if (raw === 'police' || raw === 'policja' || raw === 'policjanci' || raw === 'straz' || raw === 'straż') return roleIds('police');
  if (raw === 'civilian' || raw === 'civilians' || raw === 'cywile' || raw === 'cywil' || raw === 'cywilni') return roleIds('civilian');
  const bucket = COLOR_WORDS[raw] || COLOR_WORDS[stripDia(raw)];
  if (bucket) {
    const accept = COLOR_EQUIV[bucket] || [bucket];
    const out = [];
    for (const r of state.robots.values()) if (accept.includes(colorBucket(r.color))) out.push(r.id);
    return out;
  }
  const names = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const nm of names) {
    for (const r of state.robots.values()) if (r.name.toLowerCase() === nm) out.push(r.id);
  }
  if (out.length) return [...new Set(out)];
  return speakerId ? [speakerId] : [];
}

function status(text, level) {
  bus.dispatchEvent(new CustomEvent('ui:status', { detail: { text, level: level || 'ok' } }));
}

function makeGroundTexture() {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 1024;
  const g = c.getContext('2d');
  g.fillStyle = '#101018';
  g.fillRect(0, 0, 1024, 1024);
  g.strokeStyle = '#1c1c26';
  g.lineWidth = 2;
  const cells = 11;
  const step = 1024 / cells;
  for (let i = 0; i <= cells; i++) {
    const p = Math.round(i * step) + 0.5;
    g.beginPath(); g.moveTo(p, 0); g.lineTo(p, 1024); g.stroke();
    g.beginPath(); g.moveTo(0, p); g.lineTo(1024, p); g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1, 1);
  return tex;
}

function buildScene() {
  const canvas = el('game-canvas');
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0a0f);
  scene.fog = new THREE.Fog(0x0a0a0f, 60, 170);

  camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.1, 400);
  camera.position.set(0, 6, 30);

  const hemi = new THREE.HemisphereLight(0x8899ff, 0x080820, 0.6);
  scene.add(hemi);

  dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
  dirLight.position.set(40, 70, 30);
  dirLight.castShadow = true;
  dirLight.shadow.mapSize.set(1024, 1024);
  dirLight.shadow.camera.near = 1;
  dirLight.shadow.camera.far = 220;
  dirLight.shadow.camera.left = -60;
  dirLight.shadow.camera.right = 60;
  dirLight.shadow.camera.top = 60;
  dirLight.shadow.camera.bottom = -60;
  scene.add(dirLight);
  scene.add(dirLight.target);

  const groundGeo = new THREE.PlaneGeometry(220, 220);
  const groundMat = new THREE.MeshStandardMaterial({ map: makeGroundTexture(), roughness: 1, metalness: 0 });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  buildCity();
  buildSquare();
  buildPrison();
  buildWalls();
  initNav();
  buildRobots();
  buildPlayer();
  initManipulator();
  updateCamera();
}

function buildCity() {
  const rng = mulberry32(20490);
  const centers = [-84, -56, -28, 0, 28, 56, 84];
  const omit = new Set([
    '-28,0', '0,-28', '0,0', '0,28', '28,0',
    '56,-56', '84,-56', '56,-84', '84,-84'
  ]);
  const items = [];
  for (const bx of centers) {
    for (const bz of centers) {
      if (omit.has(bx + ',' + bz)) continue;
      const n = 1 + Math.floor(rng() * 3);
      for (let i = 0; i < n; i++) {
        const w = 6 + rng() * 8;
        const d = 6 + rng() * 8;
        const edge = Math.max(Math.abs(bx), Math.abs(bz)) / 84;
        const h = 8 + rng() * 14 + edge * 18;
        const jx = bx + (rng() - 0.5) * (18 - w);
        const jz = bz + (rng() - 0.5) * (18 - d);
        const shade = 0.5 + rng() * 0.5;
        items.push({ x: jx, z: jz, w, d, h, shade });
        buildingBoxes.push({ minX: jx - w / 2, maxX: jx + w / 2, minZ: jz - d / 2, maxZ: jz + d / 2 });
      }
    }
  }

  const box = new THREE.BoxGeometry(1, 1, 1);
  const mat = new THREE.MeshStandardMaterial({ color: 0x1a1a22, roughness: 0.85, metalness: 0.1 });
  const mesh = new THREE.InstancedMesh(box, mat, items.length);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  const trimMat = new THREE.MeshBasicMaterial({ color: ACCENT });
  const trim = new THREE.InstancedMesh(box, trimMat, items.length);
  const m = new THREE.Matrix4();
  const col = new THREE.Color();
  for (let i = 0; i < items.length; i++) {
    const b = items[i];
    m.makeScale(b.w, b.h, b.d);
    m.setPosition(b.x, b.h / 2, b.z);
    mesh.setMatrixAt(i, m);
    col.setRGB(0.1 * b.shade, 0.1 * b.shade, 0.14 * b.shade);
    mesh.setColorAt(i, col);
    m.makeScale(b.w + 0.1, 0.25, b.d + 0.1);
    m.setPosition(b.x, b.h + 0.1, b.z);
    trim.setMatrixAt(i, m);
    if ((i % 5) === 0) col.setHex(ALERT); else col.setHex(ACCENT);
    trim.setColorAt(i, col);
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  trim.instanceMatrix.needsUpdate = true;
  if (trim.instanceColor) trim.instanceColor.needsUpdate = true;
  scene.add(mesh);
  scene.add(trim);
}

function buildSquare() {
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(48, 48),
    new THREE.MeshStandardMaterial({ color: 0x16161e, emissive: 0x05201c, roughness: 0.9 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = 0.02;
  floor.receiveShadow = true;
  scene.add(floor);

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(22.5, 24, 48),
    new THREE.MeshBasicMaterial({ color: ACCENT, side: THREE.DoubleSide })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.05;
  scene.add(ring);

  const obelisk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.25, 0.6, 3, 6),
    new THREE.MeshBasicMaterial({ color: ACCENT })
  );
  obelisk.position.set(0, 1.5, 0);
  scene.add(obelisk);
}

function buildPrison() {
  const mat = new THREE.MeshStandardMaterial({ color: 0x14141c, roughness: 1 });
  for (const px of [64, 76]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(1.2, 4.5, 1.2), mat);
    post.position.set(px, 2.25, -52);
    post.castShadow = true;
    scene.add(post);
  }
  const yard = new THREE.Mesh(
    new THREE.PlaneGeometry(36, 36),
    new THREE.MeshStandardMaterial({ color: 0x101016, roughness: 1 })
  );
  yard.rotation.x = -Math.PI / 2;
  yard.position.set(70, 0.015, -70);
  yard.receiveShadow = true;
  scene.add(yard);
}

function buildWalls() {
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x2a2a34, roughness: 0.8 });
  for (const def of WALL_DEFS) {
    const group = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(def.len, def.h, 1), bodyMat);
    body.castShadow = true;
    body.receiveShadow = true;
    group.add(body);
    const edge = new THREE.Mesh(
      new THREE.BoxGeometry(def.len, 0.12, 1.05),
      new THREE.MeshBasicMaterial({ color: ACCENT })
    );
    edge.position.y = def.h / 2;
    group.add(edge);
    group.position.set(def.x, def.h / 2, def.z);
    group.rotation.y = def.rot;
    scene.add(group);

    const along = def.rot === 0 ? { hx: def.len / 2, hz: 0.5 } : { hx: 0.5, hz: def.len / 2 };
    state.walls.set(def.id, {
      destroyed: false,
      mesh: group,
      box: { minX: def.x - along.hx, maxX: def.x + along.hx, minZ: def.z - along.hz, maxZ: def.z + along.hz }
    });
  }
}

function initNav() {
  // Bounds derived from the movement clamp (±WORLD_BOUND); obstacles come straight
  // from the collision data the world was built with — no duplicated geometry.
  nav.configure({ minX: -WORLD_BOUND, maxX: WORLD_BOUND, minZ: -WORLD_BOUND, maxZ: WORLD_BOUND, cell: NAV_CELL, inflate: 0.7 });
  for (const box of buildingBoxes) nav.addObstacle(box);
  for (const [id, w] of state.walls) nav.registerWall(id, w.box, w.destroyed);
}

function makeRobotMesh(color, police) {
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(color), roughness: 0.5, metalness: 0.3, emissive: new THREE.Color(color).multiplyScalar(0.15) });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.35, 0.8, 4, 8), mat);
  body.position.y = 0.85;
  body.castShadow = true;
  group.add(body);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.4, 0.5), mat);
  head.position.y = 1.55;
  head.castShadow = true;
  group.add(head);
  if (police) {
    const beacon = new THREE.Mesh(
      new THREE.BoxGeometry(0.18, 0.18, 0.18),
      new THREE.MeshBasicMaterial({ color: ALERT })
    );
    beacon.position.y = 1.85;
    group.add(beacon);
  }
  return group;
}

function buildRobots() {
  for (const def of ROSTER) {
    const police = def.role === 'police';
    let duty = { fsm: 'IDLE', waypoints: null, target: null };
    if (def.duty === 'patrol_square') duty = { fsm: 'PATROL', waypoints: SQUARE_CORNERS.slice(), target: null };
    else if (def.duty === 'patrol_se') duty = { fsm: 'PATROL', waypoints: SE_ROUTE.slice(), target: null };
    else if (def.duty === 'patrol_prison') duty = { fsm: 'PATROL', waypoints: PRISON_ROUTE.slice(), target: null };
    else if (def.duty === 'wander') duty = { fsm: 'WANDER', waypoints: null, target: null };
    else if (def.duty === 'guard_gate') duty = { fsm: 'GUARD', waypoints: null, target: { x: def.x, z: def.z } };

    const r = {
      id: def.id, name: def.name, role: def.role, color: def.color,
      spawn: { x: def.x, z: def.z },
      p: { x: def.x, z: def.z }, ry: 0,
      speed: police ? 4.5 : 3.5,
      fsm: duty.fsm, target: duty.target, waypoints: duty.waypoints, wpIndex: 0,
      followId: null, escortId: null, escortWps: null, escortIndex: 0, captorId: null, cellIndex: -1,
      chatFaceId: null, chatAnim: null,
      inventory: [], memory: [], currentAction: 'idle',
      stateTimer: 0, scanTimer: 0, danceT: 0,
      dutyFsm: duty.fsm, dutyWaypoints: duty.waypoints, dutyTarget: duty.target,
      targetP: { x: def.x, z: def.z }, targetRy: 0, anim: 'idle', heldY: 0,
      navPath: null, navIndex: 0, navDest: null, navArrived: false,
      replanAcc: Math.random() * REPLAN_INTERVAL, stuckAcc: 0,
      stuckX: def.x, stuckZ: def.z, replanFails: 0
    };
    state.robots.set(def.id, r);
    const mesh = makeRobotMesh(def.color, police);
    mesh.position.set(def.x, 0, def.z);
    scene.add(mesh);
    robotMeshes.set(def.id, mesh);
  }
}

function buildPlayer() {
  playerMesh = makeRobotMesh('#e8e8ec', false);
  playerMesh.position.set(state.player.p.x, 0, state.player.p.z);
  scene.add(playerMesh);
}

function spawnRemoteAvatar(id, name) {
  if (remoteMeshes.has(id)) return;
  const mesh = makeRobotMesh('#00f0c8', false);
  scene.add(mesh);
  remoteMeshes.set(id, mesh);
  const i = remoteMeshes.size;
  const rp = {
    name: name || id,
    p: { x: (i % 2 ? 3 : -3), y: 0, z: 20 - i * 2 },
    ry: Math.PI, anim: 'idle',
    targetP: { x: (i % 2 ? 3 : -3), y: 0, z: 20 - i * 2 }, targetRy: Math.PI
  };
  state.remotePlayers.set(id, rp);
  if (avatars.isReady()) attachRemoteAvatar(id, rp);
}

function removeRemoteAvatar(id) {
  const mesh = remoteMeshes.get(id);
  if (mesh) { scene.remove(mesh); remoteMeshes.delete(id); }
  remoteAvatars.delete(id);
  state.remotePlayers.delete(id);
}

function swapMesh(map, id, group, oldMesh) {
  if (oldMesh) scene.remove(oldMesh);
  scene.add(group);
  map.set(id, group);
}

function attachRobotAvatar(r) {
  const av = avatars.createAvatar({ color: r.color, height: ROBOT_H });
  if (!av) return;
  av.group.position.set(r.p.x, 0, r.p.z);
  av.group.rotation.y = r.ry;
  swapMesh(robotMeshes, r.id, av.group, robotMeshes.get(r.id));
  robotAvatars.set(r.id, av);
  av.setAnim(r.anim);
}

function attachPlayerAvatar() {
  const av = avatars.createAvatar({ color: '#e8e8ec', accent: ACCENT, height: PLAYER_H });
  if (!av) return;
  av.group.position.set(state.player.p.x, 0, state.player.p.z);
  av.group.rotation.y = state.player.ry;
  if (playerMesh) scene.remove(playerMesh);
  scene.add(av.group);
  playerMesh = av.group;
  playerAvatar = av;
  av.setAnim(state.player.anim);
}

function attachRemoteAvatar(id, rp) {
  const av = avatars.createAvatar({ color: '#00f0c8', accent: REMOTE_ACCENT, height: PLAYER_H });
  if (!av) return;
  av.group.position.set(rp.p.x, 0, rp.p.z);
  av.group.rotation.y = rp.ry;
  swapMesh(remoteMeshes, id, av.group, remoteMeshes.get(id));
  remoteAvatars.set(id, av);
  av.setAnim(rp.anim);
}

async function initAvatars() {
  const proto = await avatars.loadAvatarPrototype('./assets/models/robot2.glb');
  if (!proto) return;
  for (const r of state.robots.values()) attachRobotAvatar(r);
  attachPlayerAvatar();
  for (const [id, rp] of state.remotePlayers) attachRemoteAvatar(id, rp);
}

function updateMixers(dt) {
  if (playerAvatar) playerAvatar.update(dt);
  for (const av of robotAvatars.values()) av.update(dt);
  for (const av of remoteAvatars.values()) av.update(dt);
}

function collideMove(oldX, oldZ, dx, dz, r) {
  let x = oldX + dx;
  const z0 = oldZ;
  const hit = (bx, bz, box) => bx > box.minX - r && bx < box.maxX + r && bz > box.minZ - r && bz < box.maxZ + r;
  for (const box of buildingBoxes) {
    if (hit(x, z0, box)) x = dx > 0 ? box.minX - r : dx < 0 ? box.maxX + r : x;
  }
  for (const w of state.walls.values()) {
    if (w.destroyed) continue;
    if (hit(x, z0, w.box)) x = dx > 0 ? w.box.minX - r : dx < 0 ? w.box.maxX + r : x;
  }
  let z = oldZ + dz;
  for (const box of buildingBoxes) {
    if (hit(x, z, box)) z = dz > 0 ? box.minZ - r : dz < 0 ? box.maxZ + r : z;
  }
  for (const w of state.walls.values()) {
    if (w.destroyed) continue;
    if (hit(x, z, w.box)) z = dz > 0 ? w.box.minZ - r : dz < 0 ? w.box.maxZ + r : z;
  }
  return { x: clamp(x, -100, 100), z: clamp(z, -100, 100) };
}

function updatePlayer() {
  const p = state.player;
  if (p.arrested) { p.anim = 'idle'; syncPlayerMesh(); return; }
  const fwdX = Math.sin(p.ry), fwdZ = Math.cos(p.ry);
  const rightX = -Math.cos(p.ry), rightZ = Math.sin(p.ry);
  let mx = 0, mz = 0;
  if (keys.has('KeyW')) { mx += fwdX; mz += fwdZ; }
  if (keys.has('KeyS')) { mx -= fwdX; mz -= fwdZ; }
  if (keys.has('KeyD')) { mx += rightX; mz += rightZ; }
  if (keys.has('KeyA')) { mx -= rightX; mz -= rightZ; }
  const len = Math.hypot(mx, mz);
  if (len > 0.0001) {
    const run = keys.has('ShiftLeft') || keys.has('ShiftRight');
    const speed = run ? 9 : 6;
    mx = (mx / len) * speed * STEP;
    mz = (mz / len) * speed * STEP;
    const np = collideMove(p.p.x, p.p.z, mx, mz, 0.5);
    p.p.x = np.x; p.p.z = np.z;
    p.anim = run ? 'run' : 'walk';
  } else {
    p.anim = 'idle';
  }
  syncPlayerMesh();
}

function syncPlayerMesh() {
  playerMesh.position.set(state.player.p.x, 0, state.player.p.z);
  playerMesh.rotation.y = state.player.ry;
  if (playerAvatar) playerAvatar.setAnim(state.player.anim);
}

function seek(ent, tx, tz, speed) {
  const dx = tx - ent.p.x, dz = tz - ent.p.z;
  const d = Math.hypot(dx, dz);
  if (d < 0.001) return 0;
  ent.ry = Math.atan2(dx, dz);
  if (d <= SEEK_ARRIVE) return d;
  const step = Math.min(speed * STEP, d);
  const np = collideMove(ent.p.x, ent.p.z, (dx / d) * step, (dz / d) * step, 0.4);
  ent.p.x = np.x; ent.p.z = np.z;
  return d;
}

function clearPath(r) {
  r.navPath = null; r.navIndex = 0; r.navDest = null; r.navArrived = false;
  r.replanFails = 0; r.stuckAcc = 0; r.stuckX = r.p.x; r.stuckZ = r.p.z;
}

// Path-following mover: plans/replans a route to (destX,destZ) with nav, follows
// the waypoints via seek(), and returns straight-line distance to the true dest so
// callers keep their own arrival thresholds. Sets r.navArrived when the robot has
// reached the closest reachable point (final waypoint). Replans are staggered by a
// global per-step budget and driven by SIM time so debugStep stays deterministic.
function robotFollow(r, destX, destZ, speed) {
  r.navArrived = false;

  r.stuckAcc += STEP;
  if (r.stuckAcc >= STUCK_TIME) {
    const moved = dist2(r.stuckX, r.stuckZ, r.p.x, r.p.z) >= STUCK_DIST2;
    if (!moved && r.navPath) r.navPath = null; // barely moved: force a replan
    if (moved) r.replanFails = 0;              // actually moved: not trapped
    r.stuckX = r.p.x; r.stuckZ = r.p.z; r.stuckAcc = 0;
  }

  r.replanAcc += STEP;
  let need = false;
  if (!r.navPath || r.navIndex >= r.navPath.length) need = true;
  else if (!r.navDest || dist2(r.navDest.x, r.navDest.z, destX, destZ) > REPLAN_MOVE2) need = true;
  else if (r.replanAcc >= REPLAN_INTERVAL) need = true;

  if (need && replanBudget > 0) {
    replanBudget--;
    r.replanAcc = 0;
    let path = nav.findPath(r.p.x, r.p.z, destX, destZ);
    if (path) {
      r.replanFails = 0;
    } else {
      r.replanFails++;
      if (r.replanFails >= MAX_REPLAN_FAILS) {
        const fb = nav.progressToward(r.p.x, r.p.z, destX, destZ);
        path = fb ? [fb] : null;
      }
    }
    r.navPath = path;
    r.navIndex = 0;
    r.navDest = { x: destX, z: destZ };
  }

  let wpx = destX, wpz = destZ;
  if (r.navPath && r.navIndex < r.navPath.length) {
    while (r.navIndex < r.navPath.length - 1 &&
      dist2(r.p.x, r.p.z, r.navPath[r.navIndex].x, r.navPath[r.navIndex].z) <= WAYPOINT_ARRIVE2) {
      r.navIndex++;
    }
    const wp = r.navPath[r.navIndex];
    const atLast = r.navIndex === r.navPath.length - 1;
    if (atLast && dist2(r.p.x, r.p.z, wp.x, wp.z) <= WAYPOINT_ARRIVE2) {
      r.navArrived = true;
      wpx = destX; wpz = destZ;
    } else {
      wpx = wp.x; wpz = wp.z;
    }
  }

  seek(r, wpx, wpz, speed);
  return Math.hypot(destX - r.p.x, destZ - r.p.z);
}

function entityPos(id) {
  if (id === state.playerId || id === 'solo') return { x: state.player.p.x, z: state.player.p.z };
  const rp = state.remotePlayers.get(id);
  if (rp) return { x: rp.p.x, z: rp.p.z };
  const r = state.robots.get(id);
  if (r) return { x: r.p.x, z: r.p.z };
  return null;
}

function nameToEntity(lowerName) {
  if (state.playerName.toLowerCase() === lowerName) return { kind: 'player', id: state.playerId || 'solo', p: state.player.p };
  for (const [id, rp] of state.remotePlayers) {
    if ((rp.name || '').toLowerCase() === lowerName) return { kind: 'player', id, p: rp.p };
  }
  for (const r of state.robots.values()) {
    if (r.name.toLowerCase() === lowerName) return { kind: 'robot', id: r.id, p: r.p };
  }
  return null;
}

function assignCell() {
  for (let i = 0; i < CELLS.length; i++) {
    if (!cellOccupied.has(i)) { cellOccupied.add(i); return i; }
  }
  const i = cellRR % CELLS.length;
  cellRR++;
  return i;
}

// Nearest free cell mouth for the Manipulator to drop a robot into. Null = full.
function pickDropCellMouth() {
  let best = null, bestD = Infinity;
  for (const c of CELLS) {
    if (cellOccupied.has(c.index)) continue;
    const d = dist2(GATE_WP.x, GATE_WP.z, c.mouth.x, c.mouth.z);
    if (d < bestD) { bestD = d; best = c; }
  }
  return best ? { x: best.mouth.x, z: best.mouth.z, index: best.index } : null;
}

function jailRobotInCell(r, cellIndex, memoryEntry) {
  cellOccupied.add(cellIndex);
  r.cellIndex = cellIndex;
  r.captorId = null; r.heldY = 0;
  r.fsm = 'JAILED';
  clearPath(r);
  setAction(r, 'jailed', memoryEntry || ('Locked in cell ' + (cellIndex + 1)));
}

function freeJailed(r, memoryEntry) {
  if (r.cellIndex >= 0) cellOccupied.delete(r.cellIndex);
  r.cellIndex = -1; r.heldY = 0;
  r.fsm = 'WANDER';
  pickWander(r);
  setAction(r, 'on the loose', memoryEntry || 'Left the cell');
}

function freePrisonersOfCell(cellIndex) {
  for (const r of state.robots.values()) {
    if (r.fsm === 'JAILED' && r.cellIndex === cellIndex) freeJailed(r, 'Escaped through a broken cell wall');
  }
}

function resumeDuty(r) {
  r.fsm = r.dutyFsm;
  r.waypoints = r.dutyWaypoints ? r.dutyWaypoints.slice() : null;
  r.target = r.dutyTarget;
  r.wpIndex = 0;
  r.followId = null;
  clearPath(r);
  setAction(r, 'on duty');
}

function setConversation(active, robotId) {
  if (state.mode !== 'host' && state.mode !== 'solo') return;
  const r = state.robots.get(robotId);
  if (!r) return;
  if (active) {
    if (r.fsm === 'CONVERSING' || r.fsm === 'ESCORT' || r.fsm === 'CARRIED' ||
        r.fsm === 'JAILED' || r.fsm === 'CHASE' || r.fsm === 'HELD') return;
    r.prevFsm = r.fsm;
    r.prevTarget = r.target;
    r.prevWaypoints = r.waypoints;
    r.prevWpIndex = r.wpIndex;
    r.fsm = 'CONVERSING';
    r.anim = 'idle';
  } else {
    if (r.fsm !== 'CONVERSING') return;
    r.chatFaceId = null;
    r.chatAnim = null;
    if (r.prevFsm && r.prevFsm !== 'CONVERSING') {
      r.fsm = r.prevFsm;
      r.target = r.prevTarget;
      r.waypoints = r.prevWaypoints;
      r.wpIndex = r.prevWpIndex || 0;
    } else {
      r.fsm = 'WANDER';
      pickWander(r);
    }
    r.prevFsm = null;
  }
}

function appendRobotReply(robotId, text) {
  if (state.mode !== 'host' && state.mode !== 'solo') return;
  const r = state.robots.get(robotId);
  if (!r) return;
  const entry = 'Said: ' + text;
  r.memory.push(entry);
  if (r.memory.length > 20) r.memory = r.memory.slice(-20);
  database.saveRobotAction(r.id, r.currentAction, entry);
}

function setAction(r, action, memoryEntry) {
  r.currentAction = action;
  if (state.mode === 'host' || state.mode === 'solo') {
    if (memoryEntry) { r.memory.push(memoryEntry); if (r.memory.length > 20) r.memory = r.memory.slice(-20); }
    database.saveRobotAction(r.id, action, memoryEntry || null);
  }
}

function updateRobot(r) {
  r.stateTimer += STEP;
  const police = r.role === 'police';
  if (police && r.fsm !== 'CHASE' && r.fsm !== 'ESCORT' && r.fsm !== 'CONVERSING' && r.fsm !== 'CARRIED' && r.fsm !== 'JAILED' && r.fsm !== 'HELD') {
    r.scanTimer += STEP;
    if (r.scanTimer >= 2) {
      r.scanTimer = 0;
      const found = policeScan(r);
      if (found) {
        r.fsm = 'CHASE'; r.followId = found.id;
        setAction(r, 'chasing ' + found.name);
      }
    }
  }

  switch (r.fsm) {
    case 'IDLE': {
      if (r.stateTimer > 8 + (r.id.length % 7)) {
        r.stateTimer = 0;
        if (police) resumeDuty(r);
        else { r.fsm = 'WANDER'; pickWander(r); }
      }
      r.anim = 'idle';
      break;
    }
    case 'WANDER': {
      if (!r.target) pickWander(r);
      const d = robotFollow(r, r.target.x, r.target.z, r.speed);
      r.anim = 'walk';
      if (d <= SEEK_ARRIVE || r.navArrived) { r.fsm = 'IDLE'; r.stateTimer = 0; r.target = null; r.anim = 'idle'; clearPath(r); }
      break;
    }
    case 'PATROL': {
      if (!r.waypoints || r.waypoints.length === 0) { r.fsm = 'IDLE'; break; }
      const wp = r.waypoints[r.wpIndex % r.waypoints.length];
      const d = robotFollow(r, wp.x, wp.z, r.speed);
      r.anim = 'walk';
      if (d <= SEEK_ARRIVE || r.navArrived) { r.wpIndex = (r.wpIndex + 1) % r.waypoints.length; clearPath(r); }
      break;
    }
    case 'MOVE_TO': {
      if (!r.target) { r.fsm = 'IDLE'; break; }
      const d = robotFollow(r, r.target.x, r.target.z, r.speed);
      r.anim = 'walk';
      if (d <= SEEK_ARRIVE || r.navArrived) { r.fsm = 'IDLE'; r.stateTimer = 0; r.target = null; r.anim = 'idle'; clearPath(r); }
      break;
    }
    case 'FOLLOW': {
      const tp = entityPos(r.followId);
      if (!tp) { r.fsm = 'IDLE'; break; }
      const dx = tp.x - r.p.x, dz = tp.z - r.p.z;
      const d = Math.hypot(dx, dz);
      if (d > 2.7) { robotFollow(r, tp.x, tp.z, r.speed); r.anim = 'walk'; }
      else { r.ry = Math.atan2(dx, dz); r.anim = 'idle'; clearPath(r); }
      break;
    }
    case 'GUARD': {
      const gx = r.target ? r.target.x : r.spawn.x, gz = r.target ? r.target.z : r.spawn.z;
      if (Math.hypot(gx - r.p.x, gz - r.p.z) > SEEK_ARRIVE) {
        robotFollow(r, gx, gz, r.speed);
      } else {
        if (r.target) r.ry = Math.atan2((r.target.x - r.p.x) || 0.001, (r.target.z - r.p.z));
        if (r.navPath) clearPath(r);
      }
      r.anim = 'idle';
      break;
    }
    case 'DANCE': {
      r.danceT += STEP;
      r.ry = Math.sin(r.danceT * 6) * 1.2;
      r.anim = 'dance';
      if (r.danceT > 10) { r.danceT = 0; resumeDuty(r); }
      break;
    }
    case 'WORK_WALL': {
      const w = state.walls.get(r.target && r.target.wallId);
      if (!w) { r.fsm = 'IDLE'; break; }
      const wcx = (w.box.minX + w.box.maxX) / 2, wcz = (w.box.minZ + w.box.maxZ) / 2;
      robotFollow(r, wcx, wcz, r.speed);
      // Arrival = distance to the wall BOX, not its center — the wall's own
      // collision body stops the robot before it can ever reach the center.
      const nx = clamp(r.p.x, w.box.minX, w.box.maxX), nz = clamp(r.p.z, w.box.minZ, w.box.maxZ);
      const d = Math.hypot(nx - r.p.x, nz - r.p.z);
      r.anim = 'walk';
      if (d <= 2) {
        r.anim = 'idle';
        r.stateTimer += STEP;
        if (r.stateTimer >= 1.5) {
          applyWorldEvent('wall', { wallId: r.target.wallId, destroyed: r.target.destroyed });
          setAction(r, (r.target.destroyed ? 'destroyed ' : 'repaired ') + r.target.wallId,
            (r.target.destroyed ? 'Destroyed ' : 'Repaired ') + r.target.wallId);
          r.fsm = 'IDLE'; r.stateTimer = 0; r.target = null; clearPath(r);
        }
      }
      break;
    }
    case 'CHASE': {
      // Bail if the quarry got grabbed by the Manipulator, carried off by another
      // officer, or already jailed — fighting those states for the FSM breaks them.
      const followed = state.robots.get(r.followId);
      if (followed && (followed.fsm === 'HELD' || followed.fsm === 'CARRIED' || followed.fsm === 'JAILED')) {
        r.fsm = 'IDLE'; r.followId = null; clearPath(r); break;
      }
      const tp = entityPos(r.followId);
      if (!tp) { r.fsm = 'IDLE'; r.followId = null; clearPath(r); break; }
      const d = robotFollow(r, tp.x, tp.z, r.speed);
      r.anim = 'run';
      if (d <= 2.5) { doArrest(r, r.followId); clearPath(r); }
      break;
    }
    case 'ESCORT': {
      escortStep(r);
      break;
    }
    case 'CARRIED': {
      // Hard-attached to the captor: lifted, held out front, no ground shuffle.
      const cap = state.robots.get(r.captorId);
      if (!cap || cap.fsm !== 'ESCORT') { r.captorId = null; r.heldY = 0; r.fsm = 'WANDER'; pickWander(r); break; }
      const fx = Math.sin(cap.ry), fz = Math.cos(cap.ry);
      r.p.x = cap.p.x + fx * 0.9;
      r.p.z = cap.p.z + fz * 0.9;
      r.heldY = 0.6;
      r.ry = cap.ry;
      r.anim = 'sitting';
      break;
    }
    case 'JAILED': {
      const cell = CELLS[r.cellIndex];
      if (!cell) { r.fsm = 'WANDER'; pickWander(r); break; }
      const d = robotFollow(r, cell.sit.x, cell.sit.z, r.speed);
      if (d <= SEEK_ARRIVE || r.navArrived) {
        r.p.x = cell.sit.x; r.p.z = cell.sit.z; r.ry = 0; r.anim = 'sitting'; clearPath(r);
      } else {
        r.anim = 'walk';
      }
      break;
    }
    case 'CONVERSING': {
      let tx = state.player.p.x, tz = state.player.p.z;
      if (r.chatFaceId) { const o = state.robots.get(r.chatFaceId); if (o) { tx = o.p.x; tz = o.p.z; } }
      r.ry = Math.atan2(tx - r.p.x, tz - r.p.z);
      r.anim = r.chatAnim || 'idle';
      break;
    }
    case 'HELD': {
      // Driven by the Manipulator (position + heldY set from manipulator.step).
      r.anim = 'arrested';
      break;
    }
    default: r.anim = 'idle';
  }
  syncRobotMesh(r);
}

function pickWander(r) {
  for (let i = 0; i < 6; i++) {
    const a = Math.random() * Math.PI * 2;
    const rad = 3 + Math.random() * 12;
    const x = clamp(r.spawn.x + Math.cos(a) * rad, -WORLD_BOUND, WORLD_BOUND);
    const z = clamp(r.spawn.z + Math.sin(a) * rad, -WORLD_BOUND, WORLD_BOUND);
    if (nav.isWalkable(x, z)) { r.target = { x, z }; clearPath(r); return; }
  }
  r.target = { x: r.spawn.x, z: r.spawn.z };
  clearPath(r);
}

function policeScan(r) {
  if (state.wanted.length === 0) return null;
  let best = null, bestD = 40 * 40;
  const check = (name, id, px, pz) => {
    if (!state.wanted.includes(name.toLowerCase())) return;
    const d = dist2(r.p.x, r.p.z, px, pz);
    if (d < bestD) { bestD = d; best = { id, name }; }
  };
  if (state.playerName) check(state.playerName, state.playerId || 'solo', state.player.p.x, state.player.p.z);
  for (const [id, rp] of state.remotePlayers) check(rp.name || id, id, rp.p.x, rp.p.z);
  for (const t of state.robots.values()) {
    if (t.id === r.id) continue;
    // Skip robots that are already grabbed, being carried, or jailed — sending
    // police after them fights the state that already has them.
    if (t.fsm === 'HELD' || t.fsm === 'CARRIED' || t.fsm === 'JAILED') continue;
    check(t.name, t.id, t.p.x, t.p.z);
  }
  return best;
}

function doArrest(officer, targetId) {
  const cell = assignCell();
  officer.cellIndex = cell;
  officer.escortWps = [GATE_WP, CELLS[cell].mouth];
  officer.escortIndex = 0;
  officer.fsm = 'ESCORT';
  clearPath(officer);
  const tRobot = state.robots.get(targetId);
  if (tRobot) {
    tRobot.fsm = 'CARRIED';
    tRobot.captorId = officer.id;
    tRobot.heldY = 0.6;
    clearPath(tRobot);
    officer.escortId = targetId;
    setAction(officer, 'escorting ' + tRobot.name + ' to prison', 'Arrested ' + tRobot.name);
  } else {
    const ent = state.remotePlayers.get(targetId);
    const targetName = targetId === (state.playerId || 'solo') ? state.playerName : (ent ? ent.name : targetId);
    officer.escortId = 'player:' + targetId;
    applyWorldEvent('arrest', { targetName, byPlayerId: targetId, byRobotId: officer.id });
    setAction(officer, 'escorting ' + targetName + ' to prison', 'Arrested ' + targetName);
  }
}

function escortStep(officer) {
  const wp = officer.escortWps[officer.escortIndex];
  const d = robotFollow(officer, wp.x, wp.z, officer.speed);
  officer.anim = 'walk';
  const prisonerId = officer.escortId && officer.escortId.startsWith('player:') ? officer.escortId.slice(7) : null;
  if (prisonerId) dragPlayer(prisonerId, officer);
  if (d <= SEEK_ARRIVE || officer.navArrived) {
    if (officer.escortIndex < officer.escortWps.length - 1) {
      officer.escortIndex++;
      clearPath(officer);
    } else {
      clearPath(officer);
      finishEscort(officer, prisonerId);
    }
  }
}

function dragPlayer(playerId, officer) {
  const behindX = officer.p.x - Math.sin(officer.ry) * 2.5;
  const behindZ = officer.p.z - Math.cos(officer.ry) * 2.5;
  if (playerId === (state.playerId || 'solo')) {
    state.player.p.x = behindX; state.player.p.z = behindZ;
    syncPlayerMesh();
  } else {
    const rp = state.remotePlayers.get(playerId);
    if (rp) { rp.p.x = behindX; rp.p.z = behindZ; rp.targetP.x = behindX; rp.targetP.z = behindZ; }
  }
}

function finishEscort(officer, prisonerId) {
  const cellIndex = officer.cellIndex;
  let keepCell = false;
  if (officer.escortId && !prisonerId) {
    const prisoner = state.robots.get(officer.escortId);
    if (prisoner) {
      jailRobotInCell(prisoner, cellIndex, 'Locked in a cell by ' + officer.name);
      keepCell = true; // ownership of the reserved cell transfers to the prisoner
      setAction(officer, 'on duty', 'Escorted ' + prisoner.name + ' to prison');
    }
  } else if (prisonerId) {
    if (playerArrest && playerArrest.playerId === prisonerId) {
      playerArrest.phase = 'jailed';
      playerArrest.timer = 20;
      playerArrest.cell = CELLS[cellIndex] ? CELLS[cellIndex].sit : GATE_WP;
    }
    setAction(officer, 'on duty', 'Jailed a suspect');
  }
  if (!keepCell && cellIndex >= 0) cellOccupied.delete(cellIndex);
  officer.escortId = null; officer.escortWps = null; officer.cellIndex = -1;
  resumeDuty(officer);
}

// --- Manipulator hooks -----------------------------------------------------
// The prison-gate arm can hijack a prisoner mid-escort. Free the officer's reserved
// cell and hand it straight back to its patrol/guard duty (mirrors finishEscort cleanup).
function handOffEscort(officer) {
  if (officer.cellIndex >= 0) cellOccupied.delete(officer.cellIndex);
  officer.escortId = null; officer.escortWps = null; officer.cellIndex = -1;
  officer.captorId = null;
  resumeDuty(officer);
}

// Drop a grabbed robot into the prison yard on a walkable cell: it becomes a free
// prisoner (re-homed spawn, wanders the yard) and its wanted status clears.
// Clear a robot's wanted status via the synced world-event (used when the
// Manipulator grabs it, so police stop targeting the pinned robot immediately).
function clearWanted(r) {
  const list = state.wanted.filter((n) => n !== r.name.toLowerCase());
  if (list.length !== state.wanted.length) applyWorldEvent('wanted', { list });
}

function jailRobotInYard(r, cell) {
  r.spawn = { x: cell.x, z: cell.z };
  r.p.x = cell.x; r.p.z = cell.z; r.heldY = 0;
  r.captorId = null;
  r.fsm = 'WANDER';
  pickWander(r);
  const list = state.wanted.filter((n) => n !== r.name.toLowerCase());
  if (list.length !== state.wanted.length) applyWorldEvent('wanted', { list });
  setAction(r, 'on duty', 'Thrown into the yard by the Manipulator');
}

function initManipulator() {
  manipulatorInst = manipulator.init({
    scene,
    state,
    nav,
    base: { x: 73, z: -48 },
    gate: { x: GATE_WP.x, z: GATE_WP.z },
    palette: { body: 0x2a2a34, metal: 0x14141c, joint: 0x3a3a46, accent: ACCENT, alert: ALERT },
    hooks: {
      setAction, handOffEscort, jailRobotInYard, syncRobotMesh, clearWanted,
      pickDropCell: pickDropCellMouth,
      jailRobotInCell: (r, idx) => jailRobotInCell(r, idx, 'Dropped into a cell by the Manipulator')
    }
  });
}

function syncRobotMesh(r) {
  const mesh = robotMeshes.get(r.id);
  if (!mesh) return;
  const y = (r.heldY && r.heldY > 0) ? r.heldY : (r.fsm === 'DANCE' ? Math.abs(Math.sin(r.danceT * 6)) * 0.3 : 0);
  mesh.position.set(r.p.x, y, r.p.z);
  mesh.rotation.y = r.ry;
  const av = robotAvatars.get(r.id);
  if (av) av.setAnim(r.anim);
}

function updatePlayerArrest() {
  if (!playerArrest) return;
  if (playerArrest.phase === 'jailed') {
    playerArrest.timer -= STEP;
    const secs = Math.max(0, Math.ceil(playerArrest.timer));
    status('ARESZTOWANY — zwolnienie za ' + secs + 's', 'err');
    if (playerArrest.timer <= 0) {
      const pid = playerArrest.playerId;
      const name = pid === (state.playerId || 'solo') ? state.playerName : (state.remotePlayers.get(pid) || {}).name;
      applyWorldEvent('release', { targetName: (name || '').toLowerCase(), playerId: pid });
      const list = state.wanted.filter((n) => n !== (name || '').toLowerCase());
      applyWorldEvent('wanted', { list });
      if (pid === (state.playerId || 'solo')) {
        state.player.p.x = 70; state.player.p.z = -50; state.player.arrested = false;
        syncPlayerMesh();
      }
      status('Zwolniony', 'ok');
      playerArrest = null;
    }
  }
}

// --- F1: ambient robot-to-robot chatter ------------------------------------
const CHATTER_ELIGIBLE = new Set(['IDLE', 'WANDER', 'PATROL']);

function chatterEligible(r) { return CHATTER_ELIGIBLE.has(r.fsm); }

function pickChatterPair() {
  if (ai.isConversationActive && ai.isConversationActive()) return null;
  const p = state.player.p;
  const near = [];
  for (const r of state.robots.values()) {
    if (!chatterEligible(r)) continue;
    if (dist2(r.p.x, r.p.z, p.x, p.z) > 35 * 35) continue;
    near.push(r);
  }
  for (let i = 0; i < near.length; i++) {
    for (let j = i + 1; j < near.length; j++) {
      if (dist2(near[i].p.x, near[i].p.z, near[j].p.x, near[j].p.z) <= 10 * 10) return [near[i], near[j]];
    }
  }
  return null;
}

function freezeForChatter(r, faceId) {
  if (r.fsm === 'CONVERSING') return;
  r.prevFsm = r.fsm;
  r.prevTarget = r.target;
  r.prevWaypoints = r.waypoints;
  r.prevWpIndex = r.wpIndex;
  r.fsm = 'CONVERSING';
  r.chatFaceId = faceId;
  r.chatAnim = 'idle';
  r.anim = 'idle';
  clearPath(r);
}

function chatterMemoryContext(r) {
  const mem = r.memory.slice(-4);
  return mem.length ? mem.join(' | ') : 'nothing notable';
}

function buildChatterPayload(a, b) {
  return {
    a: { id: a.id, name: a.name, role: a.role, action: a.currentAction, memory: chatterMemoryContext(a) },
    b: { id: b.id, name: b.name, role: b.role, action: b.currentAction, memory: chatterMemoryContext(b) },
    wanted: state.wanted.slice()
  };
}

function cannedChatter(a, b) {
  const wanted = state.wanted.length ? state.wanted.map((n) => n.toUpperCase()).join(', ') : null;
  const pools = wanted ? [
    [{ r: a, t: 'Słyszałeś? ' + wanted + ' na liście gończej.' }, { r: b, t: 'Trzymam się od tego z daleka.' }],
    [{ r: a, t: 'Patrole ostre dzisiaj przez tych poszukiwanych.' }, { r: b, t: 'Byle nie skończyć w celi.' }],
    [{ r: b, t: 'Widziałeś kogoś z listy?' }, { r: a, t: 'Na razie spokój, ale czujność się przydaje.' }]
  ] : [
    [{ r: a, t: 'Znowu ten neonowy zmierzch nad Gzowem.' }, { r: b, t: 'Nigdy się nie znudzi, przyznaję.' }],
    [{ r: b, t: 'Bateria trzyma? Mnie spada za szybko.' }, { r: a, t: 'Dolej sobie na stacji przy rynku.' }],
    [{ r: a, t: 'Cisza dziś na ulicach.' }, { r: b, t: 'Lubię takie zmiany, bez nerwów.' }],
    [{ r: b, t: 'Ten Manipulator znów kogoś złapał.' }, { r: a, t: 'Lepiej nie podchodzić za blisko bramy.' }]
  ];
  const pick = pools[Math.floor(chatterRng() * pools.length)] || pools[0];
  return pick.map((ln) => ({ robotId: ln.r.id, name: ln.r.name, line: ln.t }));
}

function startChatter(pair) {
  const [a, b] = pair;
  const session = { a: a.id, b: b.id, lines: null, idx: -1, timer: 0, holdFor: 3, phase: 'load' };
  chatter.active = session;
  freezeForChatter(a, b.id);
  freezeForChatter(b, a.id);
  const payload = buildChatterPayload(a, b);
  const gen = ai.generateChatter ? ai.generateChatter(payload) : Promise.resolve(null);
  gen.then((lines) => {
    if (chatter.active !== session || session.lines) return;
    session.lines = (lines && lines.length) ? lines : cannedChatter(a, b);
  }).catch(() => {
    if (chatter.active === session && !session.lines) session.lines = cannedChatter(a, b);
  });
}

function playChatterLine(session) {
  const line = session.lines[session.idx];
  const a = state.robots.get(session.a), b = state.robots.get(session.b);
  if (a) a.chatAnim = 'idle';
  if (b) b.chatAnim = 'idle';
  const speaker = state.robots.get(line.robotId);
  if (!speaker) { session.holdFor = 0.1; return; }
  if (session.idx === 0) speaker.chatAnim = 'wave';
  session.holdFor = Math.max(2.4, line.line.length * 0.07);
  const other = speaker.id === session.a ? b : a;
  speaker.memory.push('Told ' + (other ? other.name : 'a neighbour') + ': ' + line.line);
  if (speaker.memory.length > 20) speaker.memory = speaker.memory.slice(-20);
  if (ai.speakRobotLine) ai.speakRobotLine(line.robotId, line.line);
}

function endChatter(session) {
  chatter.active = null;
  for (const id of [session.a, session.b]) {
    const r = state.robots.get(id);
    if (r) { r.chatAnim = null; setConversation(false, id); }
  }
}

function updateChatter(dt) {
  if (state.mode !== 'host' && state.mode !== 'solo') return;
  const session = chatter.active;
  if (session) {
    session.timer += dt;
    if (session.phase === 'load') {
      if (session.lines) { session.phase = 'play'; session.timer = session.holdFor; }
      else if (session.timer > 6) { session.lines = cannedChatter(state.robots.get(session.a), state.robots.get(session.b)); session.phase = 'play'; session.timer = session.holdFor; }
      // if either robot got pulled out of the freeze (arrest etc.), abandon
      const ra = state.robots.get(session.a), rb = state.robots.get(session.b);
      if (!ra || !rb || ra.fsm !== 'CONVERSING' || rb.fsm !== 'CONVERSING') endChatter(session);
      return;
    }
    if (session.timer >= session.holdFor) {
      session.idx++;
      if (!session.lines || session.idx >= session.lines.length) { endChatter(session); return; }
      playChatterLine(session);
      session.timer = 0;
    }
    return;
  }
  chatter.acc += dt;
  if (chatter.acc < chatter.next) return;
  chatter.acc = 0;
  chatter.next = 45 + chatterRng() * 30;
  const pair = pickChatterPair();
  if (pair) startChatter(pair);
}

function lerpEntities() {
  for (const [id, rp] of state.remotePlayers) {
    rp.p.x += (rp.targetP.x - rp.p.x) * LERP;
    rp.p.z += (rp.targetP.z - rp.p.z) * LERP;
    let dry = rp.targetRy - rp.ry;
    while (dry > Math.PI) dry -= Math.PI * 2;
    while (dry < -Math.PI) dry += Math.PI * 2;
    rp.ry += dry * LERP;
    const mesh = remoteMeshes.get(id);
    if (mesh) { mesh.position.set(rp.p.x, 0, rp.p.z); mesh.rotation.y = rp.ry; }
    const av = remoteAvatars.get(id);
    if (av) av.setAnim(rp.anim);
  }
  if (state.mode === 'client') {
    for (const r of state.robots.values()) {
      r.p.x += (r.targetP.x - r.p.x) * LERP;
      r.p.z += (r.targetP.z - r.p.z) * LERP;
      let dry = r.targetRy - r.ry;
      while (dry > Math.PI) dry -= Math.PI * 2;
      while (dry < -Math.PI) dry += Math.PI * 2;
      r.ry += dry * LERP;
      syncRobotMesh(r);
    }
  }
}

function updateCamera() {
  const tx = state.player.p.x, ty = 1.6, tz = state.player.p.z;
  const dist = 7, height = 4.5;
  const cp = Math.cos(camPitch), sp = Math.sin(camPitch);
  camera.position.set(
    tx - Math.sin(state.player.ry) * dist * cp,
    ty + height + dist * sp,
    tz - Math.cos(state.player.ry) * dist * cp
  );
  camera.lookAt(tx, ty, tz);
  const gx = Math.round(state.player.p.x / 2) * 2;
  const gz = Math.round(state.player.p.z / 2) * 2;
  dirLight.position.set(gx + 40, 70, gz + 30);
  dirLight.target.position.set(gx, 0, gz);
  dirLight.target.updateMatrixWorld();
}

function buildSnapshot() {
  const players = {};
  players[state.playerId] = {
    p: [round2(state.player.p.x), 0, round2(state.player.p.z)],
    ry: round2(state.player.ry), anim: state.player.anim, name: state.playerName
  };
  for (const [id, rp] of state.remotePlayers) {
    players[id] = { p: [round2(rp.p.x), 0, round2(rp.p.z)], ry: round2(rp.ry), anim: rp.anim, name: rp.name };
  }
  const robots = {};
  for (const r of state.robots.values()) {
    robots[r.id] = { p: [round2(r.p.x), 0, round2(r.p.z)], ry: round2(r.ry), state: r.fsm, anim: r.anim };
  }
  return { players, robots, seq: ++snapSeq };
}

function round2(v) { return Math.round(v * 100) / 100; }

function simStep() {
  state.tick++;
  if (state.mode === 'host' || state.mode === 'solo') {
    updatePlayer();
    replanBudget = REPLANS_PER_STEP;
    for (const r of state.robots.values()) updateRobot(r);
    updatePlayerArrest();
    updateChatter(STEP);
  } else if (state.mode === 'client') {
    updatePlayer();
  }
  if (manipulatorInst) manipulatorInst.step(STEP);
  lerpEntities();
  updateMixers(STEP);
  updateCamera();

  if (state.tick % 3 === 0) {
    if (state.mode === 'client') {
      multiplayer.sendState({ p: [round2(state.player.p.x), 0, round2(state.player.p.z)], ry: round2(state.player.ry), anim: state.player.anim });
    } else if (state.mode === 'host') {
      multiplayer.broadcastSnapshot(buildSnapshot());
    }
  }
  if (state.tick % 15 === 0) refreshTargetRobot();
}

function frame(t) {
  requestAnimationFrame(frame);
  if (!frame.last) frame.last = t;
  let acc = frame.acc || 0;
  acc += Math.min((t - frame.last) / 1000, 0.25);
  frame.last = t;
  let n = 0;
  while (acc >= STEP && n < 5) { simStep(); acc -= STEP; n++; }
  frame.acc = acc;
  renderer.render(scene, camera);
}

function startLoop() {
  if (loopStarted) return;
  loopStarted = true;
  frame.last = 0; frame.acc = 0;
  requestAnimationFrame(frame);
}

export function getAIContext(robotId) {
  const r = state.robots.get(robotId);
  if (!r) return null;
  const nearbyRobots = [];
  for (const o of state.robots.values()) {
    if (o.id === robotId) continue;
    if (dist2(r.p.x, r.p.z, o.p.x, o.p.z) <= 625) nearbyRobots.push(o.name);
  }
  // All walls (small, fixed set) with sector labels + distance, so the intent
  // model can resolve phrases like "the wall by the prison" from anywhere.
  const nearbyWalls = [];
  for (const [id, w] of state.walls) {
    const cx = (w.box.minX + w.box.maxX) / 2, cz = (w.box.minZ + w.box.maxZ) / 2;
    const sector = id.startsWith('wall_p_') ? 'prison' : id.startsWith('wall_sq_') ? 'main_square' : 'street';
    nearbyWalls.push({ id, sector, dist: Math.round(Math.sqrt(dist2(r.p.x, r.p.z, cx, cz))), destroyed: w.destroyed });
  }
  nearbyWalls.sort((a, b) => a.dist - b.dist);
  return {
    robotName: r.name, role: r.role, currentAction: r.currentAction,
    memory: r.memory.slice(-8), inventory: r.inventory.slice(),
    wanted: state.wanted.slice(), playerName: state.playerName,
    nearbyRobots, nearbyWalls, places: ['main_square', 'prison'],
    robotPos: { x: round2(r.p.x), z: round2(r.p.z) },
    playerPos: { x: round2(state.player.p.x), z: round2(state.player.p.z) }
  };
}

export function getNearestRobotId(maxDist = 12) {
  let best = null, bestD = maxDist * maxDist;
  for (const r of state.robots.values()) {
    const d = dist2(r.p.x, r.p.z, state.player.p.x, state.player.p.z);
    if (d < bestD) { bestD = d; best = r.id; }
  }
  return best;
}

function resolveMoveTarget(r, intent, fromPlayerId) {
  const params = intent.params || {};
  if (typeof params.x === 'number' && typeof params.z === 'number') return { x: params.x, z: params.z };
  const target = (intent.target || '').toLowerCase();
  if (target === 'main_square' || target === 'square') return { x: 0, z: 0 };
  if (target === 'prison') return { x: 70, z: -70 };
  if (target === 'player') { const p = entityPos(fromPlayerId); return p || { x: state.player.p.x, z: state.player.p.z }; }
  const ent = nameToEntity(target);
  if (ent) return { x: ent.p.x, z: ent.p.z };
  return { x: r.p.x, z: r.p.z };
}

function findNearestWall(x, z, wantDestroyed) {
  let best = null, bestD = Infinity;
  for (const [id, w] of state.walls) {
    if (w.destroyed !== wantDestroyed) continue;
    const cx = (w.box.minX + w.box.maxX) / 2, cz = (w.box.minZ + w.box.maxZ) / 2;
    const d = dist2(x, z, cx, cz);
    if (d < bestD) { bestD = d; best = id; }
  }
  return best;
}

function idToName(id) {
  const r = state.robots.get(id);
  if (r) return r.name;
  if (id === (state.playerId || 'solo')) return state.playerName;
  const rp = state.remotePlayers.get(id);
  if (rp) return rp.name || id;
  return id;
}

// Distribute arrest targets among police units: each target grabbed by the nearest
// still-free unit, then round-robin once units run out.
function assignArrests(unitIds, targetIds) {
  const units = unitIds.map((id) => state.robots.get(id)).filter(Boolean);
  if (!units.length) return;
  const free = units.slice();
  let rr = 0;
  for (const tid of targetIds) {
    const tp = entityPos(tid);
    if (!tp) continue;
    let unit = null;
    if (free.length) {
      let bi = 0, bd = Infinity;
      for (let i = 0; i < free.length; i++) {
        const d = dist2(free[i].p.x, free[i].p.z, tp.x, tp.z);
        if (d < bd) { bd = d; bi = i; }
      }
      unit = free.splice(bi, 1)[0];
    } else {
      unit = units[rr++ % units.length];
    }
    unit.fsm = 'CHASE'; unit.followId = tid; clearPath(unit);
    setAction(unit, 'chasing ' + idToName(tid));
  }
}

// Fleet arrest: the selector may address the victims (civilians/players) and/or the
// police units. Everyone targeted becomes wanted; police units then distribute.
function applyFleetArrest(intent, ids) {
  let targetIds = [];
  const nonPolice = ids.filter((id) => { const r = state.robots.get(id); return r && r.role !== 'police'; });
  const policeSel = ids.filter((id) => { const r = state.robots.get(id); return r && r.role === 'police'; });
  if (nonPolice.length && !policeSel.length) targetIds = nonPolice.slice();
  if (intent.target) {
    const t = String(intent.target).toLowerCase();
    const ent = nameToEntity(t);
    if (ent) targetIds.push(ent.id);
    else targetIds.push(...resolveSelector(intent.target, null));
  }
  targetIds = [...new Set(targetIds)];
  if (!targetIds.length) return;
  const list = state.wanted.slice();
  for (const tid of targetIds) { const nm = idToName(tid).toLowerCase(); if (nm && !list.includes(nm)) list.push(nm); }
  if (list.length !== state.wanted.length) applyWorldEvent('wanted', { list });
  assignArrests(policeSel.length ? policeSel : roleIds('police'), targetIds);
}

// ADD_WANTED / REMOVE_WANTED resolved once at world level (not per robot).
function applyWantedIntent(action, intent, ids, hasSelector) {
  const names = new Set();
  if (intent.target) {
    const t = String(intent.target).toLowerCase();
    const ent = nameToEntity(t);
    if (ent) names.add(idToName(ent.id).toLowerCase());
    else {
      const sub = resolveSelector(intent.target, null);
      if (sub.length) for (const id of sub) names.add(state.robots.get(id).name.toLowerCase());
      else names.add(t);
    }
  }
  if (hasSelector) for (const id of ids) { const r = state.robots.get(id); if (r) names.add(r.name.toLowerCase()); }
  if (!names.size) return;
  if (action === 'ADD_WANTED') {
    const list = state.wanted.slice();
    for (const n of names) if (!list.includes(n)) list.push(n);
    applyWorldEvent('wanted', { list });
  } else {
    applyWorldEvent('wanted', { list: state.wanted.filter((n) => !names.has(n)) });
    for (const n of names) {
      const ent = nameToEntity(n);
      const t = ent && ent.kind === 'robot' ? state.robots.get(ent.id) : null;
      if (t && t.fsm === 'JAILED') freeJailed(t, 'Released — no longer wanted');
      else if (t && t.fsm === 'CARRIED') { t.captorId = null; t.heldY = 0; t.fsm = 'WANDER'; pickWander(t); }
    }
  }
}

export function applyIntent(robotId, intent, fromPlayerId) {
  if (state.mode !== 'host' && state.mode !== 'solo') return;
  if (!intent) return;
  const from = fromPlayerId || state.playerId || 'solo';
  const action = intent.action || 'UNKNOWN';
  const hasSelector = !!(intent.robots != null && String(intent.robots).trim());
  const ids = resolveSelector(intent.robots, robotId);

  if (action === 'ARREST') {
    if (hasSelector) applyFleetArrest(intent, ids);
    else { const r = state.robots.get(robotId); if (r) applyIntentToRobot(r, intent, from); }
  } else if (action === 'ADD_WANTED' || action === 'REMOVE_WANTED') {
    applyWantedIntent(action, intent, ids, hasSelector);
  } else {
    for (const id of ids) { const r = state.robots.get(id); if (r) applyIntentToRobot(r, intent, from); }
  }

  if (intent.say && intent.say.length) multiplayer.broadcastRobotSay(robotId, intent.say);
}

function applyIntentToRobot(r, intent, from) {
  const action = intent.action || 'UNKNOWN';

  switch (action) {
    case 'MOVE_TO': {
      r.target = resolveMoveTarget(r, intent, from);
      r.fsm = 'MOVE_TO'; r.stateTimer = 0; clearPath(r);
      setAction(r, 'moving to ' + (intent.target || 'a point'), 'Command: move');
      break;
    }
    case 'FOLLOW_PLAYER': {
      r.followId = from; r.fsm = 'FOLLOW'; clearPath(r);
      setAction(r, 'following ' + state.playerName, 'Command: follow');
      break;
    }
    case 'DESTROY_WALL':
    case 'REPAIR_WALL': {
      const destroyed = action === 'DESTROY_WALL';
      let wallId = intent.target;
      if (!state.walls.has(wallId)) wallId = findNearestWall(r.p.x, r.p.z, !destroyed);
      if (wallId) {
        r.target = { wallId, destroyed }; r.fsm = 'WORK_WALL'; r.stateTimer = 0; clearPath(r);
        setAction(r, (destroyed ? 'heading to break ' : 'heading to fix ') + wallId);
      }
      break;
    }
    case 'ARREST': {
      if (r.role !== 'police') { break; }
      const name = (intent.target || '').toLowerCase();
      if (name && !state.wanted.includes(name)) {
        applyWorldEvent('wanted', { list: state.wanted.concat([name]) });
      }
      const ent = nameToEntity(name);
      if (ent) { r.fsm = 'CHASE'; r.followId = ent.id; clearPath(r); setAction(r, 'chasing ' + (intent.target || name)); }
      break;
    }
    case 'ADD_WANTED': {
      const name = (intent.target || '').toLowerCase();
      if (name && !state.wanted.includes(name)) applyWorldEvent('wanted', { list: state.wanted.concat([name]) });
      break;
    }
    case 'REMOVE_WANTED': {
      const name = (intent.target || '').toLowerCase();
      applyWorldEvent('wanted', { list: state.wanted.filter((n) => n !== name) });
      const ent = nameToEntity(name);
      const t = ent && ent.kind === 'robot' ? state.robots.get(ent.id) : null;
      if (t && t.fsm === 'JAILED') freeJailed(t, 'Released — no longer wanted');
      else if (t && t.fsm === 'CARRIED') { t.captorId = null; t.heldY = 0; t.fsm = 'WANDER'; pickWander(t); }
      break;
    }
    case 'PATROL': {
      const inPrison = r.p.x > 50 && r.p.z < -48;
      r.waypoints = (inPrison ? [{ x: 58, z: -52 }, { x: 82, z: -52 }, { x: 82, z: -88 }, { x: 58, z: -88 }] : SQUARE_CORNERS).slice();
      r.wpIndex = 0; r.fsm = 'PATROL'; clearPath(r);
      setAction(r, 'patrolling');
      break;
    }
    case 'GUARD': {
      r.target = resolveMoveTarget(r, intent, from);
      if (!intent.params || (typeof intent.params.x !== 'number' && !intent.target)) r.target = { x: r.p.x, z: r.p.z };
      r.fsm = 'GUARD'; clearPath(r);
      setAction(r, 'guarding');
      break;
    }
    case 'GIVE_ITEM': {
      const item = (intent.params && intent.params.item) || intent.target;
      if (item) { r.inventory.push(item); setAction(r, 'received ' + item, 'Got item: ' + item); }
      break;
    }
    case 'TAKE_ITEM': {
      const item = (intent.params && intent.params.item) || intent.target;
      const idx = r.inventory.indexOf(item);
      if (idx >= 0) { r.inventory.splice(idx, 1); setAction(r, 'gave ' + item, 'Gave item: ' + item); }
      break;
    }
    case 'DANCE': {
      r.fsm = 'DANCE'; r.danceT = 0;
      setAction(r, 'dancing');
      break;
    }
    case 'STOP': {
      r.followId = null; r.target = null; r.fsm = 'IDLE'; r.stateTimer = 0; clearPath(r);
      setAction(r, 'idle');
      break;
    }
    default: break;
  }
}

export function applyWorldEvent(kind, data) {
  const host = state.mode === 'host' || state.mode === 'solo';

  if (kind === 'wall-toggle') {
    const w = state.walls.get(data.wallId);
    if (!w) return;
    const destroyed = !w.destroyed;
    setWallState(data.wallId, destroyed);
    if (host) {
      multiplayer.broadcastEvent('wall', { wallId: data.wallId, destroyed });
      database.writeWorld(state.lobbyId, { walls: { [data.wallId]: { destroyed } } });
    }
    return;
  }

  if (kind === 'wall') {
    setWallState(data.wallId, !!data.destroyed);
    if (host) {
      multiplayer.broadcastEvent('wall', { wallId: data.wallId, destroyed: !!data.destroyed });
      database.writeWorld(state.lobbyId, { walls: { [data.wallId]: { destroyed: !!data.destroyed } } });
    }
    return;
  }

  if (kind === 'wanted') {
    const list = (data.list || []).map((n) => (n || '').toLowerCase());
    state.wanted = list;
    refreshWanted();
    if (host) {
      multiplayer.broadcastEvent('wanted', { list });
      database.writeWorld(state.lobbyId, { wanted: list });
    }
    return;
  }

  if (kind === 'arrest') {
    const targetName = (data.targetName || '').toLowerCase();
    const targetPid = data.byPlayerId || (targetName === state.playerName.toLowerCase() ? (state.playerId || 'solo') : null);
    if (targetName === state.playerName.toLowerCase() && (state.mode === 'client' || host)) {
      state.player.arrested = true;
      status('ARESZTOWANY', 'err');
    }
    if (host) {
      playerArrest = { playerId: targetPid || (state.playerId || 'solo'), phase: 'escort', timer: 0 };
      multiplayer.broadcastEvent('arrest', data);
    }
    return;
  }

  if (kind === 'release') {
    const targetName = (data.targetName || '').toLowerCase();
    if (targetName === state.playerName.toLowerCase()) {
      state.player.arrested = false;
      if (state.mode === 'client') {
        state.player.p.x = 70; state.player.p.z = -50;
        syncPlayerMesh();
      }
      status('Zwolniony', 'ok');
    }
    if (host) multiplayer.broadcastEvent('release', data);
    return;
  }
}

function setWallState(wallId, destroyed) {
  const w = state.walls.get(wallId);
  if (!w) return;
  const changed = w.destroyed !== destroyed;
  if (changed) nav.setWallDestroyed(wallId, destroyed);
  w.destroyed = destroyed;
  if (w.mesh) w.mesh.visible = !destroyed;
  // Breaking any wall of a cell frees whoever is jailed inside it (host authority).
  if (changed && destroyed && (state.mode === 'host' || state.mode === 'solo') && CELL_WALL_INDEX.has(wallId)) {
    freePrisonersOfCell(CELL_WALL_INDEX.get(wallId));
  }
}

function refreshWanted() {
  const box = el('wanted-list');
  if (!box) return;
  box.innerHTML = '';
  for (const n of state.wanted) {
    const s = document.createElement('span');
    s.className = 'wanted-name';
    s.textContent = n.toUpperCase();
    box.appendChild(s);
  }
}

function refreshTargetRobot() {
  const box = el('target-robot');
  if (!box) return;
  const id = getNearestRobotId(12);
  box.textContent = id ? '▸ ' + state.robots.get(id).name : '';
}

function renderChatMessage(from, text) {
  const log = el('chat-log');
  if (!log) return;
  const div = document.createElement('div');
  div.className = 'chat-msg';
  const b = document.createElement('b');
  b.className = 'chat-from';
  b.textContent = from + ' ';
  const span = document.createElement('span');
  span.className = 'chat-text';
  span.textContent = text;
  div.appendChild(b); div.appendChild(span);
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

function onNetSnapshot(detail) {
  if (detail.seq !== undefined) {
    if (detail.seq <= lastSnapSeq) return;
    lastSnapSeq = detail.seq;
  }
  if (detail.players) {
    for (const id in detail.players) {
      if (id === state.playerId) {
        if (state.player.arrested && state.mode === 'client') {
          const pd = detail.players[id];
          if (pd && pd.p) {
            state.player.p.x = pd.p[0]; state.player.p.z = pd.p[2];
            if (typeof pd.ry === 'number') state.player.ry = pd.ry;
            syncPlayerMesh();
          }
        }
        continue;
      }
      const pd = detail.players[id];
      if (!state.remotePlayers.has(id)) spawnRemoteAvatar(id, pd.name);
      const rp = state.remotePlayers.get(id);
      rp.name = pd.name || rp.name;
      rp.targetP.x = pd.p[0]; rp.targetP.z = pd.p[2];
      rp.targetRy = pd.ry; rp.anim = pd.anim;
    }
  }
  if (detail.robots) {
    for (const id in detail.robots) {
      const r = state.robots.get(id);
      if (!r) continue;
      const rd = detail.robots[id];
      r.targetP.x = rd.p[0]; r.targetP.z = rd.p[2]; r.targetRy = rd.ry;
      r.fsm = rd.state; r.anim = rd.anim;
    }
  }
}

function onNetWelcome(detail) {
  if (detail.players) {
    for (const p of detail.players) {
      if (p.id === state.playerId) continue;
      spawnRemoteAvatar(p.id, p.name);
    }
  }
  if (detail.robots) {
    for (const id in detail.robots) {
      const r = state.robots.get(id);
      if (!r) continue;
      const rd = detail.robots[id];
      if (rd.p) { r.p.x = rd.p[0]; r.p.z = rd.p[2]; r.targetP.x = rd.p[0]; r.targetP.z = rd.p[2]; }
      if (typeof rd.ry === 'number') { r.ry = rd.ry; r.targetRy = rd.ry; }
      if (rd.state) r.fsm = rd.state;
      syncRobotMesh(r);
    }
  }
  if (detail.world) {
    if (detail.world.walls) {
      for (const id in detail.world.walls) {
        if (detail.world.walls[id] && detail.world.walls[id].destroyed) setWallState(id, true);
      }
    }
    if (detail.world.wanted) { state.wanted = detail.world.wanted.map((n) => n.toLowerCase()); refreshWanted(); }
  }
}

function wireBus() {
  bus.addEventListener('net:role', (e) => {
    const d = e.detail;
    state.mode = d.role;
    state.playerId = d.playerId;
    state.lobbyId = d.lobbyId;
    el('lobby-modal').classList.add('hidden');
    el('hud').classList.remove('hidden');
    ai.initAI();
    if (state.mode === 'host' || state.mode === 'solo') initRobotsPersistence();
    startLoop();
    bus.dispatchEvent(new CustomEvent('game:started', { detail: { mode: state.mode } }));
    status('Gra uruchomiona: ' + state.mode, 'ok');
  });

  bus.addEventListener('net:player-joined', (e) => spawnRemoteAvatar(e.detail.playerId, e.detail.name));
  bus.addEventListener('net:player-left', (e) => removeRemoteAvatar(e.detail.playerId));

  bus.addEventListener('net:remote-state', (e) => {
    const d = e.detail;
    if (!state.remotePlayers.has(d.playerId)) spawnRemoteAvatar(d.playerId, d.playerId);
    const rp = state.remotePlayers.get(d.playerId);
    rp.targetP.x = d.p[0]; rp.targetP.z = d.p[2]; rp.targetRy = d.ry; rp.anim = d.anim;
  });

  bus.addEventListener('net:snapshot', (e) => onNetSnapshot(e.detail));
  bus.addEventListener('net:welcome', (e) => onNetWelcome(e.detail));

  bus.addEventListener('net:req', (e) => {
    if (state.mode !== 'host' && state.mode !== 'solo') return;
    const d = e.detail;
    if (d.kind === 'wall-toggle') applyWorldEvent('wall-toggle', d.data);
    else if (d.kind === 'intent') applyIntent(d.data.robotId, d.data.intent, d.fromPlayerId);
  });

  bus.addEventListener('net:event', (e) => {
    if (state.mode !== 'client') return;
    const { kind, data } = e.detail;
    if (kind === 'wall') setWallState(data.wallId, !!data.destroyed);
    else if (kind === 'wanted') { state.wanted = (data.list || []).map((n) => n.toLowerCase()); refreshWanted(); }
    else if (kind === 'arrest') applyWorldEvent('arrest', data);
    else if (kind === 'release') applyWorldEvent('release', data);
  });

  bus.addEventListener('world:update', (e) => {
    const d = e.detail;
    if (d.walls) {
      for (const [id, w] of state.walls) {
        const rec = d.walls[id];
        setWallState(id, !!(rec && rec.destroyed));
      }
    }
    if (d.wanted) { state.wanted = d.wanted.map((n) => n.toLowerCase()); refreshWanted(); }
  });

  bus.addEventListener('chat:incoming', (e) => renderChatMessage(e.detail.from, e.detail.text));

  bus.addEventListener('ai:conversation', (e) => setConversation(!!e.detail.active, e.detail.robotId));
  bus.addEventListener('ai:robot-reply', (e) => appendRobotReply(e.detail.robotId, e.detail.text));

  bus.addEventListener('ui:status', (e) => {
    const pill = el('status-pill');
    if (!pill) return;
    pill.textContent = e.detail.text;
    pill.classList.remove('ok', 'warn', 'err');
    pill.classList.add(e.detail.level || 'ok');
  });
}

async function initRobotsPersistence() {
  let saved = null;
  try { saved = await database.loadRobots(); } catch (err) { saved = null; }
  for (const def of ROSTER) {
    const r = state.robots.get(def.id);
    const doc = saved && saved.get ? saved.get(def.id) : null;
    if (doc) {
      if (doc.color) r.color = doc.color;
      if (Array.isArray(doc.inventory)) r.inventory = doc.inventory.slice();
      if (Array.isArray(doc.memory)) r.memory = doc.memory.slice(-20);
      if (doc.currentAction) r.currentAction = doc.currentAction;
    } else {
      database.ensureRobotDoc(def.id, { id: def.id, name: def.name, color: def.color, role: def.role });
    }
  }
}

function setupInput() {
  const canvas = el('game-canvas');
  canvas.addEventListener('click', () => {
    if (state.mode !== 'menu' && !pointerLocked) canvas.requestPointerLock();
  });
  document.addEventListener('pointerlockchange', () => {
    pointerLocked = document.pointerLockElement === canvas;
  });
  document.addEventListener('mousemove', (e) => {
    if (!pointerLocked) return;
    state.player.ry -= e.movementX * 0.0025;
    camPitch = clamp(camPitch + e.movementY * 0.0025, -0.4, 0.6);
  });

  window.addEventListener('keydown', (e) => {
    const typing = document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA');
    if (e.code === 'KeyT' && !typing) { e.preventDefault(); const ci = el('chat-input'); if (ci) ci.focus(); return; }
    if (typing) return;
    keys.add(e.code);
    if (e.code === 'KeyE') tryToggleWall();
    if (e.code === 'KeyM') { const mb = el('mic-btn'); if (mb) mb.click(); }
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));
  window.addEventListener('blur', () => keys.clear());

  window.addEventListener('resize', () => {
    if (!renderer) return;
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
}

function tryToggleWall() {
  let best = null, bestD = 16;
  for (const [id, w] of state.walls) {
    const cx = (w.box.minX + w.box.maxX) / 2, cz = (w.box.minZ + w.box.maxZ) / 2;
    const d = dist2(state.player.p.x, state.player.p.z, cx, cz);
    if (d < bestD) { bestD = d; best = id; }
  }
  if (!best) return;
  if (state.mode === 'host' || state.mode === 'solo') applyWorldEvent('wall-toggle', { wallId: best });
  else if (state.mode === 'client') multiplayer.sendReq('wall-toggle', { wallId: best });
}

function getPlayerName() {
  let name = '';
  try { name = localStorage.getItem('g2049_name') || ''; } catch (err) { name = ''; }
  if (!name) name = 'Gracz-' + Math.floor(1000 + Math.random() * 9000);
  return name;
}

function renderLobbies(list) {
  const ul = el('lobby-list');
  if (!ul) return;
  ul.innerHTML = '';
  if (!list || list.length === 0) {
    const li = document.createElement('li');
    li.className = 'lobby-item empty';
    li.textContent = 'Brak aktywnych lobby';
    ul.appendChild(li);
    return;
  }
  for (const lob of list) {
    const li = document.createElement('li');
    li.className = 'lobby-item';
    li.dataset.lobbyId = lob.id;
    li.dataset.hostPeerId = lob.hostPeerId || '';
    li.textContent = (lob.name || 'Lobby') + '  ·  ' + (lob.players || 1) + ' graczy';
    li.addEventListener('click', () => {
      const name = el('player-name-input').value.trim() || getPlayerName();
      state.playerName = name;
      try { localStorage.setItem('g2049_name', name); } catch (err) { }
      multiplayer.joinGame(li.dataset.lobbyId, li.dataset.hostPeerId, name).catch(() => { });
    });
    ul.appendChild(li);
  }
}

async function refreshLobbies() {
  try {
    const list = await database.fetchLobbies();
    renderLobbies(list);
  } catch (err) {
    renderLobbies([]);
  }
}

function wireLobby() {
  const nameInput = el('player-name-input');
  nameInput.value = getPlayerName();

  el('btn-create-lobby').addEventListener('click', () => {
    const name = nameInput.value.trim() || getPlayerName();
    const lobbyName = (el('lobby-name-input').value.trim()) || (name + ' — Gzowo');
    state.playerName = name;
    try { localStorage.setItem('g2049_name', name); } catch (err) { }
    multiplayer.hostGame(lobbyName, name).catch(() => status('Nie udało się hostować', 'err'));
  });

  el('btn-solo').addEventListener('click', () => {
    const name = nameInput.value.trim() || getPlayerName();
    state.playerName = name;
    try { localStorage.setItem('g2049_name', name); } catch (err) { }
    multiplayer.startSolo(name);
  });

  el('btn-refresh-lobbies').addEventListener('click', refreshLobbies);
}

function init() {
  state.playerName = getPlayerName();
  buildScene();
  initAvatars();
  setupInput();
  wireBus();
  wireLobby();

  window.G2049 = {
    state,
    bus,
    nav: { findPath: nav.findPath, isWalkable: nav.isWalkable, hasLineOfWalk: nav.hasLineOfWalk },
    manipulator: manipulatorInst,
    debugStep(seconds = STEP) {
      const steps = Math.max(1, Math.round(seconds / STEP));
      for (let i = 0; i < steps; i++) simStep();
      renderer.render(scene, camera);
    }
  };

  renderer.render(scene, camera);
  el('loading').classList.add('hidden');
  el('lobby-modal').classList.remove('hidden');

  database.initFirebase()
    .then((ok) => { if (!ok) status('Tryb offline', 'warn'); refreshLobbies(); })
    .catch(() => { status('Tryb offline', 'warn'); refreshLobbies(); });
}

init();
