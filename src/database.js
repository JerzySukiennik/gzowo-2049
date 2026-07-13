// database.js — Firestore layer: lobby registry, robot memory, world sync, chat log. Graceful offline no-ops.
import { bus } from './game.js';

const FIREBASE_CONFIG = { apiKey: "AIzaSyDtvprcWl0Bp20HTuG9u0ngwQrKP9Ku_ac", authDomain: "gzowo-2049.firebaseapp.com", projectId: "gzowo-2049", storageBucket: "gzowo-2049.firebasestorage.app", messagingSenderId: "772927726287", appId: "1:772927726287:web:87b0bfe91847da81f70dba" };

let db = null;
let fx = null;
let initPromise = null;
let warnedOffline = false;

const robotBuf = new Map();
const worldBuf = new Map();

function status(text, level) {
  bus.dispatchEvent(new CustomEvent('ui:status', { detail: { text, level } }));
}

function offlineWarn() {
  if (warnedOffline) return;
  warnedOffline = true;
  status('Tryb offline — brak Firestore', 'warn');
}

export async function initFirebase() {
  if (db) return true;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      const appMod = await import('https://www.gstatic.com/firebasejs/11.0.1/firebase-app.js');
      const fsMod = await import('https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js');
      const app = appMod.initializeApp(FIREBASE_CONFIG);
      db = fsMod.getFirestore(app);
      fx = fsMod;
      return true;
    } catch (e) {
      db = null;
      fx = null;
      offlineWarn();
      return false;
    }
  })();
  return initPromise;
}

export async function createLobby(name, hostPeerId) {
  if (!db) { offlineWarn(); return null; }
  try {
    const ref = await fx.addDoc(fx.collection(db, 'lobbies'), {
      name: String(name || 'Lobby').slice(0, 24),
      hostPeerId,
      players: 1,
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
    return ref.id;
  } catch (e) {
    offlineWarn();
    return null;
  }
}

export async function heartbeatLobby(lobbyId, playerCount) {
  if (!db || !lobbyId) return;
  try {
    await fx.setDoc(fx.doc(db, 'lobbies', lobbyId), {
      players: playerCount,
      updatedAt: Date.now()
    }, { merge: true });
  } catch (e) {}
}

export async function removeLobby(lobbyId) {
  if (!db || !lobbyId) return;
  try {
    await fx.deleteDoc(fx.doc(db, 'lobbies', lobbyId));
  } catch (e) {}
}

export async function fetchLobbies() {
  if (!db) { offlineWarn(); return []; }
  try {
    const snap = await fx.getDocs(fx.collection(db, 'lobbies'));
    const cutoff = Date.now() - 120000;
    const out = [];
    snap.forEach((d) => {
      const data = d.data() || {};
      if ((data.updatedAt || 0) > cutoff) out.push({ id: d.id, ...data });
    });
    out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return out;
  } catch (e) {
    offlineWarn();
    return [];
  }
}

export async function loadRobots() {
  const result = new Map();
  if (!db) { offlineWarn(); return result; }
  try {
    const snap = await fx.getDocs(fx.collection(db, 'robots'));
    snap.forEach((d) => {
      const data = { id: d.id, ...(d.data() || {}) };
      result.set(d.id, data);
      const mem = Array.isArray(data.memory) ? data.memory.slice(-20) : [];
      robotBuf.set(d.id, { currentAction: data.currentAction || 'idle', memory: mem, timer: null });
    });
    return result;
  } catch (e) {
    offlineWarn();
    return result;
  }
}

export async function ensureRobotDoc(robotId, defaults) {
  const d = defaults || {};
  const mem = Array.isArray(d.memory) ? d.memory.slice(-20) : [];
  const buf = robotBuf.get(robotId);
  if (buf) { buf.memory = mem; buf.currentAction = d.currentAction || buf.currentAction || 'idle'; }
  else robotBuf.set(robotId, { currentAction: d.currentAction || 'idle', memory: mem, timer: null });
  if (!db) return;
  try {
    await fx.setDoc(fx.doc(db, 'robots', robotId), {
      id: robotId,
      name: d.name || robotId,
      color: d.color || '#ffffff',
      role: d.role || 'civilian',
      inventory: Array.isArray(d.inventory) ? d.inventory : [],
      memory: mem,
      currentAction: d.currentAction || 'idle',
      updatedAt: Date.now()
    }, { merge: true });
  } catch (e) {}
}

function flushRobot(robotId) {
  const buf = robotBuf.get(robotId);
  if (!buf || !db) return;
  fx.setDoc(fx.doc(db, 'robots', robotId), {
    currentAction: buf.currentAction,
    memory: buf.memory.slice(-20),
    updatedAt: Date.now()
  }, { merge: true }).catch(() => {});
}

export function saveRobotAction(robotId, currentAction, memoryEntry) {
  let buf = robotBuf.get(robotId);
  if (!buf) { buf = { currentAction: 'idle', memory: [], timer: null }; robotBuf.set(robotId, buf); }
  buf.currentAction = currentAction;
  if (memoryEntry) {
    buf.memory.push(memoryEntry);
    if (buf.memory.length > 20) buf.memory = buf.memory.slice(-20);
  }
  if (!db) return;
  if (buf.timer) return;
  buf.timer = setTimeout(() => { buf.timer = null; flushRobot(robotId); }, 5000);
}

function flushWorld(lobbyId) {
  const buf = worldBuf.get(lobbyId);
  if (!buf || !db) return;
  const payload = { ...buf.pending, updatedAt: Date.now() };
  buf.pending = {};
  fx.setDoc(fx.doc(db, 'world', lobbyId), payload, { merge: true }).catch(() => {});
}

export function writeWorld(lobbyId, partial) {
  if (!db || !lobbyId || !partial) return;
  let buf = worldBuf.get(lobbyId);
  if (!buf) { buf = { pending: {}, timer: null }; worldBuf.set(lobbyId, buf); }
  if (partial.walls) buf.pending.walls = Object.assign(buf.pending.walls || {}, partial.walls);
  if (partial.wanted) buf.pending.wanted = partial.wanted.slice();
  if (buf.timer) return;
  buf.timer = setTimeout(() => { buf.timer = null; flushWorld(lobbyId); }, 2000);
}

export function subscribeWorld(lobbyId) {
  if (!db || !lobbyId) return () => {};
  try {
    return fx.onSnapshot(fx.doc(db, 'world', lobbyId), (snap) => {
      const data = snap.data() || {};
      bus.dispatchEvent(new CustomEvent('world:update', {
        detail: { walls: data.walls || {}, wanted: data.wanted || [] }
      }));
    }, () => {});
  } catch (e) {
    return () => {};
  }
}

export async function sendChat(lobbyId, from, text) {
  if (!db || !lobbyId) return;
  const clean = String(text || '').slice(0, 200);
  if (!clean) return;
  try {
    await fx.addDoc(fx.collection(db, 'chat'), {
      lobbyId,
      from: String(from || '?').slice(0, 24),
      text: clean,
      ts: Date.now()
    });
  } catch (e) {}
}

export function subscribeChat(lobbyId) {
  if (!db || !lobbyId) return () => {};
  const since = Date.now() - 60000;
  const seen = new Set();
  try {
    const q = fx.query(fx.collection(db, 'chat'), fx.where('lobbyId', '==', lobbyId));
    return fx.onSnapshot(q, (snap) => {
      const fresh = [];
      snap.forEach((d) => {
        if (seen.has(d.id)) return;
        const data = d.data() || {};
        if ((data.ts || 0) <= since) { seen.add(d.id); return; }
        seen.add(d.id);
        fresh.push(data);
      });
      fresh.sort((a, b) => (a.ts || 0) - (b.ts || 0));
      for (const m of fresh) {
        bus.dispatchEvent(new CustomEvent('chat:incoming', {
          detail: { from: m.from, text: m.text, ts: m.ts }
        }));
      }
    }, () => {});
  } catch (e) {
    return () => {};
  }
}
