// Mobile Py IDE — frontend.
//
// Loads CodeMirror 6 from a CDN for a real editor, with a plain-textarea
// fallback if that fails. Runs code through the streaming API so that
// input() works live: the program prints a prompt, you type a line and press
// Enter, and it continues — just like a terminal.

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
const inputForm = $('#inputForm');
const inputLine = $('#inputLine');
const sendBtn = $('#sendBtn');
const prefillDetails = $('#prefillDetails');
const prefillCount = $('#prefillCount');
const prefillClear = $('#prefillClear');

let cmView = null;
let usingCM = false;
let es = null;
let runId = null;
let outputEmpty = true;

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
  if (!on) inputLine.value = '';
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

async function startRun() {
  switchTab('console');
  clearOutput();
  setRunning(false);
  setStatus('running', 'Starting…');
  runBtn.disabled = true;

  const code = getCode();
  let prefill = stdinEl.value;

  if (prefill.trim() && looksLikePastedCode(code, prefill)) {
    prefill = '';
    stdinEl.value = '';
    try { localStorage.removeItem(STORAGE_STDIN); } catch { /* ignore */ }
    updatePrefillUI();
    appendOutput('⚠ The Pre-fill input box held your program code, so it was not sent.\n', 'muted');
  } else if (prefill.trim()) {
    for (const line of prefill.split('\n')) appendOutput(line + '\n', 'echo');
  }

  if (!window.EventSource) return startRunLegacy(code, prefill);

  let data;
  try {
    const res = await fetch('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, stdin: prefill }),
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
  runBtn.disabled = false;
  setRunning(true);
  openStream(runId);
}

function openStream(id) {
  es = new EventSource(`/api/runs/${id}/events`);
  es.onmessage = (ev) => {
    let e;
    try { e = JSON.parse(ev.data); } catch { return; }
    if (e.type === 'output') {
      appendOutput(e.text, e.stream === 'stderr' ? 'err' : null);
    } else if (e.type === 'exit') {
      finishRun(e);
    }
  };
  es.onerror = () => {
    // Fires on a normal close too; if we never got an exit event, treat it as done.
    if (es) { es.close(); es = null; }
    if (runId) finishRun({ status: 'error', exit_code: null, elapsed_ms: 0, truncated: false });
  };
}

function finishRun(e) {
  if (es) { es.close(); es = null; }
  runId = null;
  setRunning(false);
  const t = e.elapsed_ms ? ` · ${(e.elapsed_ms / 1000).toFixed(2)}s` : '';
  if (e.status === 'success') setStatus('success', `✓ Done${t} · exit ${e.exit_code ?? 0}`);
  else if (e.status === 'idle_timeout') setStatus('timeout', `⏱ Stopped: no activity${t}`);
  else if (e.status === 'timeout') setStatus('timeout', `⏱ Time limit reached${t}`);
  else if (e.status === 'output_limit') setStatus('error', `✗ Stopped: too much output${t}`);
  else if (e.status === 'killed') setStatus('error', `■ Stopped${t}`);
  else setStatus('error', `✗ Error${t} · exit ${e.exit_code ?? '?'}`);
  if (e.truncated) appendOutput('\n… output truncated.', 'muted');
}

async function stopRun() {
  if (!runId) return;
  setStatus('running', 'Stopping…');
  try { await fetch(`/api/runs/${runId}/kill`, { method: 'POST' }); } catch { /* ignore */ }
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
inputForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!runId) return;
  const value = inputLine.value;
  inputLine.value = '';
  appendOutput(value + '\n', 'echo');
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

window.mobiPy = { startRun, stopRun, getCode, setCode };
