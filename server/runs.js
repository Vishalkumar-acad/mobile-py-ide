// Interactive, streaming Python run engine.
//
// Unlike a one-shot subprocess, a Run stays alive so the browser can stream
// its output and feed stdin while it is running — that is what makes input()
// work like a real terminal. Runs are resource-limited the same way as
// before (CPU, virtual memory, wall-clock, output cap) and are always
// cleaned up, no matter how they end.

import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import config from './config.js';

const runs = new Map();
const LOG_CAP = 800;

export function getRun(id) {
  return runs.get(id);
}

export function activeRunCount() {
  return runs.size;
}

function buildCommand(filePath) {
  const memKb = Math.max(16, Math.round(config.memoryLimitMb)) * 1024;
  const cpuSec = Math.max(2, Math.ceil(config.runMaxMs / 1000) + 2);
  // ulimit is best-effort: ignore failures so we still run on odd shells.
  const limits = `ulimit -v ${memKb} 2>/dev/null; ulimit -t ${cpuSec} 2>/dev/null; ulimit -f 2048 2>/dev/null;`;
  // -I isolated, -B no .pyc, -q quiet, -u unbuffered (so output streams live)
  const run = `${config.disableNetwork ? 'unshare -n ' : 'exec '}${JSON.stringify(config.pythonBin)} -I -B -q -u "$1"`;
  return `${limits} ${run}`;
}

/**
 * Start a Python program.
 * @param {string} code
 * @param {{idleMs?: number, maxMs?: number}} [opts]
 * @returns {Promise<object>} a Run handle
 */
export async function createRun(code, opts = {}) {
  const idleMs = opts.idleMs ?? config.runIdleMs;
  const maxMs = opts.maxMs ?? config.runMaxMs;

  const id = crypto.randomBytes(9).toString('hex');
  const dir = await mkdtemp(path.join(tmpdir(), 'mobi-py-'));
  const file = path.join(dir, `exec_${crypto.randomBytes(6).toString('hex')}.py`);
  await writeFile(file, code, 'utf8');

  const listeners = new Set();
  const log = [];

  const run = {
    id,
    dir,
    startedAt: Date.now(),
    finished: false,
    truncated: false,
    outputBytes: 0,
    exitCode: null,
    status: null,
    elapsedMs: 0,
    stopReason: null,
    child: null,
    stdout: '',
    stderr: '',
  };

  let idleTimer = null;
  let hardTimer = null;
  let safetyTimer = null;
  let resolved = false;
  let resolveDone;
  run.done = new Promise((r) => { resolveDone = r; });

  function emit(evt) {
    log.push(evt);
    if (log.length > LOG_CAP) log.shift();
    for (const fn of [...listeners]) {
      try { fn(evt); } catch { /* a bad listener must not break the run */ }
    }
  }

  function killTree(sig = 'SIGKILL') {
    if (run.child && run.child.pid) {
      try { process.kill(-run.child.pid, sig); } catch { /* already gone */ }
    }
  }

  function stop(reason) {
    if (run.finished) return;
    run.stopReason = reason;
    killTree();
    // Backstop: if 'close' never fires, finalise anyway.
    if (!safetyTimer) safetyTimer = setTimeout(finalize, 3000);
  }

  function touchIdle() {
    if (run.finished) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => stop('idle'), idleMs);
  }

  function finalize() {
    if (run.finished) return;
    run.finished = true;
    clearTimeout(idleTimer);
    clearTimeout(hardTimer);
    clearTimeout(safetyTimer);
    try { if (run.child && run.child.stdin) run.child.stdin.end(); } catch { /* ignore */ }
    killTree();

    run.status = run.stopReason === 'timeout' ? 'timeout'
      : run.stopReason === 'idle' ? 'idle_timeout'
        : run.stopReason === 'output_limit' ? 'output_limit'
          : run.stopReason === 'killed' ? 'killed'
            : (run.exitCode === 0 ? 'success' : 'error');
    run.elapsedMs = Date.now() - run.startedAt;

    const evt = {
      type: 'exit',
      status: run.status,
      exit_code: run.exitCode,
      elapsed_ms: run.elapsedMs,
      truncated: run.truncated,
    };
    log.push(evt);
    for (const fn of [...listeners]) {
      try { fn(evt); } catch { /* ignore */ }
    }
    listeners.clear();
    runs.delete(run.id);
    rm(dir, { recursive: true, force: true }).catch(() => {});
    if (!resolved) { resolved = true; resolveDone(evt); }
  }

  function onData(stream, buf) {
    if (run.finished || run.truncated) return;
    const remaining = config.maxOutputBytes - run.outputBytes;
    if (remaining <= 0) { run.truncated = true; stop('output_limit'); return; }

    let text;
    if (buf.length >= remaining) {
      text = buf.subarray(0, remaining).toString('utf8');
      run.outputBytes = config.maxOutputBytes;
      run.truncated = true;
    } else {
      text = buf.toString('utf8');
      run.outputBytes += buf.length;
    }
    if (stream === 'stdout') run.stdout += text; else run.stderr += text;
    emit({ type: 'output', stream, text });

    if (run.truncated) {
      emit({ type: 'output', stream: 'stderr', text: '\n… output limit reached, stopping.\n' });
      stop('output_limit');
      return;
    }
    touchIdle();
  }

  const env = {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    HOME: dir,
    TMPDIR: dir,
    PYTHONIOENCODING: 'utf-8',
    PYTHONDONTWRITEBYTECODE: '1',
  };

  try {
    run.child = spawn('bash', ['-c', buildCommand(file), 'mobi-py', file], {
      cwd: dir,
      env,
      detached: true,
      uid: config.runAsUid,
      gid: config.runAsGid,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    emit({ type: 'output', stream: 'stderr', text: `Failed to start runner: ${err.message}\n` });
    run.stopReason = 'killed';
    finalize();
    return run;
  }

  const child = run.child;
  child.stdin.on('error', () => { /* EPIPE once the program exits — ignore */ });
  child.stdout.on('data', (b) => onData('stdout', b));
  child.stderr.on('data', (b) => onData('stderr', b));
  child.on('error', (e) => {
    emit({ type: 'output', stream: 'stderr', text: `Runner error: ${e.message}\n` });
    stop('killed');
  });
  child.on('close', (exitCode) => { run.exitCode = exitCode; finalize(); });

  run.write = (data) => {
    if (run.finished || !run.child) return false;
    try {
      run.child.stdin.write(data);
      touchIdle();
      return true;
    } catch {
      return false;
    }
  };

  run.endInput = () => {
    if (run.finished || !run.child) return;
    try { run.child.stdin.end(); } catch { /* ignore */ }
  };

  run.kill = () => stop('killed');

  run.subscribe = (fn) => {
    for (const evt of log) {
      try { fn(evt); } catch { /* ignore */ }
    }
    if (run.finished) return () => {};
    listeners.add(fn);
    return () => listeners.delete(fn);
  };

  runs.set(run.id, run);
  touchIdle();
  hardTimer = setTimeout(() => stop('timeout'), maxMs);
  return run;
}
