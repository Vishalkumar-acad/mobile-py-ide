// Mobile Py IDE — frontend.
//
// Loads CodeMirror 6 from a CDN for a real editor, with a plain-textarea
// fallback if that fails. Runs code through the streaming API so that
// input() works live: the program prints a prompt, you type a line and press
// Enter, and it continues — just like a terminal.

// index.html loads us as main.js?v=<build>. Carry that same stamp to the files
// we import, or a cached copy of one of them could still be served after a
// deploy — which is exactly how a fix can look like it did not work.
const BUILD_QUERY = new URL(import.meta.url).search;
let dl;
try {
  dl = await import(`./download.js${BUILD_QUERY}`);
} catch {
  dl = await import('./download.js'); // unstamped fallback
}
const { downloadPython, pythonFilename, canShareFiles, sharePython, copyText } = dl;

const DEFAULT_CODE = `# Mobile Py IDE — a live console
name = input("What is your name? ")
print("Hello,", name, "!")

for i in range(1, 4):
    print(i, "squared is", i * i)
`;

const STORAGE_CODE = 'mobi-py-code';
const STORAGE_STDIN = 'mobi-py-stdin';

const $ = (sel) => document.querySelector(sel);
const editorMount = $('#editorMount');
const fallback = $('#editorFallback');
const output = $('#output');
const statusEl = $('#status');
const stdinEl = $('#stdin');
const runBtn = $('#runBtn');
const runLabel = $('#runLabel');
const runIcon = document.querySelector('.run-icon');
const clearBtn = $('#clearBtn');
const fileNameInput = $('#fileName');
const downloadBtn = $('#downloadBtn');
const saveMoreBtn = $('#saveMoreBtn');
const saveDialog = $('#saveDialog');
const saveDownload = $('#saveDownload');
const saveServer = $('#saveServer');
const saveShare = $('#saveShare');
const saveCopy = $('#saveCopy');
const saveOut = $('#saveOut');
const inputForm = $('#inputForm');
const inputLine = $('#inputLine');
const sendBtn = $('#sendBtn');
const posBtn = $('#posBtn');
const consolePanel = $('#console');
const prefillDetails = $('#prefillDetails');
const prefillCount = $('#prefillCount');
const prefillClear = $('#prefillClear');
const modebar = $('#modebar');
const editorPanel = $('#editor');
const codeTab = document.querySelector('.tab[data-tab="editor"]');
const inputRow = $('#inputForm');
const pkgBtn = $('#pkgBtn');
const pkgDialog = $('#pkgDialog');
const pkgInput = $('#pkgInput');
const pkgInstall = $('#pkgInstall');
const pkgOut = $('#pkgOut');
const pkgAllowed = $('#pkgAllowed');
const pkgInstalled = $('#pkgInstalled');
const filesBtn = $('#filesBtn');
const filesDialog = $('#filesDialog');
const fileInput = $('#fileInput');
const uploadBtn = $('#uploadBtn');
const fileList = $('#fileList');
const fileOut = $('#fileOut');

let cmView = null;
let usingCM = false;
let es = null;
let runId = null;
let outputEmpty = true;
let mode = 'script';
let receivedEvents = false;
// True when the run is under a real pseudoterminal, which changes what comes
// back (raw bytes, not text) and whether we need to echo what you type.
let runIsPty = false;
// Silence is ambiguous: a program may be thinking, or it may be waiting for a
// connection that will never come. Say something rather than show nothing.
let lastOutputAt = Date.now();
let quietNoted = false;
setInterval(() => {
  if (!runId) { quietNoted = false; return; }
  if (Date.now() - lastOutputAt < 10000) return;
  if (quietNoted) return;
  quietNoted = true;
  // Worded as information, not as a fault: sitting at a prompt is a perfectly
  // healthy silence, and this should not read like an error.
  appendOutput('… waiting — the session is still open. ■ Stop ends it.\n', 'muted');
}, 2000);
let spaceTtlHours = 24;
let filesAtStart = null;

/* ----------------------------- editor -------------------------------- */
function loadStored(key, def) {
  try { return localStorage.getItem(key) ?? def; } catch { return def; }
}
function getCode() {
  return usingCM ? cmView.state.doc.toString() : fallback.value;
}
function setCode(v) {
  if (usingCM) cmView.dispatch({ changes: { from: 0, to: cmView.state.doc.length, insert: v } });
  else fallback.value = v;
}

let saveTimer;
function saveCode() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(STORAGE_CODE, getCode()); } catch { /* quota */ }
  }, 400);
}

async function initEditor() {
  const initial = loadStored(STORAGE_CODE, DEFAULT_CODE);
  try {
    const [cm, py, theme] = await Promise.all([
      import('https://esm.sh/codemirror@6.0.1'),
      import('https://esm.sh/@codemirror/lang-python@6.1.6'),
      import('https://esm.sh/@codemirror/theme-one-dark@6.1.2'),
    ]);

    cmView = new cm.EditorView({
      doc: initial,
      extensions: [
        cm.basicSetup,
        py.python(),
        theme.oneDark,
        cm.EditorView.lineWrapping,
        cm.EditorView.theme({
          '&': { height: '100%', fontSize: '15px' },
          '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.5' },
          '.cm-content': { paddingBottom: '30vh' },
          '&.cm-focused': { outline: 'none' },
        }),
        cm.EditorView.updateListener.of((u) => { if (u.docChanged) saveCode(); }),
      ],
      parent: editorMount,
    });

    usingCM = true;
    editorMount.style.display = 'block';
    fallback.style.display = 'none';
    editorMount.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); onRunClick(); }
    });
  } catch (err) {
    console.warn('CodeMirror unavailable, using plain editor:', err);
    usingCM = false;
    editorMount.style.display = 'none';
    fallback.style.display = 'block';
    fallback.value = initial;
    fallback.addEventListener('input', saveCode);
    fallback.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') { e.preventDefault(); insertText('    '); }
      else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); onRunClick(); }
    });
  }
}

/* ----------------------------- tabs ---------------------------------- */
function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === name));
  if (name === 'editor' && usingCM) setTimeout(() => cmView.requestMeasure(), 0);
}
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));

/* ------------------------- symbol toolbar ----------------------------- */
function insertText(text, back = 0) {
  if (usingCM) {
    cmView.dispatch(cmView.state.replaceSelection(text));
    if (back) {
      const pos = cmView.state.selection.main.head - back;
      cmView.dispatch({ selection: { anchor: pos } });
    }
    cmView.focus();
  } else {
    const el = fallback;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    el.value = el.value.slice(0, start) + text + el.value.slice(end);
    const pos = start + text.length - back;
    el.selectionStart = el.selectionEnd = pos;
    el.focus();
  }
  saveCode();
}

$('#symbolbar').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  e.preventDefault();
  if (btn.dataset.key === 'tab') { insertText('    '); return; }
  if (btn.dataset.insert !== undefined) insertText(btn.dataset.insert, Number(btn.dataset.back || 0));
});

/* --------------------------- console --------------------------------- */
function clearOutput() {
  output.textContent = '';
  outputEmpty = true;
}
function appendOutput(text, cls) {
  // A command that is quietly working looks exactly like one that has stopped.
  // Remember when we last heard anything, so the note below can speak up.
  if (cls !== 'muted') { lastOutputAt = Date.now(); quietNoted = false; }
  if (outputEmpty) { output.textContent = ''; outputEmpty = false; }
  if (cls === 'err' || cls === 'muted') {
    const d = document.createElement('div');
    d.className = cls;
    d.textContent = text;
    output.appendChild(d);
  } else if (cls === 'echo') {
    const s = document.createElement('span');
    s.className = 'echo';
    s.textContent = text;
    output.appendChild(s);
  } else {
    output.appendChild(document.createTextNode(text));
  }
  output.scrollTop = output.scrollHeight;
}
function setStatus(kind, text) {
  statusEl.className = `status${kind ? ' ' + kind : ''}`;
  statusEl.textContent = text;
}

function setRunning(on) {
  runBtn.classList.toggle('stopping', on);
  runLabel.textContent = on ? 'Stop' : 'Run';
  runIcon.textContent = on ? '■' : '▶';
  inputLine.disabled = !on;
  sendBtn.disabled = !on;
  inputRow.classList.toggle('active', on);
  if (!on) { inputLine.value = ''; inputLine.style.height = ''; }
}

function onRunClick() {
  if (runId) stopRun();
  else startRun();
}

// If the pre-fill box somehow holds the program itself (for example stale data
// left over from an older version), sending it as stdin is never what you want.
function looksLikePastedCode(code, prefill) {
  const codeLines = code.split('\n').map((l) => l.trim()).filter(Boolean);
  const preLines = prefill.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!preLines.length) return false;
  return preLines.every((l) => codeLines.includes(l));
}

async function snapshotFiles() {
  try {
    const r = await fetch('/api/files');
    const d = await r.json();
    return new Set((d.files || []).map((f) => f.name));
  } catch {
    return null;
  }
}

async function startRun() {
  switchTab('console');
  clearOutput();

  // On a wide screen the Terminal and REPL get a real terminal emulator.
  if (isDesktop() && (mode === 'terminal' || mode === 'repl')) {
    if (await startPtyTerminal(mode)) return;
  }
  teardownTerminal();

  setRunning(false);
  setStatus('running', 'Starting…');
  runBtn.disabled = true;

  const code = getCode();
  let prefill = mode === 'script' ? stdinEl.value : '';

  if (mode === 'script' && prefill.trim() && looksLikePastedCode(code, prefill)) {
    prefill = '';
    stdinEl.value = '';
    try { localStorage.removeItem(STORAGE_STDIN); } catch { /* ignore */ }
    updatePrefillUI();
    appendOutput('⚠ The Pre-fill input box held your program code, so it was not sent.\n', 'muted');
  } else if (mode === 'script' && prefill.trim()) {
    for (const line of prefill.split('\n')) appendOutput(line + '\n', 'echo');
  }

  if (mode === 'repl') appendOutput('Python REPL — type an expression and press Enter.\n', 'muted');
  if (mode === 'terminal') appendOutput('Terminal — type a shell command and press Enter.\n', 'muted');

  // Remember what is already in the space, so we can tell you about new files.
  filesAtStart = mode === 'script' ? await snapshotFiles() : null;

  if (!window.EventSource) return startRunLegacy(code, prefill);

  let data;
  try {
    const res = await fetch('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, stdin: prefill, mode }),
    });
    data = await res.json();
    if (!res.ok || !data.runId) {
      appendOutput(data.error || 'Could not start the run.', 'err');
      setStatus('error', 'Not started');
      runBtn.disabled = false;
      return;
    }
  } catch (err) {
    appendOutput('Network error: ' + err.message, 'err');
    setStatus('error', 'Request failed');
    runBtn.disabled = false;
    return;
  }

  runId = data.runId;
  runIsPty = Boolean(data.pty);
  runBtn.disabled = false;
  setRunning(true);
  if (mode === 'repl') setStatus('running', 'REPL ready — type below and press Enter');
  else if (mode === 'terminal') setStatus('running', 'Terminal ready — type below and press Enter');
  else setStatus('running', 'Running…');
  openStream(runId);
  if (mode !== 'script') inputLine.focus();
}

function openStream(id) {
  receivedEvents = false;
  es = new EventSource(`/api/runs/${id}/events`);
  es.onmessage = (ev) => {
    let e;
    try { e = JSON.parse(ev.data); } catch { return; }
    receivedEvents = true;
    if (e.type === 'output') {
      appendOutput(e.text, e.stream === 'stderr' ? 'err' : null);
    } else if (e.type === 'exit') {
      finishRun(e);
    }
  };
  es.onerror = async () => {
    // Fires on a normal close too. If the stream never delivered anything,
    // fetch the result directly instead of showing a bare error.
    if (es) { es.close(); es = null; }
    const id2 = runId;
    if (!id2) return;
    if (!receivedEvents) {
      try {
        const r = await fetch(`/api/runs/${id2}`);
        if (r.ok) {
          const d = await r.json();
          if (d.stdout) appendOutput(d.stdout, null);
          if (d.stderr) appendOutput(d.stderr, 'err');
          finishRun({ status: d.status || 'error', exit_code: d.exit_code, elapsed_ms: d.elapsed_ms, truncated: d.truncated });
          return;
        }
      } catch { /* fall through */ }
    }
    finishRun({ status: 'error', exit_code: null, elapsed_ms: 0, truncated: false });
  };
}

function finishRun(e) {
  if (es) { es.close(); es = null; }
  runId = null;
  setRunning(false);
  reportNewFiles();
  const t = e.elapsed_ms ? ` · ${(e.elapsed_ms / 1000).toFixed(2)}s` : '';
  if (e.status === 'success') setStatus('success', `✓ Done${t} · exit ${e.exit_code ?? 0}`);
  else if (e.status === 'idle_timeout') setStatus('timeout', `⏱ Stopped: no activity${t}`);
  else if (e.status === 'timeout') setStatus('timeout', `⏱ Time limit reached${t}`);
  else if (e.status === 'output_limit') setStatus('error', `✗ Stopped: too much output${t}`);
  else if (e.status === 'killed') setStatus('error', `■ Stopped${t}`);
  else setStatus('error', `✗ Error${t} · exit ${e.exit_code ?? '?'}`);
  if (e.truncated) appendOutput('\n… output truncated.', 'muted');
}

// After a run, say so if the program saved anything — otherwise it is easy to
// think nothing happened.
function reportNewFiles() {
  const before = filesAtStart;
  filesAtStart = null;
  if (!before) return;
  snapshotFiles().then((now) => {
    if (!now) return;
    const added = [...now].filter((n) => !before.has(n));
    if (added.length) {
      appendOutput(`\n📄 saved in your space: ${added.join(', ')} — tap Files to open\n`, 'muted');
    }
  });
}

async function stopRun() {
  if (!runId) return;
  setStatus('running', 'Stopping…');
  try { await fetch(`/api/runs/${runId}/kill`, { method: 'POST' }); } catch { /* ignore */ }
}

// Drop any live session. Switching mode must never leave the old session
// quietly receiving keystrokes — that is how a Terminal session ends up
// looking like a REPL (or the other way round).
function resetRun() {
  if (runId) {
    try { fetch(`/api/runs/${runId}/kill`, { method: 'POST' }); } catch { /* ignore */ }
  }
  if (es) { try { es.close(); } catch { /* ignore */ } es = null; }
  if (termWs) { try { termWs.close(); } catch { /* ignore */ } termWs = null; }
  runId = null;
  termRunId = null;
  runIsPty = false;
  receivedEvents = false;
  setRunning(false);
  setStatus('', '');
}

// Fallback for browsers without EventSource: one-shot run.
async function startRunLegacy(code, prefill) {
  try {
    const res = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, stdin: prefill }),
    });
    const d = await res.json();
    if (d.stdout) appendOutput(d.stdout, null);
    if (d.stderr) appendOutput(d.stderr, 'err');
    if (!d.stdout && !d.stderr) appendOutput(d.error || '(no output)', d.error ? 'err' : 'muted');
    const t = d.execution_time ? ` · ${d.execution_time}` : '';
    setStatus(d.status === 'success' ? 'success' : 'error',
      `${d.status === 'success' ? '✓ Done' : '✗ ' + (d.status || 'error')}${t}`);
  } catch (err) {
    appendOutput('Network error: ' + err.message, 'err');
    setStatus('error', 'Request failed');
  } finally {
    runBtn.disabled = false;
  }
}

/* input line */
// Enter sends; the box grows as you type so a long command is readable.
inputLine.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (typeof inputForm.requestSubmit === 'function') inputForm.requestSubmit();
    else inputForm.dispatchEvent(new Event('submit', { cancelable: true }));
  }
});
inputLine.addEventListener('input', () => {
  inputLine.style.height = 'auto';
  inputLine.style.height = `${Math.min(inputLine.scrollHeight, 110)}px`;
});

inputForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!runId) return;
  const value = inputLine.value;
  inputLine.value = '';
  inputLine.style.height = '';
  // A pseudoterminal echoes what you type by itself, so our own echo would
  // double every line. The line-based runs have no echo of their own.
  if (!runIsPty) appendOutput((mode === 'terminal' ? '$ ' : '') + value + '\n', 'echo');
  try {
    await fetch(`/api/runs/${runId}/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: value }),
    });
  } catch { /* ignore */ }
  inputLine.focus();
});

runBtn.addEventListener('click', onRunClick);

/* --------------------------- save as .py ----------------------------- */
// Entirely client side: the code is wrapped in a Blob and handed straight to
// the browser, so nothing is uploaded anywhere. The click handler stays
// synchronous on purpose — iOS Safari only allows a download that starts inside
// the same user gesture, so there is no await before downloadPython().
const STORAGE_FILENAME = 'pypad-file-name';

try {
  const remembered = localStorage.getItem(STORAGE_FILENAME);
  if (remembered) fileNameInput.value = remembered;
} catch { /* private mode, ignore */ }

function rememberName(name) {
  fileNameInput.value = name;
  try { localStorage.setItem(STORAGE_FILENAME, name); } catch { /* ignore */ }
}

// Tidy the name up as soon as the field loses focus, so what you see is what
// gets saved.
fileNameInput.addEventListener('change', () => rememberName(pythonFilename(fileNameInput.value)));
fileNameInput.addEventListener('blur', () => rememberName(pythonFilename(fileNameInput.value)));

function saveCodeAsPy() {
  const name = pythonFilename(fileNameInput.value);
  rememberName(name);
  const code = getCode();
  const { bytes } = downloadPython(code, name);
  setStatus('success', `✓ Saved ${name} · ${bytes} bytes`);
}

downloadBtn.addEventListener('click', saveCodeAsPy);

/* ---- and the other ways out, for devices that refuse a download ---- */
function saveSay(text) {
  saveOut.hidden = false;
  saveOut.textContent = text;
}

function openSaveDialog() {
  saveOut.hidden = true;
  saveOut.textContent = '';
  // Only offered where it actually exists, so it is never a dead button.
  saveShare.hidden = !canShareFiles();
  if (typeof saveDialog.showModal === 'function') saveDialog.showModal();
  else saveDialog.setAttribute('open', '');
}

saveMoreBtn.addEventListener('click', openSaveDialog);

saveDownload.addEventListener('click', () => {
  const name = pythonFilename(fileNameInput.value);
  rememberName(name);
  const { bytes } = downloadPython(getCode(), name);
  saveSay(`Asked the browser to save ${name} (${bytes} bytes).\n\nIf nothing appeared, your browser is refusing downloads — use Share or Copy below.`);
});

saveShare.addEventListener('click', async () => {
  const name = pythonFilename(fileNameInput.value);
  rememberName(name);
  try {
    const { filename } = await sharePython(getCode(), name);
    saveSay(`Shared ${filename}.`);
  } catch (err) {
    saveSay(`Could not share: ${err.message}\n\nUse Copy instead.`);
  }
});

// The same file, but fetched from the server with Content-Disposition: the
// browser's own download manager handles it, which is the path that keeps
// working on Android when a blob download is refused. It also leaves the file
// in your workspace, so it shows up under Files.
saveServer.addEventListener('click', async () => {
  const name = pythonFilename(fileNameInput.value);
  rememberName(name);
  saveSay(`Saving ${name} on the server…`);
  try {
    const blob = new Blob([getCode()], { type: 'text/x-python;charset=utf-8' });
    const res = await fetch(`/api/files?name=${encodeURIComponent(name)}`, { method: 'POST', body: blob });
    const d = await res.json();
    if (!d.ok) {
      saveSay(`✗ ${d.error || 'the server refused the file'}`);
      return;
    }
    const a = document.createElement('a');
    a.href = `/api/files/${encodeURIComponent(name)}`;
    a.download = name;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => a.remove(), 1000);
    saveSay(`✓ ${name} is in your workspace, and the browser has been asked to download it.\n\nIt is also listed under Files.`);
  } catch (err) {
    saveSay(`Could not reach the server: ${err.message}`);
  }
});

saveCopy.addEventListener('click', async () => {
  try {
    await copyText(getCode());
    saveSay('✓ Copied. Paste it wherever you like.');
  } catch (err) {
    saveSay(`Could not copy: ${err.message}`);
  }
});

// Ctrl/Cmd+S in the editor saves instead of opening the browser's own dialog.
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
    e.preventDefault();
    saveCodeAsPy();
  }
});

clearBtn.addEventListener('click', () => {
  clearOutput();
  const s = document.createElement('span');
  s.className = 'muted';
  s.textContent = 'Press ▶ Run to execute your code.';
  output.appendChild(s);
  setStatus('', '');
});

/* ----------------------------- boot ---------------------------------- */
function updatePrefillUI() {
  const lines = stdinEl.value.split('\n').filter((l) => l.trim()).length;
  prefillCount.textContent = lines ? `${lines} line${lines > 1 ? 's' : ''}` : '';
  if (lines) prefillDetails.open = true;
}

stdinEl.value = loadStored(STORAGE_STDIN, '');
stdinEl.addEventListener('input', () => {
  try { localStorage.setItem(STORAGE_STDIN, stdinEl.value); } catch { /* ignore */ }
  updatePrefillUI();
});
prefillClear.addEventListener('click', () => {
  stdinEl.value = '';
  try { localStorage.removeItem(STORAGE_STDIN); } catch { /* ignore */ }
  updatePrefillUI();
});
updatePrefillUI();
initEditor();

/* --------------------------- modes ----------------------------------- */
function setMode(next) {
  if (mode === next) return;
  mode = next;
  document.querySelectorAll('.modebar .mode').forEach((b) => b.classList.toggle('active', b.dataset.mode === next));
  document.querySelector('.console-input .prompt').textContent = next === 'terminal' ? '$' : '›';
  prefillDetails.hidden = next !== 'script';
  // The editor belongs to Script mode. Hiding it in REPL/Terminal removes any
  // doubt about where to type.
  editorPanel.hidden = next !== 'script';
  codeTab.hidden = next !== 'script';
  switchTab('console');
  if (next === 'script' && usingCM) setTimeout(() => cmView.requestMeasure(), 0);
  resetRun();
  clearOutput();
  const hint = next === 'script' ? 'Press ▶ Run to execute your code.'
    : next === 'repl' ? 'Press ▶ Run to start a Python REPL, then type below.'
      : 'Press ▶ Run to open a terminal, then type commands below.';
  appendOutput(hint, 'muted');
  setStatus('', '');
}
modebar.addEventListener('click', (e) => {
  const b = e.target.closest('.mode');
  if (b && !b.hidden) setMode(b.dataset.mode);
});

/* ------------------------- packages dialog --------------------------- */
async function openPackages() {
  pkgOut.hidden = true;
  pkgOut.textContent = '';
  if (typeof pkgDialog.showModal === 'function') pkgDialog.showModal();
  else pkgDialog.setAttribute('open', '');
  try {
    const res = await fetch('/api/packages');
    const d = await res.json();
    pkgAllowed.textContent = '';
    (d.allowlist || []).forEach((name) => {
      const c = document.createElement('button');
      c.type = 'button';
      c.className = 'chip';
      c.textContent = name;
      c.addEventListener('click', () => { pkgInput.value = name; pkgInput.focus(); });
      pkgAllowed.appendChild(c);
    });
  } catch { /* ignore */ }
  loadInstalled();
}

// What is in the venv right now, each with a way to take it back out.
async function loadInstalled() {
  pkgInstalled.textContent = '';
  try {
    const res = await fetch('/api/packages/installed');
    const d = await res.json();
    const list = d.packages || [];
    if (!list.length) {
      pkgInstalled.textContent = 'Nothing installed yet.';
      return;
    }
    list.forEach((p) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.textContent = `${p.name} ✕`;
      b.title = `Remove ${p.name}${p.version ? ` ${p.version}` : ''}`;
      b.addEventListener('click', () => removePackage(p.name, b));
      pkgInstalled.appendChild(b);
    });
  } catch {
    pkgInstalled.textContent = 'Could not read the list.';
  }
}

async function removePackage(name, btn) {
  if (!window.confirm(`Remove ${name} from the server?`)) return;
  btn.disabled = true;
  pkgOut.hidden = false;
  pkgOut.textContent = `Removing ${name}…`;
  try {
    const res = await fetch('/api/packages/uninstall', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const d = await res.json();
    pkgOut.textContent = (d.ok ? `✓ ${name} removed.\n\n` : `✗ ${d.error || 'failed'}\n\n`) + (d.output || '');
  } catch (err) {
    pkgOut.textContent = 'Network error: ' + err.message;
  } finally {
    btn.disabled = false;
    loadInstalled();
  }
}
async function installPackage() {
  const name = pkgInput.value.trim();
  if (!name) return;
  pkgInstall.disabled = true;
  pkgOut.hidden = false;
  pkgOut.textContent = `Installing ${name}…`;
  try {
    const res = await fetch('/api/packages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const d = await res.json();
    pkgOut.textContent = (d.ok ? `✓ ${name} installed.\n\n` : `✗ ${d.error || 'failed'}\n\n`) + (d.output || '');
    if (d.ok) loadInstalled();
  } catch (err) {
    pkgOut.textContent = 'Network error: ' + err.message;
  } finally {
    pkgInstall.disabled = false;
  }
}
pkgBtn.addEventListener('click', openPackages);
pkgInstall.addEventListener('click', installPackage);
pkgInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); installPackage(); } });

/* --------------------------- workspace files ------------------------- */
function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

async function loadFiles() {
  fileList.textContent = '';
  try {
    const res = await fetch('/api/files');
    const d = await res.json();
    if (!d.files || !d.files.length) {
      const p = document.createElement('div');
      p.className = 'muted';
      p.textContent = 'No files yet. Upload one above, or run a program that writes one.';
      fileList.appendChild(p);
      return;
    }
    d.files.forEach((f) => {
      const row = document.createElement('div');
      row.className = 'file-row';
      const a = document.createElement('a');
      a.className = 'file-name';
      a.href = `/api/files/${encodeURIComponent(f.name)}`;
      a.setAttribute('download', '');
      a.textContent = f.name;
      const size = document.createElement('span');
      size.className = 'file-size';
      size.textContent = fmtSize(f.size);
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'mini-btn';
      del.textContent = 'Delete';
      del.addEventListener('click', async () => {
        await fetch(`/api/files/${encodeURIComponent(f.name)}`, { method: 'DELETE' }).catch(() => {});
        loadFiles();
      });
      row.append(a, size, del);
      fileList.appendChild(row);
    });
    const total = document.createElement('div');
    total.className = 'file-total';
    total.textContent = `${d.files.length} file(s) · ${fmtSize(d.total)} of ${fmtSize(d.limit)} used · this space is yours alone and clears after ~${spaceTtlHours}h idle`;
    fileList.appendChild(total);
  } catch {
    /* ignore */
  }
}

async function openFiles() {
  fileOut.hidden = true;
  fileOut.textContent = '';
  if (typeof filesDialog.showModal === 'function') filesDialog.showModal();
  else filesDialog.setAttribute('open', '');
  loadFiles();
}

async function uploadFiles() {
  const files = Array.from(fileInput.files || []);
  if (!files.length) return;
  uploadBtn.disabled = true;
  fileOut.hidden = false;
  const lines = [];
  for (const f of files) {
    try {
      const res = await fetch(`/api/files?name=${encodeURIComponent(f.name)}`, { method: 'POST', body: f });
      const d = await res.json();
      lines.push(`${d.ok ? '✓' : '✗'} ${f.name}${d.ok ? ` (${fmtSize(d.size || 0)})` : ` — ${d.error || 'failed'}`}`);
    } catch (err) {
      lines.push(`✗ ${f.name} — ${err.message}`);
    }
  }
  fileOut.textContent = lines.join('\n');
  fileInput.value = '';
  uploadBtn.disabled = false;
  loadFiles();
}

filesBtn.addEventListener('click', openFiles);
uploadBtn.addEventListener('click', uploadFiles);

/* -------------------- where the input line sits ----------------------- */
// On a phone the keyboard covers the bottom of the screen, so let the input
// sit above the output instead. The choice is remembered.
let inputOnTop = false;
try { inputOnTop = localStorage.getItem('mobi-py-input-top') === '1'; } catch { /* ignore */ }
function applyInputPos() {
  consolePanel.classList.toggle('input-top', inputOnTop);
  posBtn.textContent = inputOnTop ? '⇵' : '⇅';
  const label = inputOnTop ? 'Move the input below the output' : 'Move the input above the output';
  posBtn.title = label;
  posBtn.setAttribute('aria-label', label);
}
posBtn.addEventListener('click', () => {
  inputOnTop = !inputOnTop;
  try { localStorage.setItem('mobi-py-input-top', inputOnTop ? '1' : '0'); } catch { /* ignore */ }
  applyInputPos();
  if (runId) inputLine.focus();
});
applyInputPos();

/* --------------------- desktop terminal (xterm.js) ------------------- */
// On a wide screen the Terminal and REPL run under a real pseudoterminal and
// are drawn by xterm.js: you type straight at the prompt, with working Ctrl+C,
// arrow-key history and tab completion, and no Send button. If anything about
// that fails we quietly fall back to the line-based console below.
const termMount = $('#termMount');
let term = null;
let termFit = null;
let termWs = null;
let termRunId = null;
let xtermMods = null;
// Whether the program in the terminal has asked for bracketed paste. bash does,
// and pasted text should then arrive wrapped in the markers it expects.
let bracketedPaste = false;
const termDecoder = new TextDecoder();

function sendTermInput(text) {
  if (termWs && termWs.readyState === WebSocket.OPEN) {
    termWs.send(JSON.stringify({ type: 'input', text }));
  }
}

function noteTermModes(text) {
  if (text.includes('\x1b[?2004h')) bracketedPaste = true;
  if (text.includes('\x1b[?2004l')) bracketedPaste = false;
}

function isDesktop() {
  return window.matchMedia('(min-width: 860px)').matches;
}

function showTerminal(on) {
  consolePanel.classList.toggle('terminal-mode', on);
  termMount.hidden = !on;
}

async function loadXterm() {
  if (xtermMods) return xtermMods;
  const [core, addonFit] = await Promise.all([
    import('https://esm.sh/@xterm/xterm@5.5.0'),
    import('https://esm.sh/@xterm/addon-fit@0.10.0'),
  ]);
  xtermMods = { Terminal: core.Terminal, FitAddon: addonFit.FitAddon };
  return xtermMods;
}

function teardownTerminal() {
  if (termWs) { try { termWs.close(); } catch { /* ignore */ } termWs = null; }
  termRunId = null;
  showTerminal(false);
}

function onTermResize() {
  if (!termFit || termMount.hidden) return;
  try { termFit.fit(); } catch { /* ignore */ }
}

async function startPtyTerminal(nextMode) {
  try {
    const { Terminal, FitAddon } = await loadXterm();
    if (!term) {
      term = new Terminal({
        fontSize: 13,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        cursorBlink: true,
        scrollback: 2000,
        theme: {
          background: '#0d1117',
          foreground: '#e6edf3',
          cursor: '#58a6ff',
          selectionBackground: '#264f78',
        },
      });
      termFit = new FitAddon();
      term.loadAddon(termFit);
      term.open(termMount);
      // One handler for the life of the terminal; it follows the current socket.
      term.onData(sendTermInput);

      // Paste. Ctrl+V only pastes when the terminal's hidden textarea holds
      // focus, which is easy to lose — so take the paste event over ourselves in
      // the capture phase. That makes it work wherever the click landed, and
      // stops xterm from handling the same paste a second time.
      termMount.addEventListener('paste', (e) => {
        const text = e.clipboardData ? e.clipboardData.getData('text') : '';
        if (!text) return;
        e.preventDefault();
        e.stopPropagation();
        sendTermInput(bracketedPaste ? `\x1b[200~${text}\x1b[201~` : text);
      }, true);
      // Clicking the padding around the terminal should focus it too.
      termMount.addEventListener('mousedown', (e) => {
        if (e.target === termMount) { try { term.focus(); } catch { /* ignore */ } }
      });
      // Ctrl+V / Cmd+V pressed before the terminal has focus: give it focus, so
      // the paste lands here rather than nowhere.
      termMount.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V')) {
          try { term.focus(); } catch { /* ignore */ }
        }
      }, true);

      window.addEventListener('resize', onTermResize);
    }

    showTerminal(true);
    try { termFit.fit(); } catch { /* ignore */ }
    bracketedPaste = false;
    term.reset();
    term.focus();

    const res = await fetch('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: nextMode, pty: true, cols: term.cols, rows: term.rows }),
    });
    const data = await res.json();
    if (!res.ok || !data.runId || !data.pty) throw new Error(data.error || 'no pty session');

    termRunId = data.runId;
    runId = data.runId;
    mode = data.mode;
    setRunning(true);
    setStatus('running', 'Running');

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    termWs = new WebSocket(`${proto}://${location.host}/api/runs/${data.runId}/ws`);
    termWs.binaryType = 'arraybuffer';
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('socket timed out')), 8000);
      termWs.onopen = () => { clearTimeout(timer); resolve(); };
      termWs.onerror = () => { clearTimeout(timer); reject(new Error('socket failed')); };
    });
    termWs.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        const bytes = new Uint8Array(ev.data);
        noteTermModes(termDecoder.decode(bytes));
        term.write(bytes);
        return;
      }
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'text') { noteTermModes(msg.text); term.write(msg.text); }
        else if (msg.type === 'exit') onTerminalExit(msg);
      } catch { /* ignore */ }
    };
    termWs.onclose = () => {
      if (termRunId) { termRunId = null; runId = null; setRunning(false); }
    };
    return true;
  } catch {
    const orphan = runId;
    teardownTerminal();
    if (orphan) {
      try { await fetch(`/api/runs/${orphan}/kill`, { method: 'POST' }); } catch { /* ignore */ }
      runId = null;
    }
    return false;
  }
}

function onTerminalExit(msg) {
  const t = msg.elapsed_ms ? ` · ${(msg.elapsed_ms / 1000).toFixed(2)}s` : '';
  term.write(`\r\n\x1b[2m— session ended — press ▶ Run again\x1b[0m\r\n`);
  termRunId = null;
  runId = null;
  setRunning(false);
  if (msg.status === 'success') setStatus('success', `✓ Done${t}`);
  else if (msg.status === 'idle_timeout') setStatus('timeout', `⏱ Stopped: no activity${t}`);
  else if (msg.status === 'killed') setStatus('error', `■ Stopped${t}`);
  else setStatus('error', `✗ Error${t} · exit ${msg.exit_code ?? '?'}`);
}

/* --------------------------- capabilities ---------------------------- */
(async () => {
  try {
    const res = await fetch('/api/health');
    const h = await res.json();
    if (h.terminal) {
      const t = modebar.querySelector('[data-mode="terminal"]');
      if (t) t.hidden = false;
    }
    if (h.packages) pkgBtn.hidden = false;
    if (h.files) filesBtn.hidden = false;
    if (h.space_ttl_hours) spaceTtlHours = h.space_ttl_hours;
  } catch { /* offline: keep the defaults */ }
})();

window.mobiPy = { startRun, stopRun, getCode, setCode, setMode };
