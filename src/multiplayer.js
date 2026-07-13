// multiplayer.js — PeerJS host-authoritative networking for Gzowo 2049.
// Hosts/joins lobbies, relays the JSON message protocol, dispatches all
// net:* events on the shared bus, and drives lobby heartbeat/cleanup.

import { bus, state } from './game.js';
import * as db from './database.js';

let role = 'menu';
let peer = null;
let playerId = 'solo';
let playerName = 'Gracz';
let lobbyId = null;
let hostPeerId = null;

const connections = new Map();
const players = new Map();
let hostConn = null;

let heartbeatTimer = null;
let worldUnsub = null;
let chatUnsub = null;

let lastSnapshotSeq = -1;
let welcomeTimer = null;
let welcomed = false;
let unloadWired = false;

function emit(name, detail) {
  bus.dispatchEvent(new CustomEvent(name, { detail }));
}

function status(text, level) {
  emit('ui:status', { text, level });
}

function safeSend(conn, msg) {
  if (conn && conn.open) {
    try { conn.send(msg); } catch (e) { /* connection dropping */ }
  }
}

function subscribeWorldAndChat(id) {
  if (worldUnsub) { try { worldUnsub(); } catch (e) {} worldUnsub = null; }
  if (chatUnsub) { try { chatUnsub(); } catch (e) {} chatUnsub = null; }
  try { worldUnsub = db.subscribeWorld(id); } catch (e) { worldUnsub = null; }
  try { chatUnsub = db.subscribeChat(id); } catch (e) { chatUnsub = null; }
}

function buildRobotsPayload() {
  const out = {};
  if (state && state.robots) {
    for (const [id, r] of state.robots) {
      out[id] = { p: [r.p.x, 0, r.p.z], ry: r.ry, state: r.fsm, anim: r.anim || 'idle' };
    }
  }
  return out;
}

function buildWorldPayload() {
  const walls = {};
  if (state && state.walls) {
    for (const [id, w] of state.walls) {
      if (w.destroyed) walls[id] = { destroyed: true };
    }
  }
  const wanted = (state && Array.isArray(state.wanted)) ? state.wanted.slice() : [];
  return { walls, wanted };
}

function buildWelcome(exceptPeerId) {
  const list = [];
  for (const [id, info] of players) {
    if (id !== exceptPeerId) list.push({ id, name: info.name });
  }
  return {
    players: list,
    robots: buildRobotsPayload(),
    world: buildWorldPayload(),
    lobbyId,
  };
}

function playerCount() {
  return 1 + connections.size;
}

function startHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    if (lobbyId) db.heartbeatLobby(lobbyId, playerCount());
  }, 25000);
}

function wireUnload() {
  if (unloadWired) return;
  unloadWired = true;
  window.addEventListener('pagehide', () => {
    if (role === 'host' && lobbyId) db.removeLobby(lobbyId);
  });
}

function handleHostConnection(conn) {
  connections.set(conn.peer, conn);
  conn.on('open', () => {
    connections.set(conn.peer, conn);
  });
  conn.on('data', (msg) => {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case 'hello': {
        const name = (msg.name || 'Gracz').slice(0, 16);
        players.set(conn.peer, { name });
        safeSend(conn, { t: 'welcome', ...buildWelcome(conn.peer) });
        for (const [pid, c] of connections) {
          if (pid !== conn.peer) safeSend(c, { t: 'player-joined', playerId: conn.peer, name });
        }
        emit('net:player-joined', { playerId: conn.peer, name });
        if (lobbyId) db.heartbeatLobby(lobbyId, playerCount());
        break;
      }
      case 'state': {
        emit('net:remote-state', { playerId: conn.peer, p: msg.p, ry: msg.ry, anim: msg.anim });
        break;
      }
      case 'req': {
        emit('net:req', { fromPlayerId: conn.peer, kind: msg.kind, data: msg.data });
        break;
      }
      default:
        break;
    }
  });
  conn.on('close', () => dropClient(conn.peer));
  conn.on('error', () => dropClient(conn.peer));
}

function dropClient(peerId) {
  if (!connections.has(peerId) && !players.has(peerId)) return;
  connections.delete(peerId);
  players.delete(peerId);
  for (const [, c] of connections) {
    safeSend(c, { t: 'player-left', playerId: peerId });
  }
  emit('net:player-left', { playerId: peerId });
  if (lobbyId) db.heartbeatLobby(lobbyId, playerCount());
}

function handleClientData(msg) {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.t) {
    case 'welcome': {
      if (welcomed) break;
      welcomed = true;
      if (welcomeTimer) { clearTimeout(welcomeTimer); welcomeTimer = null; }
      lobbyId = msg.lobbyId || lobbyId;
      emit('net:welcome', {
        players: msg.players || [],
        robots: msg.robots || {},
        world: msg.world || { walls: {}, wanted: [] },
        lobbyId,
      });
      emit('net:role', { role: 'client', playerId, lobbyId });
      subscribeWorldAndChat(lobbyId);
      status('Połączono z hostem', 'ok');
      break;
    }
    case 'player-joined':
      emit('net:player-joined', { playerId: msg.playerId, name: msg.name });
      break;
    case 'player-left':
      emit('net:player-left', { playerId: msg.playerId });
      break;
    case 'snapshot': {
      if (typeof msg.seq === 'number') {
        if (msg.seq <= lastSnapshotSeq) break;
        lastSnapshotSeq = msg.seq;
      }
      emit('net:snapshot', { players: msg.players || {}, robots: msg.robots || {}, seq: msg.seq });
      break;
    }
    case 'event':
      emit('net:event', { kind: msg.kind, data: msg.data });
      break;
    case 'robot-say':
      emit('net:robot-say', { robotId: msg.robotId, text: msg.text });
      break;
    default:
      break;
  }
}

function onHostLost() {
  status('Host rozłączony', 'err');
  setTimeout(() => { try { location.reload(); } catch (e) {} }, 3000);
}

export async function hostGame(lobbyName, name) {
  role = 'host';
  playerName = (name || 'Gracz').slice(0, 16);
  connections.clear();
  players.clear();
  return new Promise((resolve, reject) => {
    let opened = false;
    try {
      peer = new Peer();
    } catch (e) {
      role = 'menu';
      status('Sieć niedostępna', 'err');
      reject(e);
      return;
    }
    peer.on('open', async (id) => {
      if (opened) return;
      opened = true;
      playerId = id;
      players.set(id, { name: playerName });
      let created = null;
      try { created = await db.createLobby(lobbyName || 'Gzowo', id); } catch (e) { created = null; }
      lobbyId = created || ('host-' + id);
      startHeartbeat();
      wireUnload();
      emit('net:role', { role: 'host', playerId, lobbyId });
      subscribeWorldAndChat(lobbyId);
      status('Lobby utworzone', 'ok');
      resolve({ playerId, lobbyId });
    });
    peer.on('connection', (conn) => handleHostConnection(conn));
    peer.on('error', (err) => {
      status('Błąd sieci: ' + (err && err.type ? err.type : 'peer'), 'warn');
      if (!opened) { role = 'menu'; reject(err); }
    });
  });
}

export async function joinGame(id, hostId, name) {
  role = 'client';
  playerName = (name || 'Gracz').slice(0, 16);
  lobbyId = id;
  hostPeerId = hostId;
  welcomed = false;
  lastSnapshotSeq = -1;
  return new Promise((resolve, reject) => {
    let opened = false;
    try {
      peer = new Peer();
    } catch (e) {
      role = 'menu';
      status('Sieć niedostępna', 'err');
      reject(e);
      return;
    }
    peer.on('open', (pid) => {
      if (opened) return;
      opened = true;
      playerId = pid;
      const conn = peer.connect(hostId, { reliable: true });
      hostConn = conn;
      welcomeTimer = setTimeout(() => {
        if (!welcomed) {
          status('Brak odpowiedzi hosta', 'err');
          reject(new Error('welcome timeout'));
        }
      }, 10000);
      conn.on('open', () => {
        safeSend(conn, { t: 'hello', name: playerName });
      });
      conn.on('data', (msg) => {
        const wasWelcomed = welcomed;
        handleClientData(msg);
        if (!wasWelcomed && welcomed) resolve({ playerId, lobbyId });
      });
      conn.on('close', () => onHostLost());
      conn.on('error', () => {
        if (!welcomed) {
          status('Nie udało się połączyć', 'err');
          reject(new Error('connection error'));
        }
      });
    });
    peer.on('error', (err) => {
      status('Błąd sieci: ' + (err && err.type ? err.type : 'peer'), 'warn');
      if (!welcomed) { role = 'menu'; reject(err); }
    });
  });
}

export function startSolo(name) {
  role = 'solo';
  playerName = (name || 'Gracz').slice(0, 16);
  playerId = 'solo';
  lobbyId = 'solo-' + playerName;
  emit('net:role', { role: 'solo', playerId, lobbyId });
  subscribeWorldAndChat(lobbyId);
  status('Tryb solo', 'ok');
}

export function sendState(payload) {
  if (role !== 'client') return;
  safeSend(hostConn, { t: 'state', p: payload.p, ry: payload.ry, anim: payload.anim });
}

export function broadcastSnapshot(snapshot) {
  if (role !== 'host') return;
  const msg = { t: 'snapshot', players: snapshot.players, robots: snapshot.robots, seq: snapshot.seq };
  for (const [, conn] of connections) safeSend(conn, msg);
}

export function sendReq(kind, data) {
  if (role === 'client') {
    safeSend(hostConn, { t: 'req', kind, data });
  } else {
    emit('net:req', { fromPlayerId: playerId, kind, data });
  }
}

export function broadcastEvent(kind, data) {
  if (role !== 'host') return;
  const msg = { t: 'event', kind, data };
  for (const [, conn] of connections) safeSend(conn, msg);
}

export function broadcastRobotSay(robotId, text) {
  if (role === 'host') {
    const msg = { t: 'robot-say', robotId, text };
    for (const [, conn] of connections) safeSend(conn, msg);
    emit('net:robot-say', { robotId, text });
  } else if (role === 'solo') {
    emit('net:robot-say', { robotId, text });
  }
}

export function getRole() {
  return role;
}

export function getPlayerId() {
  return playerId;
}
