// Getting your code out of the browser, without a server.
//
// Three ways, because devices differ: a Blob download (desktop browsers),
// the native share sheet (phones), and the clipboard (works everywhere).

/** The MIME type Python source is served as. */
export const PYTHON_MIME = 'text/x-python;charset=utf-8';

/**
 * Turn whatever the user typed into a safe, sensible file name.
 *
 * @param {string} [name]  the name the user wants (may be empty or messy)
 * @returns {string} a name ending in `.py`, or `script.py` if nothing is left
 */
export function pythonFilename(name) {
  const cleaned = String(name ?? '')
    .trim()
    .replace(/\.py$/i, '')
    .replace(/[^\w.-]+/g, '-')     // anything not word-ish, dot or dash
    .replace(/^[-.]+|[-.]+$/g, '') // no leading or trailing punctuation
    .slice(0, 64);
  return cleaned ? `${cleaned}.py` : 'script.py';
}

/* ------------------------------- download ------------------------------- */

// Object URLs that are still in flight.
const pending = new Set();

function release(url) {
  if (!pending.has(url)) return;
  pending.delete(url);
  try { URL.revokeObjectURL(url); } catch { /* already gone */ }
}

// Anything still outstanding when the page goes away is dropped here, so
// nothing is retained across visits.
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => { for (const u of [...pending]) release(u); });
}

/**
 * Save a string to the user's device as a file. Pure client side.
 *
 * The object URL is deliberately NOT revoked straight away. Revoking it in the
 * same tick as the click — or even a tick later — can cancel the download on a
 * slow device, because the browser may not have started reading the blob yet.
 * It is released after a generous delay instead, and on page hide, so there is
 * still no leak.
 *
 * @param {string} text       the contents to save
 * @param {string} [filename] what to call it (default `script.py`)
 * @param {string} [mime]     MIME type (default Python source)
 * @returns {{filename: string, bytes: number}}
 */
export function downloadTextFile(text, filename = 'script.py', mime = PYTHON_MIME) {
  const blob = new Blob([String(text ?? '')], { type: mime });
  const url = URL.createObjectURL(blob);
  pending.add(url);

  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  // Kept in the layout but pushed off-screen, rather than display:none — some
  // browsers ignore a click on an element that is not rendered.
  a.style.position = 'fixed';
  a.style.top = '-1000px';
  a.style.left = '0';
  a.style.opacity = '0';

  // Some browsers only honour the click if the anchor is in the document.
  document.body.appendChild(a);
  a.click();

  setTimeout(() => {
    a.remove();
    release(url);
  }, 60000);

  return { filename, bytes: blob.size };
}

/**
 * Save Python source. A thin, obvious wrapper over {@link downloadTextFile}.
 *
 * @param {string} code
 * @param {string} [filename]
 */
export function downloadPython(code, filename = 'script.py') {
  return downloadTextFile(code, filename, PYTHON_MIME);
}

/* --------------------------------- share -------------------------------- */

function makeFile(text, filename, mime = PYTHON_MIME) {
  return new File([String(text ?? '')], pythonFilename(filename), { type: mime });
}

/**
 * Whether this browser can share a file (phones can; most desktops cannot).
 * @returns {boolean}
 */
export function canShareFiles() {
  try {
    if (typeof navigator === 'undefined' || typeof navigator.canShare !== 'function') return false;
    return navigator.canShare({ files: [new File([''], 'probe.py', { type: PYTHON_MIME })] });
  } catch {
    return false;
  }
}

/**
 * Hand the file to the device's own share sheet — which is how you save a file
 * on Android and iOS when a plain download is refused. Must be called from a
 * user gesture.
 *
 * @param {string} code
 * @param {string} [filename]
 * @returns {Promise<{filename: string}>}
 */
export async function sharePython(code, filename = 'script.py') {
  const file = makeFile(code, filename);
  if (typeof navigator === 'undefined' || typeof navigator.canShare !== 'function'
      || !navigator.canShare({ files: [file] })) {
    throw new Error('This browser cannot share files.');
  }
  await navigator.share({ files: [file], title: file.name });
  return { filename: file.name };
}

/* -------------------------------- copy ---------------------------------- */

/**
 * Copy text to the clipboard, with a fallback for browsers (and embedded
 * webviews) where the async Clipboard API is unavailable.
 *
 * @param {string} text
 * @returns {Promise<boolean>}
 */
export async function copyText(text) {
  const s = String(text ?? '');

  if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(s);
      return true;
    } catch { /* fall through to the old way */ }
  }

  const ta = document.createElement('textarea');
  ta.value = s;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '-1000px';
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, s.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  if (!ok) throw new Error('This browser will not let the page copy.');
  return true;
}
