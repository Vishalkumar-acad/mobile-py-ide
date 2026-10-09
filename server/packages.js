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

// The module you import is often not the distribution you install: `import
// slugify` comes from the python-slugify distribution. (The bare `slugify`
// package on PyPI is a Python-2 leftover from 2010 and does not run on
// Python 3.) Accept either spelling so nobody has to know that.
const ALIASES = {
  slugify: 'python-slugify',
};

function resolveName(name) {
  return ALIASES[norm(name)] || name;
}

export function allowlist() {
  return config.packageAllowlist;
}

export function isAllowed(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) return false;
  const target = resolveName(name);
  return config.packageAllowlist.some((p) => norm(p) === norm(target));
}

/**
 * @param {string} name
 * @returns {Promise<{ok: boolean, output?: string, error?: string}>}
 */
function runPip(args, timeoutMs) {
  const memKb = Math.max(64, Math.round(config.packageMemoryMb)) * 1024;
  const cpuSec = Math.max(10, Math.ceil(timeoutMs / 1000) + 2);
  // `args` is built from a name already constrained to a safe character set.
  const script =
    `ulimit -v ${memKb} 2>/dev/null; ulimit -t ${cpuSec} 2>/dev/null; ` +
    `exec ${config.pythonBin} -m pip ${args}`;

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
      resolve({ ok: false, error: `pip timed out after ${timeoutMs} ms.`, output: out });
    }, timeoutMs);

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
  const target = resolveName(name);
  return runPip(
    `install --no-input --disable-pip-version-check --no-cache-dir ${target}`,
    config.packageTimeoutMs,
  );
}

// Removing a package is not a security question — anything installed can be
// taken back out — so this accepts any well-formed name, not just the list.
export function uninstallPackage(name) {
  if (!config.allowPackageInstall) {
    return Promise.resolve({ ok: false, error: 'Package changes are turned off on this server.' });
  }
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    return Promise.resolve({ ok: false, error: 'That is not a valid package name.' });
  }
  const target = resolveName(name);
  return runPip(`uninstall --yes --disable-pip-version-check ${target}`, config.packageTimeoutMs);
}

// What is actually installed in the venv, so the UI can offer to remove it.
// pip and its own scaffolding are noise here, so they are left out.
const HIDDEN = new Set(['pip', 'setuptools', 'wheel', 'pkg-resources', 'pkg_resources']);

export function listInstalled() {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(config.pythonBin, ['-m', 'pip', 'list', '--format=freeze', '--disable-pip-version-check'], {
        env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: process.env.HOME || '/tmp' },
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      resolve([]);
      return;
    }
    let out = '';
    child.stdout.on('data', (b) => { if (out.length < 20000) out += b.toString('utf8'); });
    child.on('error', () => resolve([]));
    child.on('close', () => {
      const list = out.split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'))
        .map((l) => {
          const [name, version] = l.split('==');
          return { name, version: version || '' };
        })
        .filter((p) => p.name && !HIDDEN.has(p.name.toLowerCase()));
      resolve(list);
    });
  });
}
