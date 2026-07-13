// Gzowo 2049 — Cloudflare Worker proxy for the Gemini API.
// The browser never sees the API key: the game calls this Worker, the Worker
// calls Gemini with the secret key and relays the response.
//
// Endpoints:
//   GET  /health          -> { ok: true }
//   POST /intent          -> body { prompt, context? }  ->  Gemini JSON intent
//   POST /tts             -> body { text, voice? }      ->  { audio: base64 PCM, mime } | 501
//
// Models are pinned server-side so clients cannot burn quota on arbitrary ones.

// Tried in order — first available wins. 3.5 sometimes 503s on demand spikes;
// 2.x models 404 for new API keys, so the chain sticks to 3.x + -latest alias.
const INTENT_MODELS = ['gemini-3.5-flash', 'gemini-3-flash-preview', 'gemini-flash-latest', 'gemini-3.1-flash-lite'];
const TTS_MODEL = 'gemini-3.1-flash-tts-preview';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const MAX_BODY_BYTES = 20_000;

const INTENT_SYSTEM = `You are the intent parser for "Gzowo 2049", a multiplayer 3D city game with AI robots.
Convert the player's spoken/typed instruction into ONE JSON object:
{"action": "<ACTION>", "target": "<id or name or null>", "params": {…}, "say": "<short in-character robot reply, same language as the player>"}
Allowed actions: MOVE_TO, FOLLOW_PLAYER, DESTROY_WALL, REPAIR_WALL, ARREST, ADD_WANTED, REMOVE_WANTED, PATROL, GUARD, SAY, GIVE_ITEM, TAKE_ITEM, DANCE, STOP, UNKNOWN.
Use the provided world context (robot roles, wall ids, wanted list, player names) to resolve targets.
If the instruction is not an actionable command, use action "SAY" with a conversational reply.
Reply with JSON only.`;

function corsHeaders(origin, env) {
  const allowed = (env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim());
  const ok = allowed.includes('*') || allowed.includes(origin);
  return {
    'Access-Control-Allow-Origin': ok ? origin || '*' : allowed[0],
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function json(body, status, cors) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

async function callGeminiWithFallback(env, models, payload) {
  let lastErr;
  for (const model of models) {
    try {
      return await callGemini(env, model, payload);
    } catch (err) {
      lastErr = err;
      if (!/-> (400|404|429|500|503):/.test(String(err.message))) throw err;
    }
  }
  throw lastErr;
}

async function callGemini(env, model, payload) {
  const res = await fetch(`${GEMINI_BASE}/${model}:generateContent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': env.GEMINI_API_KEY,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gemini ${model} -> ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin, env);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (url.pathname === '/health') return json({ ok: true }, 200, cors);
    if (request.method !== 'POST') return json({ error: 'POST only' }, 405, cors);

    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return json({ error: 'body too large' }, 413, cors);
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return json({ error: 'invalid JSON' }, 400, cors);
    }

    try {
      if (url.pathname === '/intent') {
        const prompt = String(body.prompt || '').slice(0, 2000);
        const context = (typeof body.context === 'string'
          ? body.context
          : JSON.stringify(body.context || '')).slice(0, 8000);
        if (!prompt) return json({ error: 'prompt required' }, 400, cors);
        const data = await callGeminiWithFallback(env, INTENT_MODELS, {
          systemInstruction: { parts: [{ text: INTENT_SYSTEM }] },
          contents: [{ role: 'user', parts: [{ text: `WORLD CONTEXT:\n${context}\n\nPLAYER SAYS:\n${prompt}` }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0.4,
            maxOutputTokens: 2048,
            thinkingConfig: { thinkingBudget: 0 },
          },
        });
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
        let intent;
        try {
          intent = JSON.parse(text);
        } catch {
          intent = { action: 'UNKNOWN', target: null, params: {}, say: text.slice(0, 200) };
        }
        return json({ intent }, 200, cors);
      }

      if (url.pathname === '/tts') {
        const text = String(body.text || '').slice(0, 500);
        if (!text) return json({ error: 'text required' }, 400, cors);
        const data = await callGemini(env, TTS_MODEL, {
          contents: [{ role: 'user', parts: [{ text }] }],
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: body.voice
              ? { voiceConfig: { prebuiltVoiceConfig: { voiceName: String(body.voice).slice(0, 40) } } }
              : undefined,
          },
        });
        const part = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
        if (!part) return json({ error: 'no audio returned' }, 501, cors);
        return json({ audio: part.inlineData.data, mime: part.inlineData.mimeType }, 200, cors);
      }

      return json({ error: 'not found' }, 404, cors);
    } catch (err) {
      return json({ error: String(err.message || err).slice(0, 400) }, 502, cors);
    }
  },
};
