// Gzowo 2049 — Cloudflare Worker: ephemeral token minter for the Gemini Live API.
// ONE model for everything (speech-in, intents, voice-out):
// gemini-3.1-flash-live-preview, connected directly from the browser over
// WebSocket using short-lived single-use tokens minted here. The real API key
// lives ONLY in this Worker's encrypted secret store.
//
// Endpoints:
//   GET  /health -> { ok: true }
//   POST /token  -> { token } (uses:1, 2-min new-session window, 30-min expiry)

const GEMINI_TOKEN_ENDPOINT = 'https://generativelanguage.googleapis.com/v1alpha/auth_tokens';
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 12;
const rateBuckets = new Map();

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
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors },
  });
}

function rateAllowed(request) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const now = Date.now();
  if (rateBuckets.size > 1000) {
    for (const [key, value] of rateBuckets) {
      if (now - value.start >= RATE_WINDOW_MS) rateBuckets.delete(key);
    }
  }
  const current = rateBuckets.get(ip);
  if (!current || now - current.start >= RATE_WINDOW_MS) {
    rateBuckets.set(ip, { start: now, count: 1 });
    return true;
  }
  current.count += 1;
  return current.count <= RATE_MAX;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin, env);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (url.pathname === '/health') return json({ ok: true }, 200, cors);

    if (url.pathname === '/token' && request.method === 'POST') {
      if (!env.GEMINI_API_KEY) return json({ error: 'GEMINI_API_KEY not configured' }, 503, cors);
      if (!rateAllowed(request)) return json({ error: 'rate limit exceeded' }, 429, cors);

      // Unlocked single-use token (v1alpha auth_tokens rejects
      // liveConnectConstraints — lesson from Gzowo AI). Short windows keep the
      // exposure small: 2 min to open a session, 30 min hard expiry.
      const now = Date.now();
      let upstream;
      try {
        upstream = await fetch(GEMINI_TOKEN_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
          body: JSON.stringify({
            uses: 1,
            expireTime: new Date(now + 30 * 60 * 1000).toISOString(),
            newSessionExpireTime: new Date(now + 2 * 60 * 1000).toISOString(),
          }),
        });
      } catch (err) {
        return json({ error: `upstream fetch failed: ${err.message}` }, 502, cors);
      }
      const text = await upstream.text();
      if (!upstream.ok) return json({ error: text.slice(0, 400) }, upstream.status, cors);
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        return json({ error: 'token endpoint returned non-JSON' }, 501, cors);
      }
      if (!data.name) return json({ error: 'token endpoint returned no name' }, 501, cors);
      return json({ token: data.name }, 200, cors);
    }

    return json({ error: 'not found' }, 404, cors);
  },
};
