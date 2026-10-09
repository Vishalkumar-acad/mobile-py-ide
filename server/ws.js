// A very small WebSocket server, written by hand so the project keeps its
// zero-dependency promise. It handles what a terminal needs: text and binary
// frames, ping/pong and close. Messages are small and unfragmented, so
// continuation frames are not implemented.

import crypto from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 1 << 20; // 1 MB

function buildFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function parseFrame(buf) {
  if (buf.length < 2) return null;
  const b0 = buf[0];
  const b1 = buf[1];
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let len = b1 & 0x7f;
  let off = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    off = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    const big = buf.readBigUInt64BE(2);
    if (big > BigInt(MAX_MESSAGE)) return { tooBig: true, total: 10 };
    len = Number(big);
    off = 10;
  }
  let mask = null;
  if (masked) {
    if (buf.length < off + 4) return null;
    mask = buf.subarray(off, off + 4);
    off += 4;
  }
  if (buf.length < off + len) return null;
  const payload = Buffer.from(buf.subarray(off, off + len));
  if (mask) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
  return { opcode, payload, total: off + len };
}

/**
 * Complete the handshake for an incoming upgrade request.
 * @returns {null | {sendText, sendBinary, close, onMessage, onClose}}
 */
export function acceptWebSocket(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') {
    socket.destroy();
    return null;
  }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n'
    + 'Upgrade: websocket\r\n'
    + 'Connection: Upgrade\r\n'
    + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  socket.setNoDelay(true);

  let buf = Buffer.alloc(0);
  let open = true;
  let onMessage = null;
  let onClose = null;

  function send(opcode, payload) {
    if (!open) return;
    try {
      socket.write(buildFrame(opcode, payload));
    } catch {
      open = false;
    }
  }

  function shutdown() {
    if (!open) return;
    open = false;
    try { socket.end(buildFrame(0x8, Buffer.alloc(0))); } catch { /* ignore */ }
  }

  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const frame = parseFrame(buf);
      if (!frame) break;
      buf = buf.subarray(frame.total);
      if (frame.tooBig) { shutdown(); return; }
      if (frame.opcode === 0x8) { shutdown(); return; }
      if (frame.opcode === 0x9) { send(0xA, frame.payload); continue; }
      if (frame.opcode === 0xA) continue;
      if ((frame.opcode === 0x1 || frame.opcode === 0x2 || frame.opcode === 0x0) && onMessage) {
        onMessage(frame.payload, frame.opcode === 0x2);
      }
    }
  });
  socket.on('close', () => { open = false; if (onClose) onClose(); });
  socket.on('error', () => { open = false; if (onClose) onClose(); });

  return {
    sendText: (text) => send(0x1, Buffer.from(String(text), 'utf8')),
    sendBinary: (data) => send(0x2, data),
    close: shutdown,
    onMessage: (fn) => { onMessage = fn; },
    onClose: (fn) => { onClose = fn; },
    get open() { return open; },
  };
}
