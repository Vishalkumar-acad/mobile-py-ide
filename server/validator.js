// Pre-execution validation.
//
// Before any code reaches the runner we (a) reject oversized payloads,
// (b) strip out strings and comments so the checks cannot be fooled by
// text that merely *looks* like code, (c) refuse imports of blocked
// modules, and (d) refuse a set of dangerous calls / attribute accesses.

import config from './config.js';

// Patterns that are refused no matter which module they come from.
const BLOCKED_PATTERNS = [
  { re: /\b__import__\s*\(/, reason: 'dynamic import (__import__) is not allowed' },
  { re: /\beval\s*\(/, reason: 'eval() is not allowed' },
  { re: /\bexec\s*\(/, reason: 'exec() is not allowed' },
  { re: /\bcompile\s*\(/, reason: 'compile() is not allowed' },
  { re: /\bopen\s*\(/, reason: 'file access via open() is not allowed', fileAccess: true },
  { re: /\bglobals\s*\(/, reason: 'globals() is not allowed' },
  { re: /\blocals\s*\(/, reason: 'locals() is not allowed' },
  { re: /\bbreakpoint\s*\(/, reason: 'breakpoint() is not allowed' },
  { re: /\bsetattr\s*\(/, reason: 'setattr() is not allowed' },
  { re: /\bdelattr\s*\(/, reason: 'delattr() is not allowed' },
  { re: /__subclasses__/, reason: 'sandbox-escape attribute (__subclasses__) is not allowed' },
  { re: /__globals__/, reason: 'sandbox-escape attribute (__globals__) is not allowed' },
  { re: /__builtins__/, reason: 'sandbox-escape attribute (__builtins__) is not allowed' },
  { re: /__bases__/, reason: 'sandbox-escape attribute (__bases__) is not allowed' },
  { re: /__mro__/, reason: 'sandbox-escape attribute (__mro__) is not allowed' },
  { re: /__class__/, reason: 'sandbox-escape attribute (__class__) is not allowed' },
  { re: /__getattribute__/, reason: 'sandbox-escape attribute (__getattribute__) is not allowed' },
  { re: /__reduce__/, reason: 'sandbox-escape attribute (__reduce__) is not allowed' },
  { re: /__code__/, reason: 'sandbox-escape attribute (__code__) is not allowed' },
  // Process / system calls. `os` is importable now (for file work), so these are
  // blocked by name — however they are reached, including aliases and
  // `from os import system`.
  {
    re: /\b(system|popen|fork|forkpty|kill|killpg|setuid|setgid|seteuid|setegid|setreuid|setregid|setgroups|chroot|_exit|execl|execle|execlp|execlpe|execv|execve|execvp|execvpe|spawnl|spawnle|spawnlp|spawnlpe|spawnv|spawnve|spawnvp|spawnvpe)\s*\(/,
    reason: 'process/system calls are not allowed',
  },
];

// Replace comments and string literals with spaces so the regex checks
// below only ever see real code.
function stripStringsAndComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    // Triple-quoted strings.
    if ((c === '"' || c === "'") && src[i + 1] === c && src[i + 2] === c) {
      const q = c + c + c;
      let j = src.indexOf(q, i + 3);
      j = j === -1 ? n : j + 3;
      out += ' '.repeat(j - i);
      i = j;
      continue;
    }
    // Single-quoted strings.
    if (c === '"' || c === "'") {
      const q = c;
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === q) { j += 1; break; }
        if (src[j] === '\n') break;
        j += 1;
      }
      out += ' '.repeat(j - i);
      i = j;
      continue;
    }
    // Comments.
    if (c === '#') {
      let j = src.indexOf('\n', i);
      j = j === -1 ? n : j;
      out += ' '.repeat(j - i);
      i = j;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

// Collect the top-level module names that a piece of (stripped) code imports.
function collectImports(stripped) {
  const mods = new Set();
  for (const rawLine of stripped.split('\n')) {
    const line = rawLine.trim();
    let m = line.match(/^import\s+(.+)$/);
    if (m) {
      for (const part of m[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/)[0].trim();
        if (name) mods.add(name.split('.')[0]);
      }
      continue;
    }
    m = line.match(/^from\s+([A-Za-z_][\w.]*)\s+import\s+/);
    if (m) mods.add(m[1].split('.')[0]);
  }
  return mods;
}

/**
 * Validate a chunk of Python source.
 * @param {string} code
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function validate(code) {
  if (typeof code !== 'string') return { ok: false, reason: 'code must be a string' };
  if (code.trim().length === 0) return { ok: false, reason: 'no code to run' };
  if (Buffer.byteLength(code, 'utf8') > config.maxCodeBytes) {
    return { ok: false, reason: `code is too large (limit ${config.maxCodeBytes} bytes)` };
  }

  const stripped = stripStringsAndComments(code);

  // Blocked modules.
  const imports = collectImports(stripped);
  const blocked = new Set(config.blockedModules);
  for (const mod of imports) {
    if (blocked.has(mod)) {
      return { ok: false, reason: `importing '${mod}' is not allowed` };
    }
  }

  // Whitelist mode.
  if (config.strictMode) {
    const allowed = new Set(config.allowedModules);
    for (const mod of imports) {
      if (!allowed.has(mod)) {
        return { ok: false, reason: `module '${mod}' is not in the allow-list (STRICT_MODE is on)` };
      }
    }
  }

  // Dangerous calls / attributes. When file access is enabled, open() is
  // allowed — writes are still confined to the workspace by the systemd sandbox.
  for (const { re, reason, fileAccess } of BLOCKED_PATTERNS) {
    if (fileAccess && config.allowFileAccess) continue;
    if (re.test(stripped)) return { ok: false, reason };
  }

  return { ok: true };
}

export { stripStringsAndComments, collectImports };
