// Mobile Py IDE — HTTP server.
//
// Zero npm dependencies: only Node's built-in modules. Serves the static
// frontend from ../public and exposes:
//
//   GET  /api/health                    -> { ok, ... }
//   POST /api/run    { code, stdin }    -> one-shot execution result (JSON)
//   POST /api/runs   { code, stdin? }   -> { runId }  (interactive run)
//   GET  /api/runs/:id/events           -> Server-Sent Events stream
//   POST /api/runs/:id/input { data }   -> feed a line to the running program
//   POST /api/runs/:id/kill             -> stop the running program

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from './config.js';
import { validate } from './validator.js';
import { execute } from './executor.js';
import { createRun, getRun } from './runs.js';

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

// --- shared request parsing --------------------------------------------
async function parseRunBody(req, res) {
  const limit = config.maxCodeBytes + config.maxStdinBytes + 8192;
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
  let payload;
  try {
    payload = JSON.parse(body || '{}');
  } catch {
    json(res, 400, { status: 'error', error: 'Invalid JSON body.' });
    return null;
  }
  const code = typeof payload.code === 'string' ? payload.code : '';
  const stdin = typeof payload.stdin === 'string' ? payload.stdin : '';

  if (Buffer.byteLength(stdin, 'utf8') > config.maxStdinBytes) {
    json(res, 413, { status: 'error', error: 'stdin is too large.' });
    return null;
  }
  const verdict = validate(code);
  if (!verdict.ok) {
    json(res, 400, { status: 'rejected', error: `Error: ${verdict.reason}` });
    return null;
  }
  return { code, stdin };
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

// --- request routing ----------------------------------------------------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/api/health') {
      return json(res, 200, {
        ok: true,
        service: 'mobile-py-ide',
        interactive: true,
        timeout_ms: config.timeoutMs,
        run_idle_ms: config.runIdleMs,
        run_max_ms: config.runMaxMs,
        memory_limit_mb: config.memoryLimitMb,
        strict_mode: config.strictMode,
      });
    }

    // ---- one-shot run ----
    if (req.method === 'POST' && url.pathname === '/api/run') {
      if (isRateLimited(clientIp(req))) {
        return json(res, 429, { status: 'error', error: 'Too many requests, please slow down.' });
      }
      const parsed = await parseRunBody(req, res);
      if (!parsed) return undefined;

      try {
        await acquireSlot();
      } catch {
        return json(res, 429, {
          status: 'error',
          error: 'Server is busy running other programs. Please try again in a moment.',
        });
      }
      try {
        const result = await execute(parsed);
        return json(res, 200, result);
      } finally {
        releaseSlot();
      }
    }

    // ---- start an interactive run ----
    if (req.method === 'POST' && url.pathname === '/api/runs') {
      if (isRateLimited(clientIp(req))) {
        return json(res, 429, { status: 'error', error: 'Too many requests, please slow down.' });
      }
      const parsed = await parseRunBody(req, res);
      if (!parsed) return undefined;

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
        run = await createRun(parsed.code, { idleMs: config.runIdleMs, maxMs: config.runMaxMs });
      } catch {
        releaseSlot();
        return json(res, 500, { status: 'error', error: 'Could not start the run.' });
      }
      run.done.then(() => releaseSlot());
      // Pre-filled input (from the Input box) is delivered immediately.
      if (parsed.stdin) run.write(parsed.stdin.endsWith('\n') ? parsed.stdin : `${parsed.stdin}\n`);
      return json(res, 200, { runId: run.id });
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
      let body;
      try {
        body = await readBody(req, config.maxStdinBytes + 4096);
      } catch {
        return json(res, 413, { status: 'error', error: 'Input too large.' });
      }
      let payload;
      try { payload = JSON.parse(body || '{}'); } catch { payload = {}; }
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

    if (req.method === 'GET' || req.method === 'HEAD') {
      return serveStatic(req, res);
    }

    res.writeHead(405, { Allow: 'GET, POST', ...SECURITY_HEADERS });
    res.end('Method not allowed');
    return undefined;
  } catch {
    return json(res, 500, { status: 'error', error: 'Internal server error.' });
  }
});

server.listen(config.port, config.host, () => {
  // eslint-disable-next-line no-console
  console.log(`Mobile Py IDE running at http://${config.host}:${config.port}`);
  console.log(`  interactive=on  idle=${config.runIdleMs}ms  max=${config.runMaxMs}ms  memory=${config.memoryLimitMb}MB  strict=${config.strictMode}`);
});

export default server;
