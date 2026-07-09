// Self-hosted alternative to the Cloudflare Worker (worker/), for anyone who'd rather
// run this on their own server/NAS/VPS via Docker instead of using Cloudflare.
// Implements the exact same routes and behavior — see worker/src/index.js for the
// Cloudflare version of this same server.
import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import { promises as fsp } from 'fs';
import { SYNC_SCRIPT } from '../shared/sync-script.js';
import * as store from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_HTML_PATH = path.join(__dirname, '..', 'worker', 'src', 'app.html');

const PORT = process.env.PORT || 8787;

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

const app = express();
app.use(express.json({ limit: '10mb' }));

app.use((req, res, next) => {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
  });
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
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
  const script = SYNC_SCRIPT.replace('__ORIGIN__', origin).replace('__UID__', uid || '');
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
  console.log(`MLB26 tracker (self-hosted) listening on port ${PORT}`);
});
