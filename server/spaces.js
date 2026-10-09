// Anonymous per-visitor spaces.
//
// Every browser gets a random id inside a signed, HttpOnly cookie. That id
// names a folder under the workspace, and it is the only folder that visitor
// can see or write to. No accounts, no passwords.
//
// A sweeper removes spaces that have not been used for SPACE_TTL_MS (24h by
// default), so abandoned data cleans itself up.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import config from './config.js';

const ID_RE = /^[0-9a-f]{16,64}$/;
let secret = null;

// The signing secret must survive restarts, or everyone would lose their space.
// It is kept in the workspace root (a file, so the sweeper ignores it).
async function loadSecret() {
  if (secret) return secret;
  if (config.cookieSecret) {
    secret = config.cookieSecret;
    return secret;
  }
  const file = path.join(config.workspaceDir, '.secret');
  try {
    const s = (await fs.readFile(file, 'utf8')).trim();
    if (s) { secret = s; return secret; }
  } catch { /* create below */ }
  secret = crypto.randomBytes(32).toString('hex');
  await fs.mkdir(config.workspaceDir, { recursive: true }).catch(() => {});
  await fs.writeFile(file, secret, { mode: 0o600 }).catch(() => {});
  return secret;
}

function signature(id) {
  return crypto.createHmac('sha256', secret).update(id).digest('base64url').slice(0, 22);
}

export async function makeToken(id) {
  await loadSecret();
  return `${id}.${signature(id)}`;
}

export async function readToken(token) {
  if (typeof token !== 'string') return null;
  const i = token.lastIndexOf('.');
  if (i < 0) return null;
  const id = token.slice(0, i);
  const sig = token.slice(i + 1);
  if (!ID_RE.test(id)) return null;
  await loadSecret();
  const expect = signature(id);
  if (sig.length !== expect.length) return null;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  } catch {
    return null;
  }
  return id;
}

export function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function spaceDir(id) {
  return path.join(config.workspaceDir, id);
}

// Find (or, when create is true, make) the caller's space.
export async function identify(req, res, { create = true } = {}) {
  await loadSecret();
  let id = await readToken(parseCookies(req)[config.cookieName]);
  if (!id && create) {
    id = crypto.randomBytes(16).toString('hex');
    const attrs = [
      `${config.cookieName}=${await makeToken(id)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${Math.floor(config.spaceTtlMs / 1000)}`,
    ];
    if (String(req.headers['x-forwarded-proto'] || '').includes('https')) attrs.push('Secure');
    res.setHeader('Set-Cookie', attrs.join('; '));
  }
  if (!id) return null;
  const dir = spaceDir(id);
  if (create) await fs.mkdir(dir, { recursive: true }).catch(() => {});
  return { id, dir };
}

// Mark the space as used just now (directory mtime is our activity clock).
export async function touch(dir) {
  const now = new Date();
  await fs.utimes(dir, now, now).catch(() => {});
}

export async function sweep() {
  let removed = 0;
  let entries = [];
  try {
    entries = await fs.readdir(config.workspaceDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  const cutoff = Date.now() - config.spaceTtlMs;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(config.workspaceDir, e.name);
    try {
      const st = await fs.stat(dir);
      if (st.mtimeMs < cutoff) {
        await fs.rm(dir, { recursive: true, force: true });
        removed += 1;
      }
    } catch { /* ignore */ }
  }
  return removed;
}

export function startSweeper() {
  sweep().catch(() => {});
  const timer = setInterval(() => { sweep().catch(() => {}); }, config.sweepIntervalMs);
  timer.unref();
}

export function perUserLimitBytes() {
  return Math.round(config.perUserMaxMb) * 1024 * 1024;
}
