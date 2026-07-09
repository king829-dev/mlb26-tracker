import APP_HTML from './app.html';
import { SYNC_SCRIPT } from '../../shared/sync-script.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'no-store',
};

// Multi-tenant support: each browser/user gets an opaque uid (generated client-side).
// Requests with no uid fall back to the original unscoped keys (the primary/legacy user).
// uid is sanitized to a safe KV key suffix — alphanumeric only, capped length.
function sanitizeUid(raw) {
  if (!raw) return null;
  const clean = String(raw).replace(/[^a-zA-Z0-9]/g, '').slice(0, 40);
  return clean || null;
}
function kvKey(base, uid) {
  return uid ? `${base}_${uid}` : base;
}

// Writes are rate-limited per source IP to prevent a flood of requests from burning through
// the (limited, free-tier) daily KV write quota. Not configurable per-deployment beyond these
// constants — edit here and redeploy if you need a different limit.
const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_SECONDS = 600; // 10 minutes
async function checkRateLimit(env, ip) {
  const key = `ratelimit_${ip}`;
  const raw = await env.INVENTORY.get(key);
  const count = raw ? parseInt(raw, 10) : 0;
  if (count >= RATE_LIMIT_MAX) return false;
  await env.INVENTORY.put(key, String(count + 1), { expirationTtl: RATE_LIMIT_WINDOW_SECONDS });
  return true;
}

// If a SYNC_KEY secret is configured (`wrangler secret put SYNC_KEY`), writes must include a
// matching X-Sync-Key header — the served /sync.js script embeds this automatically, so this
// is invisible to legitimate users but rejects requests sent directly to the endpoint by
// anyone who hasn't first loaded the sync script from this deployment. If no SYNC_KEY secret
// is set, this check is skipped (unauthenticated, matching this project's original behavior).
function checkSyncKey(request, env) {
  if (!env.SYNC_KEY) return true;
  return request.headers.get('X-Sync-Key') === env.SYNC_KEY;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const uid = sanitizeUid(url.searchParams.get('uid'));

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    if (request.method === 'POST' && (url.pathname === '/ingest-programs' || url.pathname === '/ingest-general-programs')) {
      if (!checkSyncKey(request, env)) {
        return Response.json({ error: 'Invalid or missing sync key' }, { status: 401, headers: CORS });
      }
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      if (!(await checkRateLimit(env, ip))) {
        return Response.json({ error: 'Rate limit exceeded — try again later' }, { status: 429, headers: CORS });
      }
    }

    // POST /ingest-programs — receive program progress scraped from theshow.com
    if (url.pathname === '/ingest-programs' && request.method === 'POST') {
      try {
        const data = await request.json();
        if (!data.teams || Object.keys(data.teams).length === 0) {
          return Response.json({ error: 'Refusing to save empty teams — likely scraped from the wrong tab' }, { status: 400, headers: CORS });
        }
        // Rotate current → prev before overwriting
        const current = await env.INVENTORY.get(kvKey('programs', uid));
        if (current) await env.INVENTORY.put(kvKey('programs_prev', uid), current);
        await env.INVENTORY.put(kvKey('programs', uid), JSON.stringify({
          teams: data.teams,
          savedAt: data.savedAt || new Date().toISOString(),
        }));
        return Response.json({ ok: true, count: Object.keys(data.teams).length }, { headers: CORS });
      } catch (e) {
        return Response.json({ error: e.message }, { status: 500, headers: CORS });
      }
    }

    // GET /programs-data — serve stored program progress to the app
    if (url.pathname === '/programs-data') {
      const raw = await env.INVENTORY.get(kvKey('programs', uid));
      if (!raw) return Response.json({ teams: {}, savedAt: null }, { headers: CORS });
      return new Response(raw, { headers: { 'Content-Type': 'application/json', ...CORS } });
    }

    // GET /programs-prev — serve previous snapshot for delta tracking
    if (url.pathname === '/programs-prev') {
      const raw = await env.INVENTORY.get(kvKey('programs_prev', uid));
      if (!raw) return Response.json({ teams: {}, savedAt: null }, { headers: CORS });
      return new Response(raw, { headers: { 'Content-Type': 'application/json', ...CORS } });
    }

    // POST /ingest-general-programs — receive non-team-affinity program data
    if (url.pathname === '/ingest-general-programs' && request.method === 'POST') {
      try {
        const data = await request.json();
        if (!data.programs || Object.keys(data.programs).length === 0) {
          return Response.json({ error: 'Refusing to save empty programs — likely scraped from the wrong tab' }, { status: 400, headers: CORS });
        }
        await env.INVENTORY.put(kvKey('general_programs', uid), JSON.stringify({ programs: data.programs, savedAt: data.savedAt || new Date().toISOString() }));
        return Response.json({ ok: true, count: Object.keys(data.programs).length }, { headers: CORS });
      } catch(e) {
        return Response.json({ error: e.message }, { status: 500, headers: CORS });
      }
    }

    // GET /general-programs-data — serve stored general program data
    if (url.pathname === '/general-programs-data') {
      const raw = await env.INVENTORY.get(kvKey('general_programs', uid));
      if (!raw) return Response.json({ programs: {}, savedAt: null }, { headers: CORS });
      return new Response(raw, { headers: { 'Content-Type': 'application/json', ...CORS } });
    }

    // GET /sync.js — the sync script, loaded by the bookmarklet via <script src>
    if (url.pathname === '/sync.js') {
      const script = SYNC_SCRIPT.replace('__ORIGIN__', url.origin).replace('__UID__', uid || '').replace('__KEY__', env.SYNC_KEY || '');
      return new Response(script, { headers: { 'Content-Type': 'application/javascript; charset=utf-8', ...CORS } });
    }

    // Serve the tracker app
    return new Response(APP_HTML, {
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' },
    });
  },
};
