// Mobile Py IDE — HTTP server.
//
// Zero npm dependencies: only Node's built-in modules. Serves the static
// frontend from ../public and exposes:
//
//   GET  /api/health                    -> { ok, terminal, packages, ... }
//   POST /api/run    { code, stdin }    -> one-shot execution result (JSON)
//   POST /api/runs   { code, stdin?, mode } -> { runId }   mode: script|repl|terminal
//   GET  /api/runs/:id/events           -> Server-Sent Events stream
//   POST /api/runs/:id/input { data }   -> feed a line to the running program
//   POST /api/runs/:id/kill             -> stop the running program
//   GET  /api/packages                  -> allowed packages
//   POST /api/packages { name }         -> install an allow-listed package

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from './config.js';
import { validate } from './validator.js';
import { execute } from './executor.js';
import { createRun, getRun, killRunsForSpace } from './runs.js';
import { REPL_SOURCE } from './modes.js';
import { allowlist, installPackage } from './packages.js';
import { listFiles, readFile, writeFile, deleteFile, safePath, dirSize, globalTotal, globalLimitBytes } from './files.js';
import { diagnostics } from './diag.js';
import { identify, touch, startSweeper, perUserLimitBytes } from './spaces.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
};

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...SECURITY_HEADERS,
  });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('PAYLOAD_TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function parseJsonBody(req, res, limit) {
  let body;
  try {
    body = await readBody(req, limit);
  } catch (e) {
    const tooLarge = e.message === 'PAYLOAD_TOO_LARGE';
    json(res, tooLarge ? 413 : 400, {
      status: 'error',
      error: tooLarge ? 'Request body too large.' : 'Could not read request body.',
    });
    return null;
  }
  try {
    return JSON.parse(body || '{}');
  } catch {
    json(res, 400, { status: 'error', error: 'Invalid JSON body.' });
    return null;
  }
}

// --- tiny in-memory per-IP rate limiter ---------------------------------
const hits = new Map();
function isRateLimited(ip) {
  const now = Date.now();
  const rec = hits.get(ip);
  if (!rec || now > rec.resetAt) {
    hits.set(ip, { count: 1, resetAt: now + config.rateWindowMs });
    return false;
  }
  rec.count += 1;
  return rec.count > config.rateMax;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of hits) if (now > rec.resetAt) hits.delete(ip);
}, config.rateWindowMs).unref();

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

// --- concurrency guard --------------------------------------------------
let activeRuns = 0;
const runQueue = [];

function acquireSlot() {
  return new Promise((resolve, reject) => {
    if (activeRuns < config.maxConcurrentRuns) {
      activeRuns += 1;
      resolve();
      return;
    }
    if (runQueue.length >= config.maxQueue) {
      reject(new Error('BUSY'));
      return;
    }
    runQueue.push(resolve);
  });
}

function releaseSlot() {
  const next = runQueue.shift();
  if (next) next();
  else activeRuns -= 1;
}

// --- static files -------------------------------------------------------
async function serveStatic(req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400);
    res.end('Bad request');
    return;
  }
  if (urlPath === '/') urlPath = '/index.html';

  const resolved = path.resolve(path.join(PUBLIC_DIR, urlPath));
  if (resolved !== PUBLIC_DIR && !resolved.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, SECURITY_HEADERS);
    res.end('Forbidden');
    return;
  }

  try {
    const stat = await fs.stat(resolved);
    if (stat.isDirectory()) throw new Error('is a directory');
    const data = await fs.readFile(resolved);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(resolved).toLowerCase()] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
      ...SECURITY_HEADERS,
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
    res.end('Not found');
  }
}

function sseOpen(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...SECURITY_HEADERS,
  });
  res.write(': connected\n\n');
}

// Work out what to run for a given mode.
function resolveMode(payload) {
  const mode = ['script', 'repl', 'terminal'].includes(payload.mode) ? payload.mode : 'script';
  if (mode === 'terminal') {
    if (!config.allowTerminal) return { error: 'Terminal mode is turned off on this server.' };
    return {
      mode,
      code: '',
      opts: { kind: 'bash', idleMs: config.replIdleMs, maxMs: config.replMaxMs, memoryMb: config.terminalMemoryMb },
      skipValidation: true,
    };
  }
  if (mode === 'repl') {
    return {
      mode,
      code: REPL_SOURCE,
      opts: { kind: 'python', idleMs: config.replIdleMs, maxMs: config.replMaxMs, memoryMb: config.memoryLimitMb },
      skipValidation: true,
    };
  }
  return {
    mode: 'script',
    code: typeof payload.code === 'string' ? payload.code : '',
    opts: { kind: 'python', idleMs: config.runIdleMs, maxMs: config.runMaxMs, memoryMb: config.memoryLimitMb },
    skipValidation: false,
  };
}

// --- request routing ----------------------------------------------------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/api/health') {
      return json(res, 200, {
        ok: true,
        service: 'pypad',
        interactive: true,
        modes: ['script', 'repl', ...(config.allowTerminal ? ['terminal'] : [])],
        terminal: config.allowTerminal,
        packages: config.allowPackageInstall,
        files: config.allowFileAccess,
        workspace_mb: config.workspaceMaxMb,
        spaces: true,
        space_ttl_hours: Math.round(config.spaceTtlMs / 3600000),
        timeout_ms: config.timeoutMs,
        run_idle_ms: config.runIdleMs,
        run_max_ms: config.runMaxMs,
        memory_limit_mb: config.memoryLimitMb,
        strict_mode: config.strictMode,
      });
    }

    // ---- self-check ----
    if (req.method === 'GET' && url.pathname === '/api/diag') {
      return json(res, 200, await diagnostics(req));
    }

    // ---- packages ----
    if (req.method === 'GET' && url.pathname === '/api/packages') {
      return json(res, 200, {
        enabled: config.allowPackageInstall,
        allowlist: allowlist(),
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/packages') {
      if (isRateLimited(clientIp(req))) {
        return json(res, 429, { ok: false, error: 'Too many requests, please slow down.' });
      }
      const payload = await parseJsonBody(req, res, 4096);
      if (!payload) return undefined;
      const name = typeof payload.name === 'string' ? payload.name.trim() : '';
      const result = await installPackage(name);
      return json(res, result.ok ? 200 : 400, result);
    }

    // ---- one-shot run (script mode only) ----
    if (req.method === 'POST' && url.pathname === '/api/run') {
      if (isRateLimited(clientIp(req))) {
        return json(res, 429, { status: 'error', error: 'Too many requests, please slow down.' });
      }
      const payload = await parseJsonBody(req, res, config.maxCodeBytes + config.maxStdinBytes + 8192);
      if (!payload) return undefined;
      const code = typeof payload.code === 'string' ? payload.code : '';
      const stdin = typeof payload.stdin === 'string' ? payload.stdin : '';
      if (Buffer.byteLength(stdin, 'utf8') > config.maxStdinBytes) {
        return json(res, 413, { status: 'error', error: 'stdin is too large.' });
      }
      const verdict = validate(code);
      if (!verdict.ok) {
        return json(res, 400, { status: 'rejected', error: `Error: ${verdict.reason}` });
      }
      const space = await identify(req, res);
      if (!space) return json(res, 400, { status: 'error', error: 'No space for this visitor.' });
      try {
        await acquireSlot();
      } catch {
        return json(res, 429, {
          status: 'error',
          error: 'Server is busy running other programs. Please try again in a moment.',
        });
      }
      try {
        return json(res, 200, await execute({ code, stdin, cwd: space.dir }));
      } finally {
        releaseSlot();
        touch(space.dir);
      }
    }

    // ---- start a run (script / repl / terminal) ----
    if (req.method === 'POST' && url.pathname === '/api/runs') {
      if (isRateLimited(clientIp(req))) {
        return json(res, 429, { status: 'error', error: 'Too many requests, please slow down.' });
      }
      const payload = await parseJsonBody(req, res, config.maxCodeBytes + config.maxStdinBytes + 8192);
      if (!payload) return undefined;

      const stdin = typeof payload.stdin === 'string' ? payload.stdin : '';
      if (Buffer.byteLength(stdin, 'utf8') > config.maxStdinBytes) {
        return json(res, 413, { status: 'error', error: 'stdin is too large.' });
      }

      const resolved = resolveMode(payload);
      if (resolved.error) {
        return json(res, 403, { status: 'error', error: resolved.error });
      }
      if (!resolved.skipValidation) {
        const verdict = validate(resolved.code);
        if (!verdict.ok) {
          return json(res, 400, { status: 'rejected', error: `Error: ${verdict.reason}` });
        }
      }

      const space = await identify(req, res);
      if (!space) return json(res, 400, { status: 'error', error: 'No space for this visitor.' });

      // Starting a new session replaces your previous one, so a session left
      // behind by a page reload cannot block you with "server is busy".
      await killRunsForSpace(space.id);

      try {
        await acquireSlot();
      } catch {
        return json(res, 429, {
          status: 'error',
          error: 'Server is busy running other programs. Please try again in a moment.',
        });
      }

      let run;
      try {
        run = await createRun(resolved.code, { ...resolved.opts, cwd: space.dir, spaceId: space.id });
      } catch {
        releaseSlot();
        return json(res, 500, { status: 'error', error: 'Could not start the run.' });
      }
      run.done.then(() => releaseSlot());
      touch(space.dir);
      if (stdin) run.write(stdin.endsWith('\n') ? stdin : `${stdin}\n`);
      return json(res, 200, { runId: run.id, mode: resolved.mode });
    }

    // ---- final result of a run (fallback if the live stream drops) ----
    const resMatch = url.pathname.match(/^\/api\/runs\/([0-9a-f]+)$/);
    if (req.method === 'GET' && resMatch) {
      const run = getRun(resMatch[1]);
      if (!run) return json(res, 404, { status: 'error', error: 'Unknown run.' });
      return json(res, 200, {
        finished: run.finished,
        status: run.status,
        stdout: run.stdout,
        stderr: run.stderr,
        exit_code: run.exitCode,
        elapsed_ms: run.finished ? run.elapsedMs : Date.now() - run.startedAt,
        truncated: run.truncated,
      });
    }

    // ---- stream a run's output ----
    const evMatch = url.pathname.match(/^\/api\/runs\/([0-9a-f]+)\/events$/);
    if (req.method === 'GET' && evMatch) {
      const run = getRun(evMatch[1]);
      if (!run) return json(res, 404, { status: 'error', error: 'Unknown or finished run.' });

      sseOpen(res);
      const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* gone */ } }, 15000);
      const unsub = run.subscribe((evt) => {
        try {
          res.write(`data: ${JSON.stringify(evt)}\n\n`);
          if (evt.type === 'exit') { clearInterval(hb); res.end(); }
        } catch { /* client gone */ }
      });
      req.on('close', () => { clearInterval(hb); unsub(); });
      return undefined;
    }

    // ---- feed input to a run ----
    const inMatch = url.pathname.match(/^\/api\/runs\/([0-9a-f]+)\/input$/);
    if (req.method === 'POST' && inMatch) {
      const run = getRun(inMatch[1]);
      if (!run) return json(res, 404, { status: 'error', error: 'Unknown or finished run.' });
      const payload = await parseJsonBody(req, res, config.maxStdinBytes + 4096);
      if (!payload) return undefined;
      const data = typeof payload.data === 'string' ? payload.data : '';
      const ok = run.write(data.endsWith('\n') ? data : `${data}\n`);
      return json(res, 200, { ok });
    }

    // ---- stop a run ----
    const killMatch = url.pathname.match(/^\/api\/runs\/([0-9a-f]+)\/kill$/);
    if (req.method === 'POST' && killMatch) {
      const run = getRun(killMatch[1]);
      if (run) run.kill();
      return json(res, 200, { ok: true });
    }

    // ---- workspace files (scoped to the caller's own space) ----
    if (req.method === 'GET' && url.pathname === '/api/files') {
      const space = await identify(req, res);
      if (!space) return json(res, 400, { ok: false, error: 'No space for this visitor.' });
      const info = await listFiles(space.dir);
      touch(space.dir);
      return json(res, 200, info);
    }
    if (req.method === 'POST' && url.pathname === '/api/files') {
      if (isRateLimited(clientIp(req))) {
        return json(res, 429, { ok: false, error: 'Too many requests, please slow down.' });
      }
      const space = await identify(req, res);
      if (!space) return json(res, 400, { ok: false, error: 'No space for this visitor.' });
      const name = url.searchParams.get('name') || '';
      if (!safePath(space.dir, name)) return json(res, 400, { ok: false, error: 'Invalid file name.' });
      const used = await dirSize(space.dir);
      const cap = Math.min(
        perUserLimitBytes() - used,
        globalLimitBytes() - (await globalTotal()),
        Math.round(config.maxUploadMb) * 1024 * 1024,
      );
      if (cap <= 0) {
        return json(res, 413, { ok: false, error: 'No space left for this upload.' });
      }
      const result = await writeFile(space.dir, name, req, cap);
      touch(space.dir);
      return json(res, result.ok ? 200 : 413, result);
    }
    const fileMatch = url.pathname.match(/^\/api\/files\/(.+)$/);
    if (fileMatch && (req.method === 'GET' || req.method === 'HEAD' || req.method === 'DELETE')) {
      const space = await identify(req, res);
      if (!space) return json(res, 400, { ok: false, error: 'No space for this visitor.' });
      const name = decodeURIComponent(fileMatch[1]);
      if (req.method === 'DELETE') {
        const ok = await deleteFile(space.dir, name);
        touch(space.dir);
        return json(res, ok ? 200 : 404, { ok });
      }
      const f = await readFile(space.dir, name);
      if (!f) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
        res.end('Not found');
        return undefined;
      }
      touch(space.dir);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': f.data.length,
        'Content-Disposition': `attachment; filename="${path.basename(f.rel).replace(/"/g, '')}"`,
        ...SECURITY_HEADERS,
      });
      res.end(req.method === 'HEAD' ? undefined : f.data);
      return undefined;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      return serveStatic(req, res);
    }

    res.writeHead(405, { Allow: 'GET, POST', ...SECURITY_HEADERS });
    res.end('Method not allowed');
    return undefined;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('request failed:', err && err.stack ? err.stack : err);
    return json(res, 500, { status: 'error', error: 'Internal server error.' });
  }
});

fs.mkdir(config.workspaceDir, { recursive: true }).catch(() => {});
startSweeper();

server.listen(config.port, config.host, () => {
  // eslint-disable-next-line no-console
  console.log(`PyPad running at http://${config.host}:${config.port}`);
  console.log(`  modes=script,repl${config.allowTerminal ? ',terminal' : ''}  packages=${config.allowPackageInstall}  memory=${config.memoryLimitMb}MB`);
});

export default server;
