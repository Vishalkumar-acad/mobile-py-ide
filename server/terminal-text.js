// Turning a pseudoterminal's byte stream back into plain text.
//
// The line-based console — the phone's Terminal, and the desktop fallback — is
// just text, so the escape sequences a terminal uses for colour, cursor
// movement and bracketed paste have to come out. State is kept per run,
// because a sequence can be split across two chunks.

// Is this a complete escape sequence, or is one still arriving?
function escapeIsComplete(seq) {
  return /^\x1b\[[0-9;?]*[ -/]*[@-~]/.test(seq)            // CSI
    || /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/.test(seq)      // OSC … BEL/ST
    || /^\x1b[()][A-Za-z0-9]/.test(seq)                    // charset selection
    || /^\x1b[@-Z\\-_]/.test(seq);                         // two-byte escape
}

function strip(s) {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')     // OSC
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')             // CSI
    .replace(/\x1b[()][A-Za-z0-9]/g, '')                   // charset
    .replace(/\x1b[@-Z\\-_]/g, '')                         // the rest
    .replace(/\r\n\r/g, '\r\n')                            // the pty's stray CR
    .replace(/\r(?!\n)/g, '\n')                            // a lone CR is a redraw
    .replace(/\r\n/g, '\n')
    .replace(/[^\n]\x08/g, '')                             // backspace erases
    .replace(/\x08/g, '');
}

/**
 * A per-run converter: feed it the raw chunks, get readable text back.
 * @returns {{push: (buf: Buffer) => string}}
 */
export function createTerminalText() {
  const decoder = new TextDecoder();
  let pending = '';

  return {
    push(buf) {
      let s = pending + decoder.decode(buf, { stream: true });
      pending = '';

      // Hold back an escape sequence that has only partly arrived.
      const cut = s.lastIndexOf('\x1b');
      if (cut !== -1 && !escapeIsComplete(s.slice(cut))) {
        pending = s.slice(cut);
        s = s.slice(0, cut);
      }
      return strip(s);
    },
  };
}
