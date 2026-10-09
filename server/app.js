// Mobile Py IDE — HTTP server.
//
// Zero npm dependencies: only Node's built-in modules. Serves the static
// frontend from ../public and exposes two API routes:
//   GET  /api/health -> { ok: true, ... }
//   POST /api/run    -> { code, stdin } -> execution result

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from './config.js';
import { validate } from './validator.js';
import { execute } from './executor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
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

// --- concurrency guard ----------------------------------------------
// Keeps at most `maxConcurrentRuns` programs executing at once and holds
// the rest in a bounded queue. Important on a small server: N concurrent
// runs each capped at MEMORY_LIMIT_MB would otherwise add up fast.
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
  if (next) next(); // hand the slot straight to the next waiter
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

// --- request routing ----------------------------------------------------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/api/health') {
      return json(res, 200, {
        ok: true,
        service: 'mobile-py-ide',
        timeout_ms: config.timeoutMs,
        memory_limit_mb: config.memoryLimitMb,
        strict_mode: config.strictMode,
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/run') {
      if (isRateLimited(clientIp(req))) {
        return json(res, 429, { status: 'error', error: 'Too many requests, please slow down.' });
      }

      const limit = config.maxCodeBytes + config.maxStdinBytes + 8192;
      let body;
      try {
        body = await readBody(req, limit);
      } catch (e) {
        const tooLarge = e.message === 'PAYLOAD_TOO_LARGE';
        return json(res, tooLarge ? 413 : 400, {
          status: 'error',
          error: tooLarge ? 'Request body too large.' : 'Could not read request body.',
        });
      }

      let payload;
      try {
        payload = JSON.parse(body || '{}');
      } catch {
        return json(res, 400, { status: 'error', error: 'Invalid JSON body.' });
      }

      const code = typeof payload.code === 'string' ? payload.code : '';
      const stdin = typeof payload.stdin === 'string' ? payload.stdin : '';

      if (Buffer.byteLength(stdin, 'utf8') > config.maxStdinBytes) {
        return json(res, 413, { status: 'error', error: 'stdin is too large.' });
      }

      const verdict = validate(code);
      if (!verdict.ok) {
        return json(res, 400, { status: 'rejected', error: `Error: ${verdict.reason}` });
      }

      try {
        await acquireSlot();
      } catch {
        return json(res, 429, {
          status: 'error',
          error: 'Server is busy running other programs. Please try again in a moment.',
        });
      }

      try {
        const result = await execute({ code, stdin });
        return json(res, 200, result);
      } finally {
        releaseSlot();
      }
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      return serveStatic(req, res);
    }

    res.writeHead(405, { Allow: 'GET, POST', ...SECURITY_HEADERS });
    res.end('Method not allowed');
  } catch (err) {
    json(res, 500, { status: 'error', error: 'Internal server error.' });
  }
});

server.listen(config.port, config.host, () => {
  // eslint-disable-next-line no-console
  console.log(`Mobile Py IDE running at http://${config.host}:${config.port}`);
  console.log(`  timeout=${config.timeoutMs}ms  memory=${config.memoryLimitMb}MB  strict=${config.strictMode}`);
});

export default server;
