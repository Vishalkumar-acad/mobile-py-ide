// Installing allow-listed Python packages from the IDE.
//
// Only names on the allow-list are accepted, and pip runs with a memory cap
// and a timeout. This is deliberately narrow: letting a web page install
// arbitrary code onto the server would be a security hole, and a heavy
// package can exhaust a small machine.

import { spawn } from 'node:child_process';
import config from './config.js';

// pip package names: letters, digits, dot, dash, underscore.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function norm(n) {
  return String(n).toLowerCase().replace(/_/g, '-');
}

export function allowlist() {
  return config.packageAllowlist;
}

export function isAllowed(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) return false;
  return config.packageAllowlist.some((p) => norm(p) === norm(name));
}

/**
 * @param {string} name
 * @returns {Promise<{ok: boolean, output?: string, error?: string}>}
 */
export function installPackage(name) {
  if (!config.allowPackageInstall) {
    return Promise.resolve({ ok: false, error: 'Package installation is turned off on this server.' });
  }
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    return Promise.resolve({ ok: false, error: 'That is not a valid package name.' });
  }
  if (!isAllowed(name)) {
    return Promise.resolve({
      ok: false,
      error: `'${name}' is not on the allowed list. (Heavy libraries are never allowed.)`,
    });
  }

  const memKb = Math.max(64, Math.round(config.packageMemoryMb)) * 1024;
  const cpuSec = Math.max(10, Math.ceil(config.packageTimeoutMs / 1000) + 2);
  // `name` is already constrained to a safe character set, so this is safe.
  const script =
    `ulimit -v ${memKb} 2>/dev/null; ulimit -t ${cpuSec} 2>/dev/null; ` +
    `exec ${config.pythonBin} -m pip install --no-input --disable-pip-version-check --no-cache-dir ${name}`;

  return new Promise((resolve) => {
    // Minimal environment, but pass through proxy settings if the host uses one.
    const env = {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      HOME: process.env.HOME || '/tmp',
      PIP_DISABLE_PIP_VERSION_CHECK: '1',
    };
    for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy']) {
      if (process.env[k]) env[k] = process.env[k];
    }

    let child;
    try {
      child = spawn('bash', ['-c', script], {
        env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ ok: false, error: `Could not start pip: ${err.message}` });
      return;
    }

    let out = '';
    let done = false;
    const cap = config.maxOutputBytes;
    const collect = (b) => {
      if (out.length < cap) out += b.toString('utf8').slice(0, cap - out.length);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
      resolve({ ok: false, error: `pip timed out after ${config.packageTimeoutMs} ms.`, output: out });
    }, config.packageTimeoutMs);

    child.on('error', (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: false, error: `pip failed to start: ${e.message}` });
    });

    child.on('close', (exitCode) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(exitCode === 0
        ? { ok: true, output: out }
        : { ok: false, error: 'pip reported an error.', output: out });
    });
  });
}
