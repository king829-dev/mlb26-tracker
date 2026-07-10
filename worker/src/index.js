import APP_HTML from './app.html';
import { SYNC_SCRIPT } from '../../shared/sync-script.js';

// CORS for cross-origin routes only (ingest endpoints + /sync.js, called from theshow.com).
// Pinned to the game's domain rather than '*' since these are the only routes that need to be
// reachable from a page other than this deployment itself.
const CORS = {
  'Access-Control-Allow-Origin': 'https://mlb26.theshow.com',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Sync-Key',
  'Cache-Control': 'no-store',
};
// Read-only endpoints are only ever called same-origin by the dashboard itself — no CORS needed.
const NO_CORS = { 'Cache-Control': 'no-store' };

const MAX_BODY_BYTES = 2_000_000;

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

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// ── Snapshot history (Stage 3) ──────────────────────────────────────────────
// A rolling per-uid history of daily pct snapshots (teams + general programs), used by the
// dashboard for sparklines and pace/projection. Deliberately pct-only (not full mission
// detail) to keep the KV value small; capped at 60 entries (roughly 2 months of daily syncs).
const HISTORY_CAP = 60;

function teamMainPct(teamEntry) {
  if (!teamEntry || !Array.isArray(teamEntry.programs)) return null;
  const main = teamEntry.programs.find((p) => !(p.name || '').includes('#1 Fan'));
  return main && typeof main.pct === 'number' ? main.pct : null;
}

function buildTeamsPctMap(teamsObj) {
  const map = {};
  Object.keys(teamsObj || {}).forEach((key) => {
    const pct = teamMainPct(teamsObj[key]);
    if (pct !== null) map[key] = pct;
  });
  return map;
}

function buildProgramsPctMap(programsObj) {
  const map = {};
  Object.keys(programsObj || {}).forEach((key) => {
    const p = programsObj[key];
    if (p && typeof p.pct === 'number') map[key] = p.pct;
  });
  return map;
}

// Upserts today's entry (by date, derived from the ingest's savedAt) in the uid's history
// array, merging in whichever of teams/programs this call has fresh data for. Called once per
// completed sync "phase" — the final team batch (or a non-partial team replace), and separately
// the general-programs replace — so a single day's entry is built up across up to two calls.
async function appendHistory(env, uid, dateStr, teamsPctMap, programsPctMap) {
  const key = kvKey('history', uid);
  let hist;
  try {
    const raw = await env.INVENTORY.get(key);
    hist = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(hist)) hist = [];
  } catch (e) {
    hist = [];
  }
  // Look up by date anywhere in the array (not just the last entry) — a sync's two ingest calls
  // (teams, then general programs) are expected to land on the same date, but relying solely on
  // array-order would split them into duplicate entries if they ever arrive out of sequence.
  let entry = hist.find((e) => e.date === dateStr);
  if (!entry) {
    entry = { date: dateStr, teams: {}, programs: {} };
    hist.push(entry);
    hist.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    if (hist.length > HISTORY_CAP) hist = hist.slice(hist.length - HISTORY_CAP);
  }
  entry.teams = Object.assign({}, entry.teams, teamsPctMap);
  entry.programs = Object.assign({}, entry.programs, programsPctMap);
  await env.INVENTORY.put(key, JSON.stringify(hist));
}

// Reads and validates a JSON request body: enforces the size cap (via Content-Length, checked
// before parsing) and returns a tagged result so callers can map to the right HTTP status
// without ever echoing internal error detail back to the client.
async function readJsonBody(request) {
  const lengthHeader = request.headers.get('Content-Length');
  if (lengthHeader && Number(lengthHeader) > MAX_BODY_BYTES) {
    return { error: 'payload_too_large' };
  }
  let data;
  try {
    data = await request.json();
  } catch (e) {
    return { error: 'bad_json' };
  }
  if (!isPlainObject(data)) return { error: 'bad_json' };
  return { data };
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

// Constant-time string comparison (via the Workers runtime's crypto.subtle.timingSafeEqual) so
// that secret comparisons don't leak timing information about how many leading characters
// matched. Length is checked first since timingSafeEqual requires equal-length buffers — this
// leaks length, not content, which is an acceptable tradeoff here.
async function timingSafeEqualStr(a, b) {
  const enc = new TextEncoder();
  const aBuf = enc.encode(String(a ?? ''));
  const bBuf = enc.encode(String(b ?? ''));
  if (aBuf.byteLength !== bBuf.byteLength) return false;
  return await crypto.subtle.timingSafeEqual(aBuf, bBuf);
}

// If a SYNC_KEY secret is configured (`wrangler secret put SYNC_KEY`), writes must include a
// matching X-Sync-Key header. The bookmarklet sets window.__MLB26_SYNC_KEY before loading
// /sync.js, which reads it at runtime — the key itself is never embedded in the publicly
// fetchable /sync.js response (see GET /config below for how the dashboard learns the key).
// If no SYNC_KEY secret is set, this check is skipped (unauthenticated, matching this project's
// original behavior).
async function checkSyncKey(request, env) {
  if (!env.SYNC_KEY) return true;
  return await timingSafeEqualStr(request.headers.get('X-Sync-Key') || '', env.SYNC_KEY);
}

// If BASIC_AUTH_USER + BASIC_AUTH_PASS secrets are configured, the dashboard page and the
// data-read endpoints require an HTTP Basic Auth login (the browser shows its native
// username/password prompt). This is separate from SYNC_KEY: SYNC_KEY protects writes and is
// invisible/automatic via the sync script; Basic Auth protects reads and requires a person to
// type credentials, so it deliberately does NOT apply to /sync.js (loaded silently as a
// <script src> by the bookmarklet, which can't supply a password) or the ingest endpoints
// (already covered by SYNC_KEY). If the secrets aren't set, this check is skipped entirely.
async function checkBasicAuth(request, env) {
  if (!env.BASIC_AUTH_USER || !env.BASIC_AUTH_PASS) return true;
  const header = request.headers.get('Authorization') || '';
  if (!header.startsWith('Basic ')) return false;
  let decoded;
  try {
    decoded = atob(header.slice(6));
  } catch (e) {
    return false;
  }
  const idx = decoded.indexOf(':');
  if (idx === -1) return false;
  const user = decoded.slice(0, idx);
  const pass = decoded.slice(idx + 1);
  const userOk = await timingSafeEqualStr(user, env.BASIC_AUTH_USER);
  const passOk = await timingSafeEqualStr(pass, env.BASIC_AUTH_PASS);
  return userOk && passOk;
}
function unauthorizedResponse() {
  return new Response('Authentication required', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="MLB26 Tracker"', ...NO_CORS },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const uid = sanitizeUid(url.searchParams.get('uid'));

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const BASIC_AUTH_EXEMPT_PATHS = ['/sync.js', '/ingest-programs', '/ingest-general-programs'];
    if (!BASIC_AUTH_EXEMPT_PATHS.includes(url.pathname) && !(await checkBasicAuth(request, env))) {
      return unauthorizedResponse();
    }

    if (request.method === 'POST' && (url.pathname === '/ingest-programs' || url.pathname === '/ingest-general-programs')) {
      if (!(await checkSyncKey(request, env))) {
        return Response.json({ error: 'Invalid or missing sync key' }, { status: 401, headers: CORS });
      }
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      if (!(await checkRateLimit(env, ip))) {
        return Response.json({ error: 'Rate limit exceeded — try again later' }, { status: 429, headers: CORS });
      }
    }

    // GET /config — tells the dashboard whether a sync key is required, and reveals the actual
    // key only when Basic Auth is configured AND this request already passed it (this route is
    // not in BASIC_AUTH_EXEMPT_PATHS, so unauthenticated requests never reach this point when
    // Basic Auth is on). For no-Basic-Auth deployments with a SYNC_KEY set, the dashboard falls
    // back to a one-time pasted key stored in the browser's own localStorage — see HowToPanel.
    if (url.pathname === '/config') {
      const syncKeyRequired = !!env.SYNC_KEY;
      const syncKey = syncKeyRequired && env.BASIC_AUTH_USER && env.BASIC_AUTH_PASS ? env.SYNC_KEY : null;
      return Response.json({ syncKeyRequired, syncKey }, { headers: NO_CORS });
    }

    // POST /ingest-programs — receive program progress scraped from theshow.com
    //
    // Two shapes:
    // - Partial batch (`partial: true, syncId`): the sync script's normal mode. Each completed
    //   scrape batch is posted as soon as it's ready so a mid-run network failure doesn't lose
    //   already-scraped progress. The Worker merges the batch's teams into a per-run doc; on the
    //   first batch of a new syncId, that doc is seeded from the previously-stored teams (rotated
    //   into `programs_prev` first) so teams the client didn't re-scrape this run are preserved.
    //   Exempt from the team-count health guard below since batches are small by design.
    // - Full replace (no syncId): legacy/back-compat shape — one-shot full snapshot replace,
    //   same as this endpoint always behaved before Stage 2.
    if (url.pathname === '/ingest-programs' && request.method === 'POST') {
      const parsed = await readJsonBody(request);
      if (parsed.error === 'payload_too_large') {
        return Response.json({ error: 'Payload too large' }, { status: 413, headers: CORS });
      }
      if (parsed.error === 'bad_json') {
        return Response.json({ error: 'Malformed JSON' }, { status: 400, headers: CORS });
      }
      const data = parsed.data;
      if (!isPlainObject(data.teams) || !Object.values(data.teams).every(isPlainObject)) {
        return Response.json({ error: 'Refusing to save invalid teams — likely scraped from the wrong tab' }, { status: 400, headers: CORS });
      }
      const isPartial = data.partial === true && typeof data.syncId === 'string' && data.syncId.length > 0;
      // Non-partial (legacy full-replace) posts must still have at least one team — an empty
      // full replace is almost certainly a scrape-from-the-wrong-tab mistake. Partial "touch"
      // posts (empty teams, used just to record that a sync ran and found nothing changed) are
      // exempt, since an empty batch there is intentional.
      if (!isPartial && Object.keys(data.teams).length === 0) {
        return Response.json({ error: 'Refusing to save empty teams — likely scraped from the wrong tab' }, { status: 400, headers: CORS });
      }
      const syncId = isPartial ? data.syncId.slice(0, 40) : null;
      try {
        const currentRaw = await env.INVENTORY.get(kvKey('programs', uid));
        const current = currentRaw ? JSON.parse(currentRaw) : null;

        if (isPartial) {
          let doc;
          if (current && current.syncId === syncId) {
            doc = current;
          } else {
            if (currentRaw) await env.INVENTORY.put(kvKey('programs_prev', uid), currentRaw);
            doc = { syncId, teams: current ? { ...current.teams } : {} };
          }
          doc.teams = { ...doc.teams, ...data.teams };
          doc.savedAt = data.savedAt || new Date().toISOString();
          await env.INVENTORY.put(kvKey('programs', uid), JSON.stringify(doc));
          // A `summary` is only attached to the final batch of a run (see sync-script.js), so
          // this is the point to record the day's snapshot — using the full cumulative doc.teams,
          // not just this batch, so unchanged teams are represented too.
          if (data.summary) {
            const dateStr = (doc.savedAt || new Date().toISOString()).slice(0, 10);
            await appendHistory(env, uid, dateStr, buildTeamsPctMap(doc.teams), {});
          }
          return Response.json({ ok: true, count: Object.keys(data.teams).length, merged: true }, { headers: CORS });
        }

        // Full replace: guard against a broken scrape (e.g. site layout changed) silently
        // wiping out most of a healthy snapshot.
        if (current) {
          const storedCount = Object.keys(current.teams || {}).length;
          const incomingCount = Object.keys(data.teams).length;
          if (storedCount > 0 && incomingCount < storedCount * 0.5) {
            return Response.json({
              error: 'Refusing full sync — team count dropped more than 50% versus the saved snapshot. Site layout may have changed.',
            }, { status: 409, headers: CORS });
          }
          await env.INVENTORY.put(kvKey('programs_prev', uid), currentRaw);
        }
        const savedAt = data.savedAt || new Date().toISOString();
        await env.INVENTORY.put(kvKey('programs', uid), JSON.stringify({
          teams: data.teams,
          savedAt,
        }));
        await appendHistory(env, uid, savedAt.slice(0, 10), buildTeamsPctMap(data.teams), {});
        return Response.json({ ok: true, count: Object.keys(data.teams).length }, { headers: CORS });
      } catch (e) {
        console.error('ingest-programs failed:', e);
        return Response.json({ error: 'Internal error' }, { status: 500, headers: CORS });
      }
    }

    // GET /programs-data — serve stored program progress. Needs CORS (not just same-origin):
    // the sync script running on theshow.com fetches this directly to compare against the last
    // saved snapshot before deciding which teams to rescan (incremental sync).
    if (url.pathname === '/programs-data') {
      const raw = await env.INVENTORY.get(kvKey('programs', uid));
      if (!raw) return Response.json({ teams: {}, savedAt: null }, { headers: CORS });
      return new Response(raw, { headers: { 'Content-Type': 'application/json', ...CORS } });
    }

    // GET /programs-prev — serve previous snapshot for delta tracking
    if (url.pathname === '/programs-prev') {
      const raw = await env.INVENTORY.get(kvKey('programs_prev', uid));
      if (!raw) return Response.json({ teams: {}, savedAt: null }, { headers: NO_CORS });
      return new Response(raw, { headers: { 'Content-Type': 'application/json', ...NO_CORS } });
    }

    // POST /ingest-general-programs — receive non-team-affinity program data
    if (url.pathname === '/ingest-general-programs' && request.method === 'POST') {
      const parsed = await readJsonBody(request);
      if (parsed.error === 'payload_too_large') {
        return Response.json({ error: 'Payload too large' }, { status: 413, headers: CORS });
      }
      if (parsed.error === 'bad_json') {
        return Response.json({ error: 'Malformed JSON' }, { status: 400, headers: CORS });
      }
      const data = parsed.data;
      if (!isPlainObject(data.programs) || Object.keys(data.programs).length === 0 || !Object.values(data.programs).every(isPlainObject)) {
        return Response.json({ error: 'Refusing to save empty/invalid programs — likely scraped from the wrong tab' }, { status: 400, headers: CORS });
      }
      try {
        const savedAt = data.savedAt || new Date().toISOString();
        await env.INVENTORY.put(kvKey('general_programs', uid), JSON.stringify({ programs: data.programs, savedAt }));
        // This endpoint is always called once at the end of every sync run (full replace), so
        // it's a reliable second hook point for the day's history entry alongside the teams side.
        await appendHistory(env, uid, savedAt.slice(0, 10), {}, buildProgramsPctMap(data.programs));
        return Response.json({ ok: true, count: Object.keys(data.programs).length }, { headers: CORS });
      } catch (e) {
        console.error('ingest-general-programs failed:', e);
        return Response.json({ error: 'Internal error' }, { status: 500, headers: CORS });
      }
    }

    // GET /general-programs-data — serve stored general program data. CORS (not same-origin
    // only): the sync script fetches this cross-origin to skip re-scraping unchanged programs.
    if (url.pathname === '/general-programs-data') {
      const raw = await env.INVENTORY.get(kvKey('general_programs', uid));
      if (!raw) return Response.json({ programs: {}, savedAt: null }, { headers: CORS });
      return new Response(raw, { headers: { 'Content-Type': 'application/json', ...CORS } });
    }

    // GET /history-data — serve the rolling pct-only snapshot history (Stage 3: sparklines,
    // pace, projected completion). Dashboard-only, same-origin — no CORS needed.
    if (url.pathname === '/history-data') {
      const raw = await env.INVENTORY.get(kvKey('history', uid));
      if (!raw) return Response.json({ history: [] }, { headers: NO_CORS });
      return new Response(`{"history":${raw}}`, { headers: { 'Content-Type': 'application/json', ...NO_CORS } });
    }

    // GET /sync.js — the sync script, loaded by the bookmarklet via <script src>. No longer
    // carries the SYNC_KEY (see /config above) — the bookmarklet sets window.__MLB26_SYNC_KEY
    // itself before loading this script.
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
