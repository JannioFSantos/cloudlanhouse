import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

/**
 * Servidor WebSocket mínimo (RFC 6455) — só o que o projeto usa:
 * handshake, mensagens de texto, ping/pong, close e fragmentação.
 *
 * Zero dependências. Se algum dia precisar de permessage-deflate ou
 * backpressure sério, troque por `ws`; a interface abaixo é compatível
 * com o subconjunto que o realtime.js consome.
 */

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

export class WebSocketConnection extends EventEmitter {
  constructor(socket, req, { maxPayload = 1024 * 1024 } = {}) {
    super();
    this.socket = socket;
    this.req = req;
    this.readyState = 1;
    this.OPEN = 1;
    this.CLOSED = 3;
    this.isAlive = true;
    this.maxPayload = maxPayload;
    this.buffer = Buffer.alloc(0);
    this.fragments = null;
    this.fragmentOpcode = 0;

    socket.setNoDelay(true);
    socket.setTimeout(0);

    socket.on('data', (chunk) => this.#onData(chunk));
    socket.on('close', () => this.#finalize());
    socket.on('end', () => this.#finalize());
    socket.on('error', () => this.#finalize());
  }

  #finalize() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close');
  }

  #onData(chunk) {
    if (this.readyState === 3) return;

    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;

    if (this.buffer.length > this.maxPayload * 4) {
      this.terminate();
      return;
    }

    for (;;) {
      const frame = this.#readFrame();
      if (!frame) break;
      this.#handleFrame(frame);
      if (this.readyState === 3) break;
    }
  }

  #readFrame() {
    const buffer = this.buffer;
    if (buffer.length < 2) return null;

    const fin = (buffer[0] & 0x80) !== 0;
    const rsv = buffer[0] & 0x70;
    const opcode = buffer[0] & 0x0f;
    const masked = (buffer[1] & 0x80) !== 0;
    let length = buffer[1] & 0x7f;
    let offset = 2;

    if (rsv !== 0) {
      this.close(1002, 'RSV inválido');
      return null;
    }

    if (length === 126) {
      if (buffer.length < 4) return null;
      length = buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (buffer.length < 10) return null;
      const big = buffer.readBigUInt64BE(2);
      if (big > BigInt(this.maxPayload)) {
        this.close(1009, 'Mensagem grande demais');
        return null;
      }
      length = Number(big);
      offset = 10;
    }

    if (length > this.maxPayload) {
      this.close(1009, 'Mensagem grande demais');
      return null;
    }

    if (masked) {
      if (buffer.length < offset + 4) return null;
      offset += 4;
    }

    if (buffer.length < offset + length) return null;

    let payload = Buffer.from(buffer.subarray(offset, offset + length));
    if (masked) {
      const mask = buffer.subarray(offset - 4, offset);
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    }

    this.buffer = buffer.subarray(offset + length);
    return { fin, opcode, payload };
  }

  #handleFrame({ fin, opcode, payload }) {
    if (opcode === OP_PING) {
      this.#writeFrame(OP_PONG, payload);
      this.emit('ping');
      return;
    }

    if (opcode === OP_PONG) {
      this.isAlive = true;
      this.emit('pong');
      return;
    }

    if (opcode === OP_CLOSE) {
      this.readyState = 2;
      this.#writeFrame(OP_CLOSE, payload.subarray(0, 2));
      this.socket.end();
      return;
    }

    if (opcode === OP_TEXT || opcode === OP_BINARY) {
      if (!fin) {
        this.fragments = [payload];
        this.fragmentOpcode = opcode;
        return;
      }
      this.#emitMessage(opcode, payload);
      return;
    }

    if (opcode === OP_CONTINUATION) {
      if (!this.fragments) {
        this.close(1002, 'Continuação inesperada');
        return;
      }
      this.fragments.push(payload);
      if (!fin) return;

      const full = Buffer.concat(this.fragments);
      const kind = this.fragmentOpcode;
      this.fragments = null;
      this.fragmentOpcode = 0;

      if (full.length > this.maxPayload) {
        this.close(1009, 'Mensagem grande demais');
        return;
      }
      this.#emitMessage(kind, full);
      return;
    }

    this.close(1002, `Opcode desconhecido ${opcode}`);
  }

  #emitMessage(opcode, payload) {
    if (opcode === OP_BINARY) return; // o protocolo é JSON
    this.emit('message', payload.toString('utf8'));
  }

  #writeFrame(opcode, payload) {
    if (this.socket.destroyed) return false;

    const length = payload.length;
    let header;

    if (length < 126) {
      header = Buffer.alloc(2);
      header[1] = length;
    } else if (length < 65536) {
      header = Buffer.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }

    header[0] = 0x80 | opcode;

    try {
      this.socket.write(Buffer.concat([header, payload]));
      return true;
    } catch {
      return false;
    }
  }

  send(data) {
    if (this.readyState !== 1) return false;
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    return this.#writeFrame(OP_TEXT, payload);
  }

  ping() {
    if (this.readyState !== 1) return;
    this.#writeFrame(OP_PING, Buffer.alloc(0));
  }

  close(code = 1000, reason = '') {
    if (this.readyState > 1) return;
    this.readyState = 2;

    const reasonBuffer = Buffer.from(String(reason), 'utf8').subarray(0, 120);
    const payload = Buffer.alloc(2 + reasonBuffer.length);
    payload.writeUInt16BE(code, 0);
    reasonBuffer.copy(payload, 2);

    this.#writeFrame(OP_CLOSE, payload);
    this.socket.end();
    setTimeout(() => this.terminate(), 1500).unref?.();
  }

  terminate() {
    try {
      this.socket.destroy();
    } catch {
      /* ignore */
    }
    this.#finalize();
  }
}

export function createWebSocketServer({ server, path = '/ws', maxPayload = 1024 * 1024 } = {}) {
  const wss = new EventEmitter();
  wss.clients = new Set();

  server.on('upgrade', (req, socket, head) => {
    let pathname = '/';
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      socket.destroy();
      return;
    }

    if (pathname !== path) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const key = req.headers['sec-websocket-key'];
    const upgrade = String(req.headers.upgrade ?? '').toLowerCase();

    if (!key || upgrade !== 'websocket') {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Connection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );

    const connection = new WebSocketConnection(socket, req, { maxPayload });

    if (head?.length) connection.buffer = Buffer.from(head);

    wss.clients.add(connection);
    connection.on('close', () => {
      wss.clients.delete(connection);
      wss.emit('disconnect', connection);
    });

    wss.emit('connection', connection, req);
  });

  wss.close = () => {
    for (const client of wss.clients) client.terminate();
    wss.clients.clear();
  };

  return wss;
}
