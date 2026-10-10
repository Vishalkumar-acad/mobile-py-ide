// Saving text as a file, entirely in the browser.
//
// No server is involved: the string is wrapped in a Blob, handed to the browser
// as an object URL, and clicked through a temporary anchor. The anchor and the
// URL are cleaned up straight afterwards so nothing is retained.

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
    .replace(/[^\w.-]+/g, '-')   // anything not word-ish, dot or dash
    .replace(/^[-.]+|[-.]+$/g, '') // no leading or trailing punctuation
    .slice(0, 64);
  return cleaned ? `${cleaned}.py` : 'script.py';
}

/**
 * Save a string to the user's device as a file. Pure client side.
 *
 * @param {string} text               the contents to save
 * @param {string} [filename]         what to call it (default `script.py`)
 * @param {string} [mime]             MIME type (default Python source)
 * @returns {{filename: string, bytes: number}}
 */
export function downloadTextFile(text, filename = 'script.py', mime = PYTHON_MIME) {
  const blob = new Blob([String(text ?? '')], { type: mime });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';

  // Some browsers (older Firefox in particular) only honour the click if the
  // anchor is actually in the document.
  document.body.appendChild(a);
  a.click();

  // Tidy up. Safari can cancel a download whose object URL vanishes in the same
  // tick, so let one tick pass first — nothing is held beyond that, so there is
  // still no leak.
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 0);

  return { filename, bytes: blob.size };
}

/**
 * Save Python source. A thin, obvious wrapper over {@link downloadTextFile}.
 *
 * @param {string} code
 * @param {string} [filename]
 */
export function downloadPython(code, filename = 'script.py') {
  return downloadTextFile(code, pythonFilename(filename), PYTHON_MIME);
}
