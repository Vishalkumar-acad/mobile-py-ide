// Mobile Py IDE — frontend logic.
//
// Loads CodeMirror 6 from a CDN for a real editor experience, and falls
// back to a plain <textarea> if that fails (offline, slow network, old
// browser) so the IDE always works. Talks to the backend at POST /api/run.

const DEFAULT_CODE = `# Mobile Py IDE — sandboxed Python
import math

print("Hello from your mobile IDE!")
print("pi is about", round(math.pi, 5))

for i in range(1, 6):
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
const clearBtn = $('#clearBtn');

let cmView = null;
let usingCM = false;

/* ----------------------------- state ---------------------------------- */
function loadStored(key, def) {
  try { return localStorage.getItem(key) ?? def; } catch { return def; }
}
function getCode() {
  return usingCM ? cmView.state.doc.toString() : fallback.value;
}
function setCode(v) {
  if (usingCM) {
    cmView.dispatch({ changes: { from: 0, to: cmView.state.doc.length, insert: v } });
  } else {
    fallback.value = v;
  }
}

let saveTimer;
function saveCode() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(STORAGE_CODE, getCode()); } catch { /* quota */ }
  }, 400);
}

/* ----------------------------- editor --------------------------------- */
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
          '.cm-content': { paddingBottom: '40vh' },
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
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run(); }
    });
  } catch (err) {
    console.warn('CodeMirror unavailable, using plain editor:', err);
    usingCM = false;
    editorMount.style.display = 'none';
    fallback.style.display = 'block';
    fallback.value = initial;
    fallback.addEventListener('input', saveCode);
    fallback.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        insertText('    ');
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        run();
      }
    });
  }
}

/* ----------------------------- tabs ----------------------------------- */
function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t) =>
    t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.panel').forEach((p) =>
    p.classList.toggle('active', p.id === name));
  if (name === 'editor' && usingCM) setTimeout(() => cmView.requestMeasure(), 0);
}
document.querySelectorAll('.tab').forEach((t) =>
  t.addEventListener('click', () => switchTab(t.dataset.tab)));

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
  if (btn.dataset.insert !== undefined) {
    insertText(btn.dataset.insert, Number(btn.dataset.back || 0));
  }
});

/* ----------------------------- run ------------------------------------ */
async function run() {
  switchTab('console');
  output.textContent = '';
  statusEl.className = 'status';
  statusEl.textContent = 'Running…';
  runBtn.disabled = true;

  const code = getCode();
  const stdin = stdinEl.value;
  try { localStorage.setItem(STORAGE_STDIN, stdin); } catch { /* ignore */ }

  try {
    const res = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, stdin }),
    });
    const data = await res.json();
    renderResult(data);
  } catch (err) {
    output.textContent = '';
    const d = document.createElement('div');
    d.className = 'err';
    d.textContent = 'Network error: ' + err.message;
    output.appendChild(d);
    statusEl.className = 'status error';
    statusEl.textContent = 'Request failed';
  } finally {
    runBtn.disabled = false;
  }
}

function renderResult(d) {
  output.textContent = '';
  const stdout = d.stdout ?? d.output ?? '';
  const stderr = d.stderr ?? '';

  if (stdout) {
    const pre = document.createElement('span');
    pre.textContent = stdout;
    output.appendChild(pre);
  }
  if (stderr) {
    const div = document.createElement('div');
    div.className = 'err';
    div.textContent = stderr;
    output.appendChild(div);
  }
  if (!stdout && !stderr) {
    const span = document.createElement('span');
    span.className = 'muted';
    span.textContent = d.error ? String(d.error) : '(no output)';
    output.appendChild(span);
  }
  if (d.truncated) {
    const t = document.createElement('div');
    t.className = 'muted';
    t.textContent = '… output truncated.';
    output.appendChild(t);
  }

  const time = d.execution_time ? ` · ${d.execution_time}` : '';
  if (d.status === 'success') {
    statusEl.className = 'status success';
    statusEl.textContent = `✓ Done${time} · exit ${d.exit_code ?? 0}`;
  } else if (d.status === 'timeout') {
    statusEl.className = 'status timeout';
    statusEl.textContent = `⏱ Timed out${time}`;
  } else if (d.status === 'rejected') {
    statusEl.className = 'status error';
    statusEl.textContent = '✗ Blocked by validator';
  } else {
    statusEl.className = 'status error';
    statusEl.textContent = `✗ Error${time} · exit ${d.exit_code ?? '?'}`;
  }
  output.scrollTop = output.scrollHeight;
}

runBtn.addEventListener('click', run);
clearBtn.addEventListener('click', () => {
  output.textContent = '';
  const span = document.createElement('span');
  span.className = 'muted';
  span.textContent = 'Press ▶ Run to execute your code.';
  output.appendChild(span);
  statusEl.textContent = '';
  statusEl.className = 'status';
});

/* ----------------------------- boot ----------------------------------- */
stdinEl.value = loadStored(STORAGE_STDIN, '');
initEditor();

// expose for quick manual testing from the console
window.mobiPy = { run, getCode, setCode, insertText };
