// A small self-check, so the server can tell you what it has.
// Exposed at GET /api/diag and printed by the deploy workflow.

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import config from './config.js';
import { listFiles } from './files.js';

function run(cmd, args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: (stdout || '').trim(), err: (stderr || '').trim() });
    });
  });
}

export async function diagnostics() {
  const out = {
    service: 'pypad',
    uptime_s: Math.round(process.uptime()),
    node: process.version,
  };

  // Python that the runner uses
  out.python_bin = config.pythonBin;
  const pv = await run(config.pythonBin, ['-V']);
  out.python_ok = pv.ok;
  out.python_version = pv.out || pv.err;

  // pip (needed for the Packages button)
  const pip = await run(config.pythonBin, ['-m', 'pip', '--version']);
  out.pip_ok = pip.ok;
  out.pip_version = (pip.out || pip.err).split('\n')[0];

  // Workspace: exists, and can the service actually write to it?
  out.workspace_dir = config.workspaceDir;
  out.workspace_exists = false;
  out.workspace_writable = false;
  out.workspace_error = null;
  try {
    await fs.mkdir(config.workspaceDir, { recursive: true });
    out.workspace_exists = true;
    const probe = path.join(config.workspaceDir, `.diag-${Date.now()}`);
    await fs.writeFile(probe, 'ok');
    await fs.rm(probe, { force: true });
    out.workspace_writable = true;
  } catch (e) {
    out.workspace_error = e.code || e.message;
  }
  try {
    const { files, total, limit } = await listFiles();
    out.workspace_files = files.length;
    out.workspace_bytes = total;
    out.workspace_limit_mb = Math.round(limit / (1024 * 1024));
  } catch { /* ignore */ }

  // Features
  out.allow_file_access = config.allowFileAccess;
  out.allow_terminal = config.allowTerminal;
  out.allow_package_install = config.allowPackageInstall;
  out.package_count = config.packageAllowlist.length;
  out.memory_limit_mb = config.memoryLimitMb;

  return out;
}
