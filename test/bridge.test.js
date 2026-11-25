import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isNeutral, mapPayload } from '../tools/gamepad-bridge/mapping.js';
import { createBridge } from '../tools/gamepad-bridge/bridge.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8198;
const BASE = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/ws`;
const HOST_KEY = 'chave-bridge-e2e';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate, timeout = 4000, step = 25) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (predicate()) return;
    await sleep(step);
  }
  throw new Error('condição não atingida a tempo');
}

/* ------------------------------ mapeamento ------------------------------ */

function padPayload({ axes = [0, 0, 0, 0], pressed = [], triggers = {} } = {}) {
  const buttons = Array.from({ length: 17 }, () => [0, 0]);
  for (const index of pressed) buttons[index] = [1, 1];
  if (triggers.lt !== undefined) buttons[6] = [triggers.lt > 0 ? 1 : 0, triggers.lt];
  if (triggers.rt !== undefined) buttons[7] = [triggers.rt > 0 ? 1 : 0, triggers.rt];
  return { id: 'Xbox Wireless Controller', axes, buttons };
}

test('mapeia botões do layout standard para XInput', () => {
  const state = mapPayload(padPayload({ pressed: [0, 1, 2, 3, 4, 5, 8, 9, 10, 11, 12, 13, 14, 15, 16] }));
  assert.deepEqual(
    [...state.buttons].sort(),
    [
      'A', 'B', 'X', 'Y', 'LEFT_SHOULDER', 'RIGHT_SHOULDER', 'BACK', 'START',
      'LEFT_THUMB', 'RIGHT_THUMB', 'DPAD_UP', 'DPAD_DOWN', 'DPAD_LEFT', 'DPAD_RIGHT', 'GUIDE',
    ].sort(),
  );
});

test('gatilhos viram valores analógicos e não aparecem como botões', () => {
  const state = mapPayload(padPayload({ pressed: [6, 7], triggers: { lt: 0.5, rt: 1 } }));
  assert.equal(state.lt, 0.5);
  assert.equal(state.rt, 1);
  assert.deepEqual(state.buttons, []);
});

test('gatilho que só informa "pressed" vira 1', () => {
  const payload = padPayload();
  payload.buttons[6] = [1, 0];
  assert.equal(mapPayload(payload).lt, 1);
});

test('eixo Y é invertido (navegador: cima = -1; XInput: cima = +1)', () => {
  const state = mapPayload(padPayload({ axes: [0.5, -1, -0.25, 1] }));
  assert.equal(state.lx, 0.5);
  assert.equal(state.ly, 1);
  assert.equal(state.rx, -0.25);
  assert.equal(state.ry, -1);
});

test('zona morta zera o drift e valores são limitados a -1..1', () => {
  const drift = mapPayload(padPayload({ axes: [0.03, -0.04, 0.049, 0] }));
  assert.equal(isNeutral(drift), true);

  const big = mapPayload(padPayload({ axes: [5, -5, 0, 0] }));
  assert.equal(big.lx, 1);
  assert.equal(big.ly, 1);
});

test('payload inválido é rejeitado sem lançar', () => {
  assert.equal(mapPayload(null), null);
  assert.equal(mapPayload('x'), null);
  assert.equal(mapPayload({ axes: 1, buttons: [] }), null);
  assert.equal(mapPayload({ axes: [], buttons: 'a' }), null);

  const junk = mapPayload({ axes: ['a', null, NaN, undefined], buttons: [null, 5, 'x', [1]] });
  assert.equal(isNeutral(junk), false); // [1] no índice 3 é o botão Y
  assert.deepEqual(junk.buttons, ['Y']);
  assert.equal(junk.lx, 0);
});

/* ------------------------------ ponta a ponta ------------------------------ */

let child;
const sockets = [];

function openWS() {
  const ws = new WebSocket(WS_URL);
  sockets.push(ws);
  const queue = [];
  const waiters = [];
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    const index = waiters.findIndex((w) => w.predicate(msg));
    if (index >= 0) waiters.splice(index, 1)[0].resolve(msg);
    else queue.push(msg);
  });
  return {
    opened: new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve);
      ws.addEventListener('error', () => reject(new Error('ws error')));
    }),
    send: (obj) => ws.send(JSON.stringify(obj)),
    next(predicate, timeout = 5000) {
      const found = queue.findIndex(predicate);
      if (found >= 0) return Promise.resolve(queue.splice(found, 1)[0]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout esperando mensagem ws')), timeout);
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
    headers: { 'Content-Type': 'application/json' },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

function recordingSink() {
  const calls = [];
  return {
    calls,
    last: () => calls.at(-1),
    sink: {
      name: 'teste',
      async start() {},
      apply: (state) => calls.push(state),
      async close() {},
    },
  };
}

test.before(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xboxplay-bridge-'));
  child = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(PORT),
      BASE_URL: BASE,
      DATA_DIR: dataDir,
      PAYMENT_MODE: 'mock',
      REQUIRE_ONLINE: '0', // a ponte só conecta depois da compra neste teste
      MP_ACCESS_TOKEN: '',
      ADMIN_PASSWORD: 'senha-bridge-e2e',
      HOST_KEY,
      DEBUG: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => process.stderr.write(d));

  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return;
    } catch {
      /* ainda subindo */
    }
    await sleep(250);
  }
  throw new Error('servidor não subiu');
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

test('servidor fora do ar: a ponte tenta reconectar sozinha', async () => {
  const { sink } = recordingSink();
  const logs = [];
  const bridge = createBridge({
    url: 'ws://127.0.0.1:1/ws', // porta fechada
    key: HOST_KEY,
    sink,
    log: (text) => logs.push(text),
  });
  bridge.start();
  await until(() => logs.filter((l) => l.startsWith('Reconectando')).length >= 2, 5000);
  await bridge.stop();
});

test('chave de host errada derruba a ponte sem ficar tentando reconectar', async () => {
  const { sink } = recordingSink();
  let fatal = null;
  const bridge = createBridge({
    url: WS_URL,
    key: 'chave-errada',
    sink,
    log: () => {},
    onFatal: (err) => {
      fatal = err;
    },
  });
  bridge.start();
  await until(() => fatal !== null);
  assert.equal(fatal.message, 'invalid_host_key');
  await bridge.stop();
});

test('controle só vale com sessão ativa e é solto ao desistir', async () => {
  // 1) Compra e pagamento
  const created = await api('/api/orders', {
    method: 'POST',
    body: { hours: 1, name: 'Cliente Bridge', phone: '11988887777' },
  });
  assert.equal(created.status, 201);
  const paid = await api(`/api/orders/${created.data.id}/mock-pay`, { method: 'POST' });
  const token = new URL(paid.data.session.playUrl).searchParams.get('s');

  // 2) Host e viewer conectados
  const host = openWS();
  await host.opened;
  host.send({ type: 'hello', role: 'host', key: HOST_KEY });
  await host.next((m) => m.type === 'hello');

  const viewer = openWS();
  await viewer.opened;
  viewer.send({ type: 'hello', role: 'viewer', token });
  await viewer.next((m) => m.type === 'hello');

  // 3) Ponte conecta (sessão ainda em "provisioning")
  const rec = recordingSink();
  const bridge = createBridge({
    url: WS_URL,
    key: HOST_KEY,
    sink: rec.sink,
    log: () => {},
    watchdogMs: 800,
  });
  bridge.start();
  await until(() => bridge.stats !== undefined);
  await sleep(300); // handshake do bridge

  // Antes de a transmissão começar, o controle é ignorado
  viewer.send({ type: 'input', payload: padPayload({ pressed: [0] }) });
  await sleep(300);
  assert.equal(rec.calls.length, 0, 'não deve aplicar controle antes de a sessão ficar ativa');
  assert.equal(bridge.stats.ignored >= 1, true);

  // 4) Host publica: sessão fica ativa
  host.send({ type: 'stream:ready' });
  await viewer.next((m) => m.type === 'stream:ready');
  await sleep(500); // broadcast de estado até a ponte

  // 5) Cliente aperta A e move o analógico para cima
  viewer.send({ type: 'input', payload: padPayload({ axes: [0, -1, 0, 0], pressed: [0], triggers: { rt: 1 } }) });
  await until(() => rec.calls.length >= 1);
  assert.deepEqual(rec.last().buttons, ['A']);
  assert.equal(rec.last().ly, 1);
  assert.equal(rec.last().rt, 1);

  // Estado repetido não é reaplicado
  const before = rec.calls.length;
  viewer.send({ type: 'input', payload: padPayload({ axes: [0, -1, 0, 0], pressed: [0], triggers: { rt: 1 } }) });
  await sleep(200);
  assert.equal(rec.calls.length, before);

  // 6) Watchdog: sem novos eventos, a ponte solta tudo
  await until(() => isNeutral(rec.last()), 3000);

  // 7) Aperta de novo e, em seguida, o cliente desiste → solta tudo
  viewer.send({ type: 'input', payload: padPayload({ pressed: [1] }) });
  await until(() => rec.last().buttons.includes('B'));

  const forfeit = await api('/api/session/forfeit', { method: 'POST', body: { token, confirm: true } });
  assert.equal(forfeit.status, 200);
  await until(() => isNeutral(rec.last()), 3000);

  // Depois de encerrar, novos eventos são ignorados
  const afterEnd = rec.calls.length;
  viewer.send({ type: 'input', payload: padPayload({ pressed: [0] }) });
  await sleep(300);
  assert.equal(rec.calls.length, afterEnd);

  await bridge.stop();
});
