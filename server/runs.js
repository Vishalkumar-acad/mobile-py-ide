// Interactive, streaming run engine.
//
// A Run stays alive so the browser can stream its output and feed stdin while
// it is running — that is what makes input() (and the REPL and terminal modes)
// work like a real terminal. Runs are resource-limited and always cleaned up.

import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import config from './config.js';
import { PTY_DRIVER } from './pty.js';

const runs = new Map();
const LOG_CAP = 800;
// Finished runs are kept briefly (see finalize) so a late subscriber still gets
// their output; this bounds how many are held.
const MAX_RETAINED = 100;
const finishedOrder = [];

export function getRun(id) {
  return runs.get(id);
}

export function activeRunCount() {
  return runs.size;
}

// Stop every live run that belongs to one visitor, and wait (briefly) for them
// to actually go, so the slot is free before the next run asks for it.
export async function killRunsForSpace(spaceId) {
  if (!spaceId) return 0;
  const victims = [];
  for (const run of runs.values()) {
    if (run.spaceId === spaceId && !run.finished) {
      run.kill();
      victims.push(run.done);
    }
  }
  if (victims.length) {
    await Promise.race([
      Promise.all(victims),
      new Promise((resolve) => { setTimeout(resolve, 2000).unref(); }),
    ]);
  }
  return victims.length;
}

// kind: 'python' runs the given code file; 'bash' starts a shell reading
// commands from stdin; 'pty' gives a real pseudoterminal (Terminal and REPL).
function buildCommand({ filePath, kind, memoryMb, maxMs, ptyCmd }) {
  const memKb = Math.max(16, Math.round(memoryMb)) * 1024;
  const cpuSec = Math.max(2, Math.ceil(maxMs / 1000) + 2);
  const fileBlocks = Math.max(64, Math.round(config.maxFileMb)) * 2048; // 512-byte blocks
  const limits = `ulimit -v ${memKb} 2>/dev/null; ulimit -t ${cpuSec} 2>/dev/null; ulimit -f ${fileBlocks} 2>/dev/null;`;

  if (kind === 'pty') {
    // $1 is the relay script; ptyCmd is the program it runs under the pty.
    const inner = String(ptyCmd || 'bash -i');
    return `${limits} exec ${JSON.stringify(config.pythonBin)} -u "$1" ${inner}`;
  }
  if (kind === 'bash') {
    return `${limits} exec bash --noprofile --norc -s`;
  }
  // -I isolated, -B no .pyc, -q quiet, -u unbuffered (so output streams live)
  const py = `${config.disableNetwork ? 'unshare -n ' : 'exec '}${JSON.stringify(config.pythonBin)} -I -B -q -u "$1"`;
  return `${limits} ${py}`;
}

/**
 * Start a program.
 * @param {string} code
 * @param {{idleMs?: number, maxMs?: number, kind?: 'python'|'bash', memoryMb?: number, cwd?: string}} [opts]
 * @returns {Promise<object>} a Run handle
 */
export async function createRun(code, opts = {}) {
  const idleMs = opts.idleMs ?? config.runIdleMs;
  const maxMs = opts.maxMs ?? config.runMaxMs;
  const kind = opts.kind === 'bash' ? 'bash' : (opts.kind === 'pty' ? 'pty' : 'python');
  const memoryMb = opts.memoryMb ?? config.memoryLimitMb;
  const workDir = opts.cwd || config.workspaceDir;
  const spaceId = opts.spaceId || null;
  const ptyCmd = opts.ptyCmd || 'bash -i';
  const raw = kind === 'pty';

  const id = crypto.randomBytes(9).toString('hex');
  // The caller's space is the working directory, so files written with a
  // relative path land there and survive between runs. Scratch files (and the
  // .py itself) go in a temp dir that is removed afterwards.
  await mkdir(workDir, { recursive: true }).catch(() => {});
  const dir = await mkdtemp(path.join(tmpdir(), 'mobi-py-'));
  let file = null;
  if (kind === 'python') {
    file = path.join(dir, `exec_${crypto.randomBytes(6).toString('hex')}.py`);
    await writeFile(file, code, 'utf8');
  } else if (kind === 'pty') {
    file = path.join(dir, `pty_${crypto.randomBytes(6).toString('hex')}.py`);
    await writeFile(file, PTY_DRIVER, 'utf8');
  }

  const listeners = new Set();
  const log = [];

  const run = {
    id,
    dir,
    kind,
    spaceId,
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
    // A fast program can finish before the browser has attached to /events.
    // Keep the run (and its replayed log) around for a while so the late
    // subscriber gets the output instead of a 404.
    finishedOrder.push(run.id);
    while (finishedOrder.length > MAX_RETAINED) {
      const old = finishedOrder.shift();
      if (old !== run.id) runs.delete(old);
    }
    setTimeout(() => {
      const i = finishedOrder.indexOf(run.id);
      if (i !== -1) finishedOrder.splice(i, 1);
      runs.delete(run.id);
    }, config.runRetainMs).unref();
    rm(dir, { recursive: true, force: true }).catch(() => {});
    if (!resolved) { resolved = true; resolveDone(evt); }
  }

  function onData(stream, buf) {
    if (run.finished || run.truncated) return;
    const remaining = config.maxOutputBytes - run.outputBytes;
    if (remaining <= 0) { run.truncated = true; stop('output_limit'); return; }

    let piece = buf;
    if (piece.length >= remaining) {
      piece = piece.subarray(0, remaining);
      run.outputBytes = config.maxOutputBytes;
      run.truncated = true;
    } else {
      run.outputBytes += piece.length;
    }

    if (raw) {
      // A terminal stream is bytes, not text — send it base64 so nothing is lost.
      emit({ type: 'output', raw: true, b64: piece.toString('base64') });
    } else {
      const text = piece.toString('utf8');
      if (stream === 'stdout') run.stdout += text; else run.stderr += text;
      emit({ type: 'output', stream, text });
    }

    if (run.truncated) {
      if (!raw) emit({ type: 'output', stream: 'stderr', text: '\n… output limit reached, stopping.\n' });
      stop('output_limit');
      return;
    }
    touchIdle();
  }

  const env = {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    HOME: workDir,
    TMPDIR: dir,
    PYTHONIOENCODING: 'utf-8',
    PYTHONDONTWRITEBYTECODE: '1',
    TERM: 'dumb',
    PS1: '',
  };
  if (raw) {
    env.TERM = 'xterm-256color';
    env.PTY_COLS = String(Math.max(20, Math.min(500, opts.cols || 100)));
    env.PTY_ROWS = String(Math.max(5, Math.min(200, opts.rows || 30)));
    env.PS1 = '$ ';
  }

  const argv = kind === 'bash'
    ? ['-c', buildCommand({ kind, memoryMb, maxMs })]
    : ['-c', buildCommand({ kind, memoryMb, maxMs, filePath: file, ptyCmd }), 'mobi-py', file];

  try {
    run.child = spawn('bash', argv, {
      cwd: workDir,
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

  run.writeRaw = (data) => {
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
