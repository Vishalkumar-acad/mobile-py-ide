// Files inside a space.
//
// Every function takes the base directory it should work in — the caller's own
// space — so one visitor can never reach another's files. Path names are
// resolved inside that directory and refused if they try to escape.

import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import config from './config.js';

const MAX_DEPTH = 4;
const MAX_ENTRIES = 500;

export function globalLimitBytes() {
  return Math.round(config.workspaceMaxMb) * 1024 * 1024;
}

// Turn a caller-supplied name into a path inside `base`, or null.
export function safePath(base, name) {
  if (typeof name !== 'string') return null;
  const rel = name.replace(/\\/g, '/').trim();
  if (!rel || rel.length > 200) return null;
  if (rel.startsWith('/')) return null; // absolute paths are refused
  if (/^[A-Za-z]:/.test(rel)) return null; // windows drive letters
  if (rel.split('/').some((part) => part === '' || part === '.' || part === '..')) return null;
  const root = path.resolve(base);
  const full = path.resolve(root, rel);
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  return { rel, full };
}

async function walk(dir, rel, depth, out, budget) {
  if (depth > MAX_DEPTH || (out && out.length >= MAX_ENTRIES)) return;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (out && out.length >= MAX_ENTRIES) return;
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    const childFull = path.join(dir, e.name);
    if (e.isDirectory()) {
      await walk(childFull, childRel, depth + 1, out, budget);
    } else if (e.isFile()) {
      try {
        const st = await fs.stat(childFull);
        budget.total += st.size;
        if (out) out.push({ name: childRel, size: st.size, mtime: st.mtimeMs });
      } catch { /* skip */ }
    }
  }
}

export async function listFiles(base) {
  const out = [];
  const budget = { total: 0 };
  await fs.mkdir(base, { recursive: true }).catch(() => {});
  await walk(base, '', 0, out, budget);
  out.sort((a, b) => b.mtime - a.mtime);
  return {
    files: out,
    total: budget.total,
    limit: Math.round(config.perUserMaxMb) * 1024 * 1024,
    global_limit: globalLimitBytes(),
  };
}

export async function dirSize(base) {
  const budget = { total: 0 };
  await walk(base, '', 0, null, budget);
  return budget.total;
}

// Total across every space, cached briefly: walking 10 GB on each upload would
// be wasteful, and a small lag is fine for a cap.
let globalCache = { at: 0, total: 0 };
export async function globalTotal(maxAgeMs = 60000) {
  if (Date.now() - globalCache.at < maxAgeMs) return globalCache.total;
  let total = 0;
  let entries = [];
  try {
    entries = await fs.readdir(config.workspaceDir, { withFileTypes: true });
  } catch {
    return globalCache.total;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    total += await dirSize(path.join(config.workspaceDir, e.name));
  }
  globalCache = { at: Date.now(), total };
  return total;
}

export function forgetGlobalTotal() {
  globalCache = { at: 0, total: 0 };
}

export async function readFile(base, name) {
  const p = safePath(base, name);
  if (!p) return null;
  try {
    const st = await fs.stat(p.full);
    if (!st.isFile()) return null;
    const data = await fs.readFile(p.full);
    return { rel: p.rel, data, size: st.size };
  } catch {
    return null;
  }
}

export async function writeFile(base, name, source, maxBytes) {
  const p = safePath(base, name);
  if (!p) return { ok: false, error: 'Invalid file name.' };
  const cap = Math.min(maxBytes ?? Infinity, Math.round(config.maxFileMb) * 1024 * 1024);
  await fs.mkdir(path.dirname(p.full), { recursive: true }).catch(() => {});

  let size = 0;
  let tooLarge = false;
  let failed = null;
  const ws = createWriteStream(p.full);
  await new Promise((resolve) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    source.on('data', (c) => {
      size += c.length;
      if (size > cap) {
        tooLarge = true;
        try { source.unpipe(ws); } catch { /* ignore */ }
        source.destroy();
        ws.destroy();
        done();
      }
    });
    source.on('error', (e) => { failed = failed || e; done(); });
    ws.on('error', (e) => { failed = failed || e; done(); });
    ws.on('finish', done);
    ws.on('close', done);
    source.pipe(ws);
  });

  if (tooLarge) {
    await fs.rm(p.full, { force: true }).catch(() => {});
    return { ok: false, error: `File is larger than the ${Math.round(cap / (1024 * 1024))} MB limit.` };
  }
  if (failed) {
    await fs.rm(p.full, { force: true }).catch(() => {});
    return { ok: false, error: 'Could not write the file.' };
  }
  forgetGlobalTotal();
  return { ok: true, rel: p.rel, size };
}

export async function deleteFile(base, name) {
  const p = safePath(base, name);
  if (!p) return false;
  try {
    const st = await fs.stat(p.full);
    if (!st.isFile()) return false;
    await fs.rm(p.full, { force: true });
    forgetGlobalTotal();
    return true;
  } catch {
    return false;
  }
}
