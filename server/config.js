// Central configuration for the Mobile Py IDE backend.
// Every value can be overridden with an environment variable (see .env.example).

function num(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function bool(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

function list(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

// Heavy or OS/network/process-capable modules that are always refused.
const BASE_BLOCKED = [
  // Heavy ML / data libraries (would blow the memory limit and CPU)
  'torch', 'tensorflow', 'tf', 'keras', 'transformers', 'jax', 'jaxlib',
  'cv2', 'sklearn', 'scipy', 'pandas', 'matplotlib', 'seaborn', 'plotly',
  'bokeh', 'numba', 'cupy', 'nltk', 'spacy',
  // OS / process / memory access
  'subprocess', 'ctypes', 'multiprocessing', 'resource', 'signal', 'mmap',
  'os', 'posix', 'pwd', 'grp', 'pty', 'tty', 'termios',
  // Network
  'socket', 'socketserver', 'ssl', 'ftplib', 'smtplib', 'telnetlib',
  'paramiko', 'pexpect', 'webbrowser',
  // Dynamic import / serialization escapes
  'importlib', 'runpy', 'pkgutil', 'pydoc', 'pickle', 'shelve', 'marshal',
];

// Modules that are safe to import (used only when STRICT_MODE=true).
const BASE_ALLOWED = [
  'math', 'cmath', 'random', 'statistics', 'decimal', 'fractions', 'numbers',
  'json', 'csv', 're', 'string', 'textwrap', 'pprint', 'difflib',
  'datetime', 'time', 'calendar', 'zoneinfo',
  'itertools', 'functools', 'operator', 'collections', 'heapq', 'bisect',
  'copy', 'array', 'struct', 'enum', 'dataclasses', 'typing', 'abc',
  'contextlib', 'warnings', 'traceback', 'uuid', 'hashlib', 'hmac', 'base64',
  'binascii', 'unicodedata', 'secrets', 'io', 'sys', 'code',
  // Light third-party libraries that are commonly pre-installed
  'numpy', 'requests',
];

// Light, popular packages that may be installed from the IDE. Heavy ones
// (torch, pandas, ...) are deliberately absent.
const BASE_PACKAGES = [
  'requests', 'rich', 'tabulate', 'colorama', 'termcolor', 'pyfiglet', 'art',
  'cowsay', 'emoji', 'tqdm', 'pytz', 'python-dateutil', 'six', 'attrs',
  'click', 'typer', 'humanize', 'prettytable', 'texttable', 'pyyaml', 'toml',
  'python-dotenv', 'more-itertools', 'sortedcontainers', 'faker', 'validators',
  'markdown', 'jinja2', 'qrcode', 'names', 'wonderwords', 'halo',
  'alive-progress', 'questionary', 'rich-argparse',
];

const config = {
  // HTTP
  host: process.env.HOST || '127.0.0.1',
  port: num('PORT', 3000),

  // Execution limits
  timeoutMs: num('TIMEOUT_MS', 5000),
  memoryLimitMb: num('MEMORY_LIMIT_MB', 128),
  maxCodeBytes: num('MAX_CODE_BYTES', 100 * 1024),
  maxStdinBytes: num('MAX_STDIN_BYTES', 20 * 1024),
  maxOutputBytes: num('MAX_OUTPUT_BYTES', 100 * 1024),
  pythonBin: process.env.PYTHON_BIN || 'python3',

  // Interactive runs (streaming): killed after this much inactivity with no
  // output and no input, and hard-killed at the absolute cap.
  runIdleMs: num('RUN_IDLE_MS', 30000),
  runMaxMs: num('RUN_MAX_MS', 120000),
  // How long a finished run is kept so a late SSE subscriber still gets its
  // output (a fast program can finish before the browser attaches).
  runRetainMs: num('RUN_RETAIN_MS', 60000),

  // REPL / terminal sessions stay open much longer (you are thinking).
  replIdleMs: num('REPL_IDLE_MS', 300000),
  replMaxMs: num('REPL_MAX_MS', 1800000),

  // A real shell on the server. OFF by default: only enable it if the IDE is
  // kept private (e.g. behind Cloudflare Access).
  allowTerminal: bool('ALLOW_TERMINAL', false),
  terminalMemoryMb: num('TERMINAL_MEMORY_MB', 512),

  // Installing allow-listed packages from the IDE.
  allowPackageInstall: bool('ALLOW_PACKAGE_INSTALL', true),
  packageMemoryMb: num('PACKAGE_MEMORY_MB', 768),
  packageTimeoutMs: num('PACKAGE_TIMEOUT_MS', 120000),
  packageAllowlist: [...BASE_PACKAGES, ...list('EXTRA_PACKAGES', [])],

  // Sandbox hardening
  // DISABLE_NETWORK needs either root or working user-namespaces (see README).
  disableNetwork: bool('DISABLE_NETWORK', false),
  runAsUid: process.env.RUN_AS_UID ? Number(process.env.RUN_AS_UID) : undefined,
  runAsGid: process.env.RUN_AS_GID ? Number(process.env.RUN_AS_GID) : undefined,

  // Rate limiting (per client IP)
  rateWindowMs: num('RATE_WINDOW_MS', 60 * 1000),
  rateMax: num('RATE_MAX', 60),

  // Concurrency guard — protects a small (e.g. 2 GB) server from memory
  // pressure by running only a few programs at once and queueing the rest.
  maxConcurrentRuns: num('MAX_CONCURRENT_RUNS', 2),
  maxQueue: num('MAX_QUEUE', 8),

  // Validation policy
  // STRICT_MODE=true -> only modules in allowedModules may be imported.
  strictMode: bool('STRICT_MODE', false),
  // UNBLOCK_MODULES removes names from the built-in blocked list (e.g. if you
  // install pandas yourself on a big-enough server).
  blockedModules: (() => {
    const unblock = new Set(list('UNBLOCK_MODULES', []));
    return [...BASE_BLOCKED, ...list('EXTRA_BLOCKED_MODULES', [])].filter((m) => !unblock.has(m));
  })(),
  allowedModules: [...BASE_ALLOWED, ...list('EXTRA_ALLOWED_MODULES', [])],
};

export default config;
