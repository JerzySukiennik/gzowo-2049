// ai.js — single-model Gemini Live pipeline: one WebSocket session handles speech understanding, intent (robot_action tool) and native robot voice. Mic streaming in, PCM audio out, live subtitles, conversation-freeze signalling, speechSynthesis fallback for remote robot lines.
import { GoogleGenAI, Modality, Type } from '@google/genai';
import { bus, state, getNearestRobotId, getAIContext } from './game.js';
import { sendReq, broadcastRobotSay } from './multiplayer.js';
import { sendChat } from './database.js';

const WORKER_URL = 'https://gzowo-2049-worker.gzowo.workers.dev';
const MODEL = 'gemini-3.1-flash-live-preview';
const ACTION_ENUM = ['MOVE_TO', 'FOLLOW_PLAYER', 'DESTROY_WALL', 'REPAIR_WALL', 'ARREST', 'ADD_WANTED', 'REMOVE_WANTED', 'PATROL', 'GUARD', 'SAY', 'GIVE_ITEM', 'TAKE_ITEM', 'DANCE', 'STOP'];
const ACTIONS = new Set(ACTION_ENUM);
const IN_RATE = 16000;
const OUT_RATE = 24000;

const SYSTEM_INSTRUCTION = [
  'You are the voice of the autonomous robots living in the cyber-city of "Gzowo 2049", a live multiplayer 3D game.',
  'At any moment you speak AS ONE specific robot. Each turn a WORLD CONTEXT line tells you which robot you are (name, role, memory, surroundings) and who is talking to you. Stay fully in character as that robot.',
  'You are powered by Google Gemini model gemini-3.1-flash-live-preview — if the player asks which AI, model, or language model you are, say exactly that.',
  'ALWAYS answer with a SHORT, natural spoken line in Polish (one or two sentences, in character). Technical terms may stay in English. Never read JSON, never describe your tools, never break character.',
  'When the player asks you to DO something in the world (move, follow, guard, patrol, destroy or repair a wall, arrest someone, add or remove a wanted status, dance, give or take an item, stop), you MUST call the robot_action tool with the right action, and also say a short spoken confirmation. If the player is only chatting, just speak.',
  'Police robots can arrest and manage wanted lists; civilian robots cannot and should refuse such orders in character.'
].join(' ');

const TOOLS = [{
  functionDeclarations: [{
    name: 'robot_action',
    description: 'Execute a game action for the robot you are currently voicing. Call whenever the player asks the robot to do something in the world.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        action: { type: Type.STRING, enum: ACTION_ENUM, description: 'The action to perform.' },
        target: { type: Type.STRING, description: 'Target: a player or robot name, a place (main_square, prison), a wall id, or an item. Empty when not applicable.' },
        params: {
          type: Type.OBJECT,
          description: 'Optional extra parameters.',
          properties: {
            x: { type: Type.NUMBER, description: 'World X for a point target.' },
            z: { type: Type.NUMBER, description: 'World Z for a point target.' },
            item: { type: Type.STRING, description: 'Item name for GIVE_ITEM / TAKE_ITEM.' }
          }
        }
      },
      required: ['action']
    }
  }]
}];

let currentLobbyId = null;
let genai = null;
let session = null;
let sessionOpening = null;

let micActive = false;
let micStream = null;
let micCtx = null;
let micProc = null;
let micSource = null;
let micSink = null;

let playbackCtx = null;
let playHead = 0;
let scheduledSources = [];

let inputTranscriptBuf = '';
let outputTranscriptBuf = '';
let subtitleTimer = null;

const locallySpoken = new Map();

let convRobotId = null;
let convActive = false;
let convOffTimer = null;
const convReasons = { input: false, mic: false, reply: false };

function status(text, level) {
  bus.dispatchEvent(new CustomEvent('ui:status', { detail: { text, level } }));
}

function djb2(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h;
}

function showSubtitle(text, holdSec) {
  const el = document.getElementById('subtitles');
  if (!el) return;
  el.textContent = text;
  if (subtitleTimer) clearTimeout(subtitleTimer);
  subtitleTimer = setTimeout(() => { el.textContent = ''; }, Math.max(3, holdSec || 3) * 1000);
}

function bytesToBase64(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function resampleTo16k(float32, inRate) {
  if (!inRate || inRate === IN_RATE) return float32;
  const ratio = inRate / IN_RATE;
  const outLen = Math.max(1, Math.round(float32.length / ratio));
  const out = new Float32Array(outLen);
  const last = float32.length - 1;
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = i0 < last ? i0 + 1 : last;
    const frac = pos - i0;
    out[i] = float32[i0] * (1 - frac) + float32[i1] * frac;
  }
  return out;
}

function floatTo16Bytes(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    let s = float32[i];
    if (s > 1) s = 1; else if (s < -1) s = -1;
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return new Uint8Array(out.buffer);
}

export async function checkHealth() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(WORKER_URL + '/health', { signal: ctrl.signal });
    clearTimeout(t);
    const data = await res.json();
    return !!(data && data.ok);
  } catch (e) {
    return false;
  }
}

async function fetchToken() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  const res = await fetch(WORKER_URL + '/token', { method: 'POST', signal: ctrl.signal });
  clearTimeout(t);
  if (!res.ok) throw new Error('token http ' + res.status);
  const data = await res.json();
  if (!data || !data.token) throw new Error('no token');
  return data.token;
}

function buildConfig() {
  return {
    responseModalities: [Modality.AUDIO],
    speechConfig: { languageCode: 'pl-PL' },
    systemInstruction: SYSTEM_INSTRUCTION,
    tools: TOOLS,
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    contextWindowCompression: { slidingWindow: {} }
  };
}

function dropSession() {
  if (session) { try { session.close(); } catch (e) {} }
  session = null;
  sessionOpening = null;
  stopPlayback();
}

async function ensureSession() {
  if (session) return session;
  if (sessionOpening) return sessionOpening;
  sessionOpening = (async () => {
    status('AI łączy się…', 'warn');
    let token;
    try {
      token = await fetchToken();
    } catch (e) {
      status('AI offline', 'err');
      sessionOpening = null;
      throw e;
    }
    try {
      genai = new GoogleGenAI({ apiKey: token, httpOptions: { apiVersion: 'v1alpha' } });
      const s = await genai.live.connect({
        model: MODEL,
        config: buildConfig(),
        callbacks: {
          onopen: () => status('AI online', 'ok'),
          onmessage: onServerMessage,
          onerror: () => { status('AI offline', 'err'); dropSession(); },
          onclose: () => { status('AI offline', 'warn'); session = null; sessionOpening = null; }
        }
      });
      session = s;
    } catch (e) {
      status('AI offline', 'err');
      session = null;
      sessionOpening = null;
      throw e;
    }
    sessionOpening = null;
    return session;
  })();
  return sessionOpening;
}

function ensurePlaybackCtx() {
  if (!playbackCtx) playbackCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (playbackCtx.state === 'suspended') { try { playbackCtx.resume(); } catch (e) {} }
  return playbackCtx;
}

function queueAudio(b64) {
  const ctx = ensurePlaybackCtx();
  const bytes = base64ToBytes(b64);
  const samples = bytes.length >> 1;
  if (samples <= 0) return;
  const buf = ctx.createBuffer(1, samples, OUT_RATE);
  const ch = buf.getChannelData(0);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < samples; i++) ch[i] = dv.getInt16(i * 2, true) / 32768;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  const now = ctx.currentTime;
  if (playHead < now) playHead = now;
  src.start(playHead);
  playHead += buf.duration;
  scheduledSources.push(src);
  setReplyPlaying(true);
  src.onended = () => {
    const i = scheduledSources.indexOf(src);
    if (i >= 0) scheduledSources.splice(i, 1);
    if (scheduledSources.length === 0) setReplyPlaying(false);
  };
}

function stopPlayback() {
  for (const src of scheduledSources) { try { src.stop(); } catch (e) {} }
  scheduledSources = [];
  if (playbackCtx) playHead = playbackCtx.currentTime;
  setReplyPlaying(false);
}

function markLocallySpoken(key) {
  locallySpoken.set(key, Date.now());
  setTimeout(() => locallySpoken.delete(key), 6000);
}

let serverMsgCount = 0;

function onServerMessage(message) {
  serverMsgCount++;
  if (window.__AI_DEBUG) window.__AI_DEBUG.push('MSG:' + Object.keys(message || {}).join(','));
  if (!message) return;
  const sc = message.serverContent;
  if (sc) {
    if (sc.inputTranscription && sc.inputTranscription.text) {
      inputTranscriptBuf += sc.inputTranscription.text;
      showSubtitle(inputTranscriptBuf, 3);
    }
    if (sc.outputTranscription && sc.outputTranscription.text) {
      outputTranscriptBuf += sc.outputTranscription.text;
    }
    if (sc.modelTurn && sc.modelTurn.parts) {
      for (const part of sc.modelTurn.parts) {
        if (part.inlineData && part.inlineData.data) queueAudio(part.inlineData.data);
      }
    }
    if (sc.interrupted) stopPlayback();
    if (sc.turnComplete) finishReply();
  }
  if (message.toolCall && message.toolCall.functionCalls) {
    for (const fc of message.toolCall.functionCalls) handleToolCall(fc);
  }
}

function handleToolCall(fc) {
  const args = (fc && fc.args) || {};
  const action = ACTIONS.has(args.action) ? args.action : 'UNKNOWN';
  const intent = {
    action,
    target: typeof args.target === 'string' ? args.target : '',
    params: (args.params && typeof args.params === 'object') ? args.params : {},
    say: ''
  };
  const robotId = convRobotId || getNearestRobotId(12);
  if (robotId && action !== 'UNKNOWN') {
    sendReq('intent', { robotId, intent });
  }
  if (session) {
    try { session.sendToolResponse({ functionResponses: [{ id: fc.id, name: fc.name, response: { ok: true } }] }); } catch (e) {}
  }
}

function finishReply() {
  const text = outputTranscriptBuf.trim();
  outputTranscriptBuf = '';
  inputTranscriptBuf = '';
  if (!text) return;
  const rid = convRobotId || getNearestRobotId(12);
  const r = rid && state.robots.get ? state.robots.get(rid) : null;
  const name = r ? r.name : (rid || 'ROBOT');
  showSubtitle(name + ': ' + text, Math.max(3, text.length * 0.06));
  bus.dispatchEvent(new CustomEvent('chat:incoming', { detail: { from: name, text } }));
  if (rid) {
    markLocallySpoken(rid + '|' + text);
    broadcastRobotSay(rid, text);
    bus.dispatchEvent(new CustomEvent('ai:robot-reply', { detail: { robotId: rid, text } }));
  }
}

function contextHeader(rid) {
  const r = state.robots.get ? state.robots.get(rid) : null;
  const ctx = getAIContext(rid);
  const name = r ? r.name : rid;
  const role = r ? r.role : 'civilian';
  const playerName = state.playerName || 'Gracz';
  return 'WORLD CONTEXT: ' + JSON.stringify(ctx) + ' — you are now speaking AS robot ' + name + ' (' + role + '). Player ' + playerName + ' says:';
}

async function handleTextUtterance(rawText, isRetry) {
  if (window.__AI_DEBUG) window.__AI_DEBUG.push('UTTER:' + rawText + (isRetry ? ' (retry)' : ''));
  const text = String(rawText || '').trim();
  if (!text) return;
  const rid = convRobotId || getNearestRobotId(12);
  if (!rid) { showSubtitle('Podejdź bliżej robota', 3); return; }
  convRobotId = rid;
  if (!isRetry) sendChat(state.lobbyId || currentLobbyId, state.playerName || 'Gracz', text);
  let s;
  try { s = await ensureSession(); } catch (e) { showSubtitle('AI niedostępne', 3); return; }
  try {
    s.sendClientContent({ turns: [{ role: 'user', parts: [{ text: contextHeader(rid) + ' ' + text }] }], turnComplete: true });
    if (window.__AI_DEBUG) window.__AI_DEBUG.push('SENT to session');
    // Zombie-session watchdog: a Live socket can die without onclose firing.
    // If the server stays completely silent after a send, rebuild the session
    // once and resend — better one duplicate than a mute robot.
    const c0 = serverMsgCount;
    setTimeout(() => {
      if (serverMsgCount === c0 && !isRetry) {
        if (window.__AI_DEBUG) window.__AI_DEBUG.push('WATCHDOG: silent session, reconnecting');
        dropSession();
        handleTextUtterance(text, true);
      }
    }, 8000);
  } catch (e) {
    if (window.__AI_DEBUG) window.__AI_DEBUG.push('SEND_ERR:' + e.message);
    dropSession();
    showSubtitle('AI niedostępne', 3);
  }
}

async function startMic() {
  if (micActive) return;
  let s;
  try { s = await ensureSession(); } catch (e) { return; }
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  } catch (e) {
    status('Brak dostępu do mikrofonu', 'warn');
    return;
  }
  const rid = convRobotId || getNearestRobotId(12);
  if (rid) convRobotId = rid;

  micCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: IN_RATE });
  if (micCtx.state === 'suspended') { try { await micCtx.resume(); } catch (e) {} }
  // Safari/iOS ignores the sampleRate constructor hint and runs at the hardware
  // rate (often 48 kHz). Trust the context's real rate, not the requested one.
  const micRate = micCtx.sampleRate || IN_RATE;
  micSource = micCtx.createMediaStreamSource(micStream);
  micProc = micCtx.createScriptProcessor(4096, 1, 1);
  micSink = micCtx.createGain();
  micSink.gain.value = 0;
  micSource.connect(micProc);
  micProc.connect(micSink);
  micSink.connect(micCtx.destination);
  micProc.onaudioprocess = (ev) => {
    if (!micActive || !session) return;
    const input = ev.inputBuffer.getChannelData(0);
    const pcm = resampleTo16k(input, micRate);
    try {
      session.sendRealtimeInput({ audio: { data: bytesToBase64(floatTo16Bytes(pcm)), mimeType: 'audio/pcm;rate=' + IN_RATE } });
    } catch (e) {}
  };

  micActive = true;
  const btn = document.getElementById('mic-btn');
  if (btn) btn.classList.add('listening');

  if (rid) {
    try { s.sendClientContent({ turns: [{ role: 'user', parts: [{ text: contextHeader(rid) }] }], turnComplete: false }); } catch (e) {}
  }
  convReasons.mic = true;
  updateConversation();
}

function stopMic() {
  if (!micActive) return;
  micActive = false;
  const btn = document.getElementById('mic-btn');
  if (btn) btn.classList.remove('listening');
  if (session) {
    try { session.sendRealtimeInput({ audioStreamEnd: true }); } catch (e) {}
  }
  if (micProc) { try { micProc.disconnect(); } catch (e) {} micProc.onaudioprocess = null; micProc = null; }
  if (micSource) { try { micSource.disconnect(); } catch (e) {} micSource = null; }
  if (micSink) { try { micSink.disconnect(); } catch (e) {} micSink = null; }
  if (micStream) { for (const tr of micStream.getTracks()) { try { tr.stop(); } catch (e) {} } micStream = null; }
  if (micCtx) { try { micCtx.close(); } catch (e) {} micCtx = null; }
  convReasons.mic = false;
  updateConversation();
}

function toggleMic() {
  if (micActive) stopMic(); else startMic();
}

function setReplyPlaying(active) {
  if (convReasons.reply === active) return;
  convReasons.reply = active;
  updateConversation();
}

function updateConversation() {
  const any = convReasons.input || convReasons.mic || convReasons.reply;
  if (any) {
    if (convOffTimer) { clearTimeout(convOffTimer); convOffTimer = null; }
    if (!convActive) {
      const rid = convRobotId || getNearestRobotId(12);
      if (!rid) return;
      convRobotId = rid;
      convActive = true;
      bus.dispatchEvent(new CustomEvent('ai:conversation', { detail: { active: true, robotId: rid } }));
    }
  } else {
    if (!convActive || convOffTimer) return;
    convOffTimer = setTimeout(() => {
      convOffTimer = null;
      const rid = convRobotId;
      convActive = false;
      convRobotId = null;
      bus.dispatchEvent(new CustomEvent('ai:conversation', { detail: { active: false, robotId: rid } }));
    }, 2000);
  }
}

function robotDistanceToPlayer(robotId) {
  const r = state.robots && state.robots.get ? state.robots.get(robotId) : null;
  if (!r || !r.p || !state.player || !state.player.p) return null;
  const dx = r.p.x - state.player.p.x;
  const dz = r.p.z - state.player.p.z;
  return Math.hypot(dx, dz);
}

function fallbackSpeak(robotName, text) {
  if (!('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  const h = djb2(robotName || 'robot');
  u.pitch = 0.6 + (h % 100) / 100 * 0.9;
  u.rate = 0.85 + ((h >> 7) % 100) / 100 * 0.5;
  u.lang = 'pl-PL';
  const voices = window.speechSynthesis.getVoices() || [];
  const pl = voices.find((v) => v.lang && v.lang.toLowerCase().startsWith('pl'));
  if (pl) u.voice = pl;
  try { window.speechSynthesis.cancel(); window.speechSynthesis.speak(u); } catch (e) {}
}

export function initAI() {
  bus.addEventListener('net:role', (e) => {
    const d = e.detail || {};
    if (d.lobbyId) currentLobbyId = d.lobbyId;
  });

  bus.addEventListener('net:robot-say', (e) => {
    const d = e.detail || {};
    if (!d.text) return;
    const key = (d.robotId || '') + '|' + d.text;
    if (locallySpoken.has(key)) { locallySpoken.delete(key); return; }
    const dist = robotDistanceToPlayer(d.robotId);
    if (dist !== null && dist > 30) return;
    const r = state.robots && state.robots.get ? state.robots.get(d.robotId) : null;
    const name = r && r.name ? r.name : (d.robotId || 'ROBOT');
    fallbackSpeak(name, d.text);
  });

  const chatForm = document.getElementById('chat-form');
  if (chatForm) {
    chatForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const input = document.getElementById('chat-input');
      if (!input) return;
      const text = input.value.trim();
      input.value = '';
      if (text) handleTextUtterance(text);
    });
  }

  const chatInput = document.getElementById('chat-input');
  if (chatInput) {
    chatInput.addEventListener('focus', () => {
      const rid = getNearestRobotId(12);
      if (rid) convRobotId = rid;
      convReasons.input = true;
      updateConversation();
    });
    chatInput.addEventListener('blur', () => {
      convReasons.input = false;
      updateConversation();
    });
  }

  const micBtn = document.getElementById('mic-btn');
  const hasMic = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  if (!hasMic) {
    if (micBtn) micBtn.classList.add('hidden');
    status('Mikrofon niedostępny — pisz w czacie', 'warn');
  } else if (micBtn) {
    micBtn.addEventListener('click', toggleMic);
  }

  if ('speechSynthesis' in window) {
    try { window.speechSynthesis.getVoices(); } catch (e) {}
  }

  checkHealth().then((ok) => {
    if (ok) status('AI online', 'ok');
    else status('AI offline — komendy ograniczone', 'warn');
  });
}
