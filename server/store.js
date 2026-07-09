// Minimal file-based key/value store — a drop-in replacement for Cloudflare KV
// when self-hosting. Each key is stored as its own JSON file under DATA_DIR.
import { promises as fs } from 'fs';
import path from 'path';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');

function fileFor(key) {
  // Keys are always one of a small set of static base names, optionally suffixed
  // with a uid that's already sanitized to [a-zA-Z0-9] elsewhere — safe as a filename.
  return path.join(DATA_DIR, `${key}.json`);
}

async function ensureDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

export async function get(key) {
  try {
    return await fs.readFile(fileFor(key), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

export async function put(key, value) {
  await ensureDir();
  await fs.writeFile(fileFor(key), value, 'utf8');
}
