// ai.js — voice/chat command pipeline: SpeechRecognition mic, Worker /intent, intent dispatch, TTS with speechSynthesis fallback + subtitles.
import { bus, state, getNearestRobotId, getAIContext } from './game.js';
import { sendReq } from './multiplayer.js';
import { sendChat } from './database.js';

const WORKER_URL = 'https://gzowo-2049-worker.gzowo.workers.dev';
const ACTIONS = new Set(['MOVE_TO', 'FOLLOW_PLAYER', 'DESTROY_WALL', 'REPAIR_WALL', 'ARREST', 'ADD_WANTED', 'REMOVE_WANTED', 'PATROL', 'GUARD', 'SAY', 'GIVE_ITEM', 'TAKE_ITEM', 'DANCE', 'STOP', 'UNKNOWN']);

let currentLobbyId = null;
let recognition = null;
let listening = false;
let retriedLang = false;
let finalTranscript = '';
let micTimeout = null;
let ttsUnavailable = false;
let subtitleTimer = null;
const ttsCache = new Map();
const ttsCacheOrder = [];

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

export async function requestIntent(prompt, context) {
  const fallback = { action: 'UNKNOWN', target: '', params: {}, say: '' };
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12000);
    const res = await fetch(WORKER_URL + '/intent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, context }),
      signal: ctrl.signal
    });
    clearTimeout(t);
    if (!res.ok) { status('AI niedostępne', 'warn'); return fallback; }
    const data = await res.json();
    const intent = data && data.intent ? data.intent : data;
    const action = intent && ACTIONS.has(intent.action) ? intent.action : 'UNKNOWN';
    return {
      action,
      target: typeof intent.target === 'string' ? intent.target : '',
      params: intent && typeof intent.params === 'object' && intent.params ? intent.params : {},
      say: typeof intent.say === 'string' ? intent.say : ''
    };
  } catch (e) {
    status('AI niedostępne', 'warn');
    return fallback;
  }
}

async function handleUtterance(rawText) {
  const text = String(rawText || '').trim();
  if (!text) return;
  const name = state.playerName || 'Gracz';
  sendChat(state.lobbyId || currentLobbyId, name, text);
  const robotId = getNearestRobotId(12);
  if (!robotId) {
    showSubtitle('Podejdź bliżej robota', 3);
    return;
  }
  const context = getAIContext(robotId);
  const intent = await requestIntent(text, context);
  bus.dispatchEvent(new CustomEvent('ai:intent', { detail: { robotId, intent } }));
  sendReq('intent', { robotId, intent });
}

function stopMic() {
  if (recognition) { try { recognition.stop(); } catch (e) {} }
}

function startMic(lang) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return;
  finalTranscript = '';
  recognition = new SR();
  recognition.lang = lang || 'pl-PL';
  recognition.interimResults = true;
  recognition.continuous = false;
  recognition.maxAlternatives = 1;

  recognition.onstart = () => {
    listening = true;
    const btn = document.getElementById('mic-btn');
    if (btn) btn.classList.add('listening');
    bus.dispatchEvent(new CustomEvent('ai:listening', { detail: { active: true } }));
    if (micTimeout) clearTimeout(micTimeout);
    micTimeout = setTimeout(stopMic, 8000);
  };

  recognition.onresult = (ev) => {
    let interim = '';
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const r = ev.results[i];
      if (r.isFinal) finalTranscript += r[0].transcript;
      else interim += r[0].transcript;
    }
    if (interim) {
      bus.dispatchEvent(new CustomEvent('ai:listening', { detail: { active: true, interim } }));
      showSubtitle(interim, 3);
    }
  };

  recognition.onerror = (ev) => {
    if (ev && ev.error === 'language-not-supported' && !retriedLang) {
      retriedLang = true;
      try { recognition.abort(); } catch (e) {}
      startMic('en-US');
    }
  };

  recognition.onend = () => {
    listening = false;
    const btn = document.getElementById('mic-btn');
    if (btn) btn.classList.remove('listening');
    if (micTimeout) { clearTimeout(micTimeout); micTimeout = null; }
    bus.dispatchEvent(new CustomEvent('ai:listening', { detail: { active: false } }));
    const t = finalTranscript.trim();
    finalTranscript = '';
    if (t) handleUtterance(t);
  };

  try { recognition.start(); } catch (e) {}
}

function toggleMic() {
  if (listening) { stopMic(); return; }
  retriedLang = false;
  startMic('pl-PL');
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

function cacheTts(key, uri) {
  ttsCache.set(key, uri);
  ttsCacheOrder.push(key);
  while (ttsCacheOrder.length > 10) {
    const old = ttsCacheOrder.shift();
    ttsCache.delete(old);
  }
}

export async function speak(robotName, text) {
  const clean = String(text || '').trim();
  if (!clean) return;
  showSubtitle((robotName ? robotName + ': ' : '') + clean, clean.length * 0.06);

  const key = djb2(robotName + '|' + clean).toString(36);
  if (ttsCache.has(key)) {
    try { new Audio(ttsCache.get(key)).play().catch(() => {}); return; } catch (e) {}
  }

  if (ttsUnavailable) { fallbackSpeak(robotName, clean); return; }

  try {
    const res = await fetch(WORKER_URL + '/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: clean, voice: robotName })
    });
    if (res.status === 200) {
      const data = await res.json();
      if (data && data.audio) {
        const uri = 'data:' + (data.mime || 'audio/mpeg') + ';base64,' + data.audio;
        cacheTts(key, uri);
        try { await new Audio(uri).play(); } catch (e) { fallbackSpeak(robotName, clean); }
        return;
      }
      fallbackSpeak(robotName, clean);
      return;
    }
    if (res.status === 501) ttsUnavailable = true;
    fallbackSpeak(robotName, clean);
  } catch (e) {
    fallbackSpeak(robotName, clean);
  }
}

export function initAI() {
  bus.addEventListener('net:role', (e) => {
    const d = e.detail || {};
    if (d.lobbyId) currentLobbyId = d.lobbyId;
  });

  bus.addEventListener('net:robot-say', (e) => {
    const d = e.detail || {};
    if (!d || !d.text) return;
    const dist = robotDistanceToPlayer(d.robotId);
    if (dist !== null && dist > 30) return;
    const r = state.robots && state.robots.get ? state.robots.get(d.robotId) : null;
    const name = r && r.name ? r.name : (d.robotId || 'ROBOT');
    speak(name, d.text);
  });

  const chatForm = document.getElementById('chat-form');
  if (chatForm) {
    chatForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const input = document.getElementById('chat-input');
      if (!input) return;
      const text = input.value.trim();
      input.value = '';
      if (text) handleUtterance(text);
    });
  }

  const micBtn = document.getElementById('mic-btn');
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
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
