import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8199;
const BASE = `http://127.0.0.1:${PORT}`;
const HOST_KEY = 'chave-e2e';
const ADMIN_PASSWORD = 'senha-e2e';

let child;
const sockets = [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch {
      /* ainda subindo */
    }
    await sleep(250);
  }
  throw new Error('servidor não subiu');
}

function openWS() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  sockets.push(ws);
  const queue = [];
  const waiters = [];

  ws.addEventListener('message', (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (waiters.length) {
      for (let i = 0; i < waiters.length; i++) {
        if (waiters[i].predicate(msg)) {
          const [waiter] = waiters.splice(i, 1);
          waiter.resolve(msg);
          return;
        }
      }
    }
    queue.push(msg);
  });

  const opened = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', () => reject(new Error('ws error')));
  });

  return {
    ws,
    opened,
    send: (obj) => ws.send(JSON.stringify(obj)),
    next(predicate, timeout = 5000) {
      const found = queue.find(predicate);
      if (found) {
        queue.splice(queue.indexOf(found), 1);
        return Promise.resolve(found);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.findIndex((w) => w.resolve === resolve);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error('timeout esperando mensagem ws'));
        }, timeout);
        waiters.push({
          predicate,
          resolve: (msg) => {
            clearTimeout(timer);
            resolve(msg);
          },
        });
      });
    },
  };
}

async function api(pathname, options = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  return { status: res.status, data, headers: res.headers };
}

test.before(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xboxplay-http-'));
  child = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(PORT),
      BASE_URL: BASE,
      DATA_DIR: dataDir,
      PAYMENT_MODE: 'mock',
      REQUIRE_ONLINE: '0', // aqui não há host/ponte; a trava de venda tem teste próprio
      MP_ACCESS_TOKEN: '',
      ADMIN_PASSWORD,
      HOST_KEY,
      QUEUE_HOLD_SEC: '300',
      PROVISION_TIMEOUT_SEC: '180',
      PAYMENT_TTL_SEC: '900',
      DEBUG: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => process.stderr.write(d));
  await waitServer();
});

test.after(() => {
  for (const ws of sockets) {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }
  child?.kill();
});

test('serve as páginas e o css', async () => {
  const home = await fetch(`${BASE}/`);
  assert.equal(home.status, 200);
  const html = await home.text();
  assert.match(html, /Xbox Play/i);

  const css = await fetch(`${BASE}/assets/style.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /text\/css/);

  const play = await fetch(`${BASE}/play`);
  assert.equal(play.status, 200);
  assert.match(await play.text(), /player-shell/);
});

test('API pública responde status e preços', async () => {
  const status = await api('/api/status');
  assert.equal(status.status, 200);
  assert.equal(status.data.slot.status, 'free');
  assert.equal(status.data.paymentMode, 'mock');

  const config = await api('/api/config');
  assert.equal(config.data.pricing.maxHours, 4);
  assert.deepEqual(config.data.pricing.hourlyCents, [700, 600, 500, 400]);
});

test('compra, pagamento, sessão e handshake WebRTC', async () => {
  const created = await api('/api/orders', {
    method: 'POST',
    body: { hours: 2, name: 'Cliente E2E', phone: '11988887777' },
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.amountCents, 1300);
  assert.ok(created.data.qrCode);

  const orderID = created.data.id;

  const paid = await api(`/api/orders/${orderID}/mock-pay`, { method: 'POST' });
  assert.equal(paid.status, 200);
  assert.equal(paid.data.status, 'paid');
  assert.ok(paid.data.session?.playUrl);

  const token = new URL(paid.data.session.playUrl).searchParams.get('s');
  assert.ok(token);

  const session = await api(`/api/session?s=${encodeURIComponent(token)}`);
  assert.equal(session.status, 200);
  assert.equal(session.data.status, 'provisioning');
  assert.equal(session.data.hoursPurchased, 2);

  // Host conecta
  const host = openWS();
  await host.opened;
  host.send({ type: 'hello', role: 'host', key: HOST_KEY });
  const hostHello = await host.next((m) => m.type === 'hello');
  assert.equal(hostHello.ok, true);
  assert.equal(hostHello.role, 'host');

  // Viewer conecta
  const viewer = openWS();
  await viewer.opened;
  viewer.send({ type: 'hello', role: 'viewer', token });
  const viewerHello = await viewer.next((m) => m.type === 'hello');
  assert.equal(viewerHello.ok, true);
  assert.equal(viewerHello.role, 'viewer');
  assert.equal(viewerHello.hostOnline, true);
  assert.equal(viewerHello.session.hoursPurchased, 2);

  // Host é avisado
  await host.next((m) => m.type === 'viewer:joined');

  // Oferta/answer relay
  host.send({ type: 'offer', payload: { type: 'offer', sdp: 'v=0 fake' } });
  const offer = await viewer.next((m) => m.type === 'offer');
  assert.equal(offer.payload.sdp, 'v=0 fake');

  viewer.send({ type: 'answer', payload: { type: 'answer', sdp: 'v=0 resposta' } });
  const answer = await host.next((m) => m.type === 'answer');
  assert.equal(answer.payload.sdp, 'v=0 resposta');

  // ICE
  viewer.send({ type: 'candidate', payload: { candidate: 'ice-viewer' } });
  const candidate = await host.next((m) => m.type === 'candidate');
  assert.equal(candidate.payload.candidate, 'ice-viewer');

  // Host publica: relógio começa
  host.send({ type: 'stream:ready' });
  const ready = await viewer.next((m) => m.type === 'stream:ready');
  assert.ok(ready.session.endsAt > Date.now());

  const active = await api(`/api/session?s=${encodeURIComponent(token)}`);
  assert.equal(active.data.status, 'active');
  const twoHours = 2 * 3600_000;
  assert.ok(Math.abs((active.data.endsAt - active.data.startedAt) - twoHours) < 2000);

  // Estende +1h por R$ 5
  const extension = await api('/api/session/extend', {
    method: 'POST',
    body: { token, hours: 1 },
  });
  assert.equal(extension.status, 201);
  assert.equal(extension.data.amountCents, 500);

  const extPaid = await api(`/api/orders/${extension.data.id}/mock-pay`, { method: 'POST' });
  assert.equal(extPaid.data.status, 'paid');

  const extended = await api(`/api/session?s=${encodeURIComponent(token)}`);
  assert.equal(extended.data.hoursPurchased, 3);
  assert.equal(extended.data.endsAt, active.data.endsAt + 3600_000);
});

test('desistir encerra e avisa o player', async () => {
  const status = await api('/api/status');
  // Recupera o token pelo estado da sessão via admin
  const login = await api('/api/admin/login', { method: 'POST', body: { password: ADMIN_PASSWORD } });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];

  const overview = await api('/api/admin/overview', { headers: { Cookie: cookie } });
  assert.equal(overview.status, 200);
  assert.equal(overview.data.session.status, 'active');
  assert.equal(status.data.slot.status, 'busy');

  const token = new URL(overview.data.session.playUrl).searchParams.get('s');

  const viewer = openWS();
  await viewer.opened;
  viewer.send({ type: 'hello', role: 'viewer', token });
  await viewer.next((m) => m.type === 'hello');

  const forfeit = await api('/api/session/forfeit', {
    method: 'POST',
    body: { token, confirm: true },
  });
  assert.equal(forfeit.status, 200);
  assert.equal(forfeit.data.status, 'forfeited');

  const ended = await viewer.next((m) => m.type === 'session:ended');
  assert.equal(ended.reason, 'forfeited');

  const after = await api('/api/status');
  assert.equal(after.data.slot.status, 'free');
});

test('painel exige senha e lista pedidos', async () => {
  const noAuth = await api('/api/admin/overview');
  assert.equal(noAuth.status, 403);

  const login = await api('/api/admin/login', {
    method: 'POST',
    body: { password: 'senha-errada' },
  });
  assert.equal(login.status, 401);

  const ok = await api('/api/admin/login', {
    method: 'POST',
    body: { password: ADMIN_PASSWORD },
  });
  const cookie = ok.headers.get('set-cookie').split(';')[0];

  const overview = await api('/api/admin/overview', { headers: { Cookie: cookie } });
  assert.equal(overview.status, 200);
  assert.ok(overview.data.orders.length >= 1);
  assert.equal(overview.data.counters.sessionsTotal >= 1, true);

  const hostKey = await api('/api/admin/host-key', { headers: { Cookie: cookie } });
  assert.equal(hostKey.data.hostKey, HOST_KEY);
});

test('fila é bloqueada quando o slot está ocupado', async () => {
  const first = await api('/api/orders', {
    method: 'POST',
    body: { hours: 1, name: 'Primeiro', phone: '11977776666' },
  });
  assert.equal(first.status, 201);

  const queue = await api('/api/queue', {
    method: 'POST',
    body: { name: 'Segundo', phone: '11955554444' },
  });
  assert.equal(queue.status, 201);
  assert.equal(queue.data.entry.status, 'waiting');
  assert.equal(queue.data.entry.position, 1);

  const duplicate = await api('/api/queue', {
    method: 'POST',
    body: { name: 'Segundo', phone: '11955554444' },
  });
  assert.equal(duplicate.status, 201);
  assert.equal(duplicate.data.alreadyInQueue, true);

  await api(`/api/orders/${first.data.id}/cancel`, { method: 'POST' });
});
