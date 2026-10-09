// Secure-ish execution of a single Python program.
//
// The code is written to a fresh temp file, run as an isolated, resource
// limited subprocess (CPU time, virtual memory, wall-clock timeout, minimal
// environment), and the temp directory is removed afterwards no matter what.

import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import config from './config.js';

// Collect a stream, capped at `limit` bytes so a runaway print() loop
// cannot exhaust the server's memory.
function makeCollector(limit) {
  let chunks = [];
  let size = 0;
  let truncated = false;
  return {
    push(buf) {
      if (truncated) return;
      const remaining = limit - size;
      if (buf.length >= remaining) {
        chunks.push(buf.subarray(0, remaining));
        size = limit;
        truncated = true;
      } else {
        chunks.push(buf);
        size += buf.length;
      }
    },
    finish() {
      return { text: Buffer.concat(chunks).toString('utf8'), truncated };
    },
  };
}

function buildCommand(filePath) {
  const memKb = Math.max(16, Math.round(config.memoryLimitMb)) * 1024;
  const cpuSec = Math.max(1, Math.ceil(config.timeoutMs / 1000) + 1);
  // ulimit is best-effort: ignore failures so we still run if the shell
  // does not support a particular limit.
  const limits = `ulimit -v ${memKb} 2>/dev/null; ulimit -t ${cpuSec} 2>/dev/null; ulimit -f 2048 2>/dev/null;`;
  // -I: isolated mode (ignore PYTHON* env vars, no user site-packages)
  // -B: do not write .pyc files
  // -q: quiet
  const run = `${config.disableNetwork ? 'unshare -n ' : 'exec '}${JSON.stringify(config.pythonBin)} -I -B -q "$1"`;
  return `${limits} ${run}`;
}

/**
 * Run `code` with optional `stdin` under the configured sandbox limits.
 * @param {{code: string, stdin?: string}} params
 * @returns {Promise<object>}
 */
export async function execute({ code, stdin = '' }) {
  const dir = await mkdtemp(path.join(tmpdir(), 'mobi-py-'));
  const file = path.join(dir, `exec_${crypto.randomBytes(6).toString('hex')}.py`);
  await writeFile(file, code, 'utf8');

  const script = buildCommand(file);
  const startedAt = Date.now();

  const env = {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    HOME: dir,
    TMPDIR: dir,
    PYTHONIOENCODING: 'utf-8',
    PYTHONDONTWRITEBYTECODE: '1',
  };

  const result = await new Promise((resolve) => {
    let child;
    try {
      child = spawn('bash', ['-c', script, 'mobi-py', file], {
        cwd: dir,
        env,
        detached: true, // own process group, so we can kill the whole tree
        uid: config.runAsUid,
        gid: config.runAsGid,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ spawnError: err.message });
      return;
    }

    const out = makeCollector(config.maxOutputBytes);
    const err = makeCollector(config.maxOutputBytes);
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    }, config.timeoutMs);

    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));

    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ spawnError: e.message });
    });

    child.on('close', (code_, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const o = out.finish();
      const e = err.finish();
      resolve({
        exitCode: code_,
        signal,
        timedOut,
        stdout: o.text,
        stderr: e.text,
        truncated: o.truncated || e.truncated,
      });
    });

    if (stdin) {
      child.stdin.write(stdin);
    }
    child.stdin.end();
  });

  const elapsedMs = Date.now() - startedAt;

  // Cleanup — always.
  try { await rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }

  if (result.spawnError) {
    return {
      status: 'error',
      stdout: '',
      stderr: `Failed to start runner: ${result.spawnError}`,
      exit_code: null,
      execution_time: `${(elapsedMs / 1000).toFixed(2)}s`,
      execution_time_ms: elapsedMs,
      truncated: false,
    };
  }

  let status = 'success';
  if (result.timedOut) status = 'timeout';
  else if (result.exitCode !== 0) status = 'error';

  const stderr = result.timedOut
    ? `${result.stderr}\n⏱ Execution stopped: exceeded ${config.timeoutMs} ms limit.`.trim()
    : result.stderr;

  return {
    status,
    stdout: result.stdout,
    stderr,
    output: result.stdout, // convenience alias used by simple clients
    exit_code: result.exitCode,
    execution_time: `${(elapsedMs / 1000).toFixed(2)}s`,
    execution_time_ms: elapsedMs,
    truncated: result.truncated,
  };
}
