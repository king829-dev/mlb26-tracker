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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const uid = sanitizeUid(url.searchParams.get('uid'));

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
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
      const script = SYNC_SCRIPT.replace('__ORIGIN__', url.origin).replace('__UID__', uid || '');
      return new Response(script, { headers: { 'Content-Type': 'application/javascript; charset=utf-8', ...CORS } });
    }

    // Serve the tracker app
    return new Response(APP_HTML, {
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' },
    });
  },
};
