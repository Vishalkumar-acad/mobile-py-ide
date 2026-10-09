// The persistent workspace.
//
// Programs run with this directory as their working directory, so anything
// they write with a relative path is still there next time. The same files can
// be listed, uploaded, downloaded and deleted from the IDE.
//
// Path safety: every name is resolved inside the workspace and rejected if it
// escapes (absolute paths, "..", symlink-free by construction).

import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import config from './config.js';

const MAX_DEPTH = 4;
const MAX_ENTRIES = 500;

export function workspaceDir() {
  return config.workspaceDir;
}

export function limitBytes() {
  return Math.round(config.workspaceMaxMb) * 1024 * 1024;
}

export async function ensureWorkspace() {
  await fs.mkdir(config.workspaceDir, { recursive: true });
}

// Turn a caller-supplied name into a path inside the workspace, or null.
export function safePath(name) {
  if (typeof name !== 'string') return null;
  const rel = name.replace(/\\/g, '/').trim();
  if (!rel || rel.length > 200) return null;
  if (rel.startsWith('/')) return null; // absolute paths are refused
  if (/^[A-Za-z]:/.test(rel)) return null; // windows drive letters
  if (rel.split('/').some((part) => part === '' || part === '.' || part === '..')) return null;
  const root = path.resolve(config.workspaceDir);
  const full = path.resolve(root, rel);
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  return { rel, full };
}

async function walk(dir, rel, depth, out, budget) {
  if (depth > MAX_DEPTH || out.length >= MAX_ENTRIES) return;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= MAX_ENTRIES) return;
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    const childFull = path.join(dir, e.name);
    if (e.isDirectory()) {
      await walk(childFull, childRel, depth + 1, out, budget);
    } else if (e.isFile()) {
      try {
        const st = await fs.stat(childFull);
        budget.total += st.size;
        out.push({ name: childRel, size: st.size, mtime: st.mtimeMs });
      } catch { /* skip */ }
    }
  }
}

export async function listFiles() {
  await ensureWorkspace();
  const out = [];
  const budget = { total: 0 };
  await walk(config.workspaceDir, '', 0, out, budget);
  out.sort((a, b) => b.mtime - a.mtime);
  return { files: out, total: budget.total, limit: limitBytes(), dir: config.workspaceDir };
}

export async function totalSize() {
  const { total } = await listFiles();
  return total;
}

export async function readFile(name) {
  const p = safePath(name);
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

export async function writeFile(name, source, maxBytes) {
  const p = safePath(name);
  if (!p) return { ok: false, error: 'Invalid file name.' };
  const cap = Math.min(maxBytes ?? Infinity, limitBytes());
  await ensureWorkspace();
  await fs.mkdir(path.dirname(p.full), { recursive: true });

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
    return { ok: false, error: `File is larger than the ${Math.round(cap / (1024 * 1024))} MB upload limit.` };
  }
  if (failed) {
    await fs.rm(p.full, { force: true }).catch(() => {});
    return { ok: false, error: 'Could not write the file.' };
  }
  return { ok: true, rel: p.rel, size };
}

export async function deleteFile(name) {
  const p = safePath(name);
  if (!p) return false;
  try {
    await fs.rm(p.full, { force: true });
    return true;
  } catch {
    return false;
  }
}
