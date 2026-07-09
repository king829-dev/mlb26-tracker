// Self-hosted alternative to the Cloudflare Worker (worker/), for anyone who'd rather
// run this on their own server/NAS/VPS via Docker instead of using Cloudflare.
// Implements the exact same routes and behavior — see worker/src/index.js for the
// Cloudflare version of this same server.
import express from 'express';
import https from 'https';
import { fileURLToPath } from 'url';
import path from 'path';
import fs, { promises as fsp } from 'fs';
import { SYNC_SCRIPT } from '../shared/sync-script.js';
import * as store from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_HTML_PATH = path.join(__dirname, '..', 'worker', 'src', 'app.html');

const PORT = process.env.PORT || 8787;
const HTTPS_PORT = process.env.HTTPS_PORT || 8443;
const CERT_FILE = path.join(store.DATA_DIR, 'certs', 'cert.pem');
const KEY_FILE = path.join(store.DATA_DIR, 'certs', 'key.pem');

// Multi-tenant support: each browser/user gets an opaque uid (generated client-side).
// Requests with no uid fall back to the original unscoped keys (the primary/legacy user).
function sanitizeUid(raw) {
  if (!raw) return null;
  const clean = String(raw).replace(/[^a-zA-Z0-9]/g, '').slice(0, 40);
  return clean || null;
}
function kvKey(base, uid) {
  return uid ? `${base}_${uid}` : base;
}

// Writes are rate-limited per source IP to prevent a flood of requests from filling up disk /
// hammering the process. In-memory only (resets on restart) — fine for a single self-hosted
// instance. Edit these constants and rebuild if you need a different limit.
const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const rateLimitMap = new Map();
function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (entry.count >= RATE_LIMIT_MAX) return false;
  entry.count += 1;
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now > entry.resetAt) rateLimitMap.delete(ip);
  }
}, RATE_LIMIT_WINDOW_MS).unref();

// If SYNC_KEY is set in the environment, writes must include a matching X-Sync-Key header —
// the served /sync.js script embeds this automatically, so this is invisible to legitimate
// users but rejects requests sent directly to the endpoint by anyone who hasn't first loaded
// the sync script from this deployment. If SYNC_KEY isn't set, this check is skipped.
function checkSyncKey(req) {
  if (!process.env.SYNC_KEY) return true;
  return req.get('X-Sync-Key') === process.env.SYNC_KEY;
}

// If BASIC_AUTH_USER + BASIC_AUTH_PASS are set in the environment, the dashboard page and the
// data-read endpoints require an HTTP Basic Auth login (the browser shows its native
// username/password prompt). Separate from SYNC_KEY: SYNC_KEY protects writes and is
// invisible/automatic via the sync script; Basic Auth protects reads and requires a person to
// type credentials, so it deliberately does NOT apply to /sync.js (loaded silently as a
// <script src> by the bookmarklet, which can't supply a password) or the ingest endpoints
// (already covered by SYNC_KEY). If the env vars aren't set, this check is skipped entirely.
function checkBasicAuth(req) {
  if (!process.env.BASIC_AUTH_USER || !process.env.BASIC_AUTH_PASS) return true;
  const header = req.get('Authorization') || '';
  if (!header.startsWith('Basic ')) return false;
  let decoded;
  try {
    decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  } catch (e) {
    return false;
  }
  const idx = decoded.indexOf(':');
  if (idx === -1) return false;
  return decoded.slice(0, idx) === process.env.BASIC_AUTH_USER && decoded.slice(idx + 1) === process.env.BASIC_AUTH_PASS;
}

const BASIC_AUTH_EXEMPT_PATHS = new Set(['/sync.js', '/ingest-programs', '/ingest-general-programs']);

const app = express();
app.set('trust proxy', true); // so req.ip reflects X-Forwarded-For when behind a reverse proxy/tunnel
app.use(express.json({ limit: '10mb' }));

app.use((req, res, next) => {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Sync-Key',
    'Cache-Control': 'no-store',
  });
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

app.use((req, res, next) => {
  if (req.method !== 'POST' || (req.path !== '/ingest-programs' && req.path !== '/ingest-general-programs')) return next();
  if (!checkSyncKey(req)) return res.status(401).json({ error: 'Invalid or missing sync key' });
  if (!checkRateLimit(req.ip)) return res.status(429).json({ error: 'Rate limit exceeded — try again later' });
  next();
});

app.use((req, res, next) => {
  if (BASIC_AUTH_EXEMPT_PATHS.has(req.path)) return next();
  if (checkBasicAuth(req)) return next();
  res.set('WWW-Authenticate', 'Basic realm="MLB26 Tracker"');
  res.status(401).send('Authentication required');
});

app.post('/ingest-programs', async (req, res) => {
  const uid = sanitizeUid(req.query.uid);
  const data = req.body || {};
  if (!data.teams || Object.keys(data.teams).length === 0) {
    return res.status(400).json({ error: 'Refusing to save empty teams — likely scraped from the wrong tab' });
  }
  try {
    const current = await store.get(kvKey('programs', uid));
    if (current) await store.put(kvKey('programs_prev', uid), current);
    await store.put(kvKey('programs', uid), JSON.stringify({
      teams: data.teams,
      savedAt: data.savedAt || new Date().toISOString(),
    }));
    res.json({ ok: true, count: Object.keys(data.teams).length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/programs-data', async (req, res) => {
  const uid = sanitizeUid(req.query.uid);
  const raw = await store.get(kvKey('programs', uid));
  if (!raw) return res.json({ teams: {}, savedAt: null });
  res.type('application/json').send(raw);
});

app.get('/programs-prev', async (req, res) => {
  const uid = sanitizeUid(req.query.uid);
  const raw = await store.get(kvKey('programs_prev', uid));
  if (!raw) return res.json({ teams: {}, savedAt: null });
  res.type('application/json').send(raw);
});

app.post('/ingest-general-programs', async (req, res) => {
  const uid = sanitizeUid(req.query.uid);
  const data = req.body || {};
  if (!data.programs || Object.keys(data.programs).length === 0) {
    return res.status(400).json({ error: 'Refusing to save empty programs — likely scraped from the wrong tab' });
  }
  try {
    await store.put(kvKey('general_programs', uid), JSON.stringify({
      programs: data.programs,
      savedAt: data.savedAt || new Date().toISOString(),
    }));
    res.json({ ok: true, count: Object.keys(data.programs).length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/general-programs-data', async (req, res) => {
  const uid = sanitizeUid(req.query.uid);
  const raw = await store.get(kvKey('general_programs', uid));
  if (!raw) return res.json({ programs: {}, savedAt: null });
  res.type('application/json').send(raw);
});

app.get('/sync.js', (req, res) => {
  const uid = sanitizeUid(req.query.uid);
  const origin = `${req.protocol}://${req.get('host')}`;
  const script = SYNC_SCRIPT.replace('__ORIGIN__', origin).replace('__UID__', uid || '').replace('__KEY__', process.env.SYNC_KEY || '');
  res.type('application/javascript; charset=utf-8').send(script);
});

app.get('/', async (req, res) => {
  const html = await fsp.readFile(APP_HTML_PATH, 'utf8');
  res.set('Cache-Control', 'no-cache').type('html').send(html);
});

// Friendly path-style links, e.g. /bryan — the app.html client itself reads
// window.location.pathname to pick up the uid, so this just needs to serve the same page.
app.get('/:friendlyUid', async (req, res, next) => {
  if (!/^[a-zA-Z0-9]+$/.test(req.params.friendlyUid)) return next();
  const html = await fsp.readFile(APP_HTML_PATH, 'utf8');
  res.set('Cache-Control', 'no-cache').type('html').send(html);
});

app.listen(PORT, () => {
  console.log(`MLB26 tracker (self-hosted) listening on port ${PORT} (HTTP)`);
});

// Optional HTTPS listener using a self-signed cert (see entrypoint.sh, which generates
// one automatically in Docker). Browsers block syncing from an HTTPS page (like the MLB
// site) to a plain-HTTP endpoint ("mixed content"), so HTTPS is needed here for the
// bookmarklet to actually work — visit the tracker via this port to get a bookmarklet
// that self-points to HTTPS.
if (fs.existsSync(CERT_FILE) && fs.existsSync(KEY_FILE)) {
  https.createServer({
    cert: fs.readFileSync(CERT_FILE),
    key: fs.readFileSync(KEY_FILE),
  }, app).listen(HTTPS_PORT, () => {
    console.log(`MLB26 tracker (self-hosted) listening on port ${HTTPS_PORT} (HTTPS, self-signed)`);
  });
} else {
  console.log(`No TLS cert found at ${CERT_FILE} — HTTPS not started.`);
}
