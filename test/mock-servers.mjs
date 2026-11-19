// Minimal RFC 6455 test fixture only. Production uses Node's built-in WebSocket client.
import http from 'node:http';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

export async function listen(server) { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return server.address().port; }
export async function closeServer(server) { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); }
export async function mockRelay(handler) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const call = { url: req.url, headers: req.headers, body: text ? JSON.parse(text) : null }; calls.push(call);
    const result = await handler?.(call, calls.length) ?? { text: '你好呀，我是哈基米。' };
    if (result.delay) await new Promise(r => setTimeout(r, result.delay));
    res.writeHead(result.status ?? 200, { 'content-type': 'application/json', ...(result.headers ?? {}) });
    res.end(JSON.stringify(result.body ?? { choices: [{ message: { role: 'assistant', content: result.text } }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }));
  });
  const port = await listen(server); return { server, calls, url: `http://127.0.0.1:${port}/v1`, close: () => closeServer(server) };
}
function frame(text) {
  const payload = Buffer.from(text); let header;
  if (payload.length < 126) header = Buffer.from([0x81, payload.length]);
  else { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(payload.length, 2); }
  return Buffer.concat([header, payload]);
}
export async function mockOneBot(qq = '111111', token = 'onebot-test-token') {
  const events = new EventEmitter(), sockets = new Set(), actions = [], receivedTokens = []; let messageId = 9000;
  const server = http.createServer();
  server.on('upgrade', (req, socket) => {
    const supplied = new URL(req.url, 'http://localhost').searchParams.get('access_token'); receivedTokens.push(supplied);
    if (supplied !== token) { socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return; }
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    sockets.add(socket); let buffer = Buffer.alloc(0);
    socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 2) {
        let length = buffer[1] & 0x7f, offset = 2;
        if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
        if (length === 127) { socket.destroy(); return; }
        const masked = !!(buffer[1] & 0x80), maskLength = masked ? 4 : 0;
        if (buffer.length < offset + maskLength + length) return;
        const opcode = buffer[0] & 0xf, mask = buffer.subarray(offset, offset + maskLength), payload = Buffer.from(buffer.subarray(offset + maskLength, offset + maskLength + length));
        buffer = buffer.subarray(offset + maskLength + length);
        if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        if (opcode === 8) { socket.end(Buffer.from([0x88, 0])); return; }
        if (opcode !== 1) continue;
        const action = JSON.parse(payload.toString()); actions.push(action);
        const data = action.action === 'get_login_info' ? { user_id: Number(qq), nickname: 'mock' } : { message_id: ++messageId };
        socket.write(frame(JSON.stringify({ echo: action.echo, status: 'ok', retcode: 0, data })));
        events.emit('action', action);
      }
    });
  });
  const port = await listen(server);
  return { server, actions, receivedTokens, events, port, url: `ws://127.0.0.1:${port}/`,
    broadcast: event => { for (const socket of sockets) socket.write(frame(JSON.stringify(event))); },
    disconnect: () => { for (const socket of sockets) socket.destroy(); },
    close: async () => { for (const socket of sockets) socket.destroy(); await closeServer(server); }
  };
}
export async function until(predicate, timeout = 4000) {
  const end = Date.now() + timeout;
  while (!predicate()) { if (Date.now() > end) throw Error('Timed out waiting for test condition'); await new Promise(r => setTimeout(r, 10)); }
}
