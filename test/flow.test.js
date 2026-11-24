import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xboxplay-flow-'));
process.env.DATA_DIR = tempDir;
process.env.PAYMENT_MODE = 'mock';
process.env.BASE_URL = 'http://localhost:9999';
process.env.ADMIN_PASSWORD = 'senha-teste';
process.env.HOST_KEY = 'chave-host-teste';
process.env.MP_ACCESS_TOKEN = '';
process.env.QUEUE_HOLD_SEC = '300';
process.env.PROVISION_TIMEOUT_SEC = '180';

const {
  createExtensionOrder,
  createInitialOrder,
  markOrderPaid,
  findOrder,
} = await import('../src/orders.js');
const {
  endSession,
  markStreamReady,
  remainingMs,
  sessionView,
  slotStatus,
  tick,
} = await import('../src/sessions.js');
const { joinQueue, getQueueEntry } = await import('../src/queue.js');
const { store } = await import('../src/state.js');

const customer = { name: 'Jogador Teste', phone: '11999998888' };

test('fluxo completo de uma sessão', async (t) => {
  let session;

  await t.test('pedido inicial reserva o slot e cria Pix', async () => {
    const order = await createInitialOrder({ hours: 1, ...customer });

    assert.equal(order.status, 'pending');
    assert.equal(order.amountCents, 700);
    assert.ok(order.qrCode, 'qr code em modo mock');
    assert.equal(slotStatus().status, 'reserved');
    assert.equal(order.sessionToken.length > 20, true);
  });

  await t.test('não deixa outra pessoa reservar enquanto o Pix está aberto', async () => {
    await assert.rejects(
      () => createInitialOrder({ hours: 1, ...customer }),
      (err) => err.code === 'slot_reserved' || err.code === 'conflict',
    );
  });

  await t.test('pagamento aprovado cria a sessão (provisionando)', () => {
    const order = store.data.orders.find((o) => o.status === 'pending');
    markOrderPaid(order.id, { source: 'test' });

    session = store.data.session;
    assert.ok(session);
    assert.equal(session.status, 'provisioning');
    assert.equal(session.hoursPurchased, 1);
    assert.equal(session.startedAt, null);
    assert.equal(slotStatus().status, 'busy');
  });

  await t.test('transmissão pronta inicia o relógio', () => {
    const updated = markStreamReady(session.id);
    assert.ok(updated);
    assert.equal(updated.status, 'active');
    assert.ok(updated.startedAt > 0);
    const left = updated.endsAt - updated.startedAt;
    assert.equal(left, 3600_000);
    assert.ok(remainingMs(updated) <= 3600_000);
  });

  await t.test('hora extra: cobra R$ 6 e estende o fim', async () => {
    const before = store.data.session.endsAt;
    const order = await createExtensionOrder({ sessionToken: store.data.session.token, hours: 1 });
    assert.equal(order.amountCents, 600);

    markOrderPaid(order.id, { source: 'test' });
    const after = store.data.session;

    assert.equal(after.hoursPurchased, 2);
    assert.equal(after.endsAt, before + 3600_000);
    assert.equal(after.amountCentsTotal, 1300);
  });

  await t.test('não dá para passar de 4h', async () => {
    const token = store.data.session.token;
    await createExtensionOrder({ sessionToken: token, hours: 2 });
    const pending = store.data.orders.find((o) => o.kind === 'extension' && o.status === 'pending');
    markOrderPaid(pending.id, { source: 'test' });

    assert.equal(store.data.session.hoursPurchased, 4);
    await assert.rejects(
      () => createExtensionOrder({ sessionToken: token, hours: 1 }),
      (err) => err.code === 'max_hours',
    );
  });

  await t.test('desistir encerra na hora e libera o slot', () => {
    const ended = endSession('forfeited', { by: 'player' });
    assert.equal(ended.status, 'forfeited');
    assert.equal(slotStatus().status, 'free');
    assert.equal(sessionView(ended.token).status, 'forfeited');
  });

  await t.test('sessionView rejeita token desconhecido', () => {
    assert.throws(() => sessionView('token-errado'), (err) => err.code === 'invalid_token');
  });

  await t.test('relógio expira a sessão sozinho', async () => {
    const order = await createInitialOrder({ hours: 1, ...customer });
    markOrderPaid(order.id, { source: 'test' });
    markStreamReady(store.data.session.id);

    store.mutate((state) => {
      state.session.endsAt = Date.now() - 1;
    });

    const result = tick();
    assert.equal(store.data.session.status, 'ended');
    assert.equal(store.data.session.endedReason, 'time_up');
    assert.equal(result.sessionEnded?.id, store.data.session.id);
    assert.equal(slotStatus().status, 'free');
  });

  await t.test('fila: entra, é chamada e compra com prioridade', async () => {
    const first = await createInitialOrder({ hours: 1, ...customer });
    markOrderPaid(first.id, { source: 'test' });
    markStreamReady(store.data.session.id);

    const joined = joinQueue({ name: 'Fila Um', phone: '11911112222' });
    assert.equal(joined.entry.position, 1);
    assert.equal(joined.entry.status, 'waiting');

    endSession('time_up', { by: 'test' });
    tick();

    const entry = getQueueEntry(joined.entry.id);
    assert.equal(entry.status, 'notified');
    assert.equal(entry.canBuyNow, true);
    assert.equal(slotStatus().status, 'held');

    // Outro cliente não pode furar a fila.
    await assert.rejects(
      () => createInitialOrder({ hours: 1, name: 'Fura Fila', phone: '11933334444' }),
      (err) => err.code === 'slot_held',
    );

    const order = await createInitialOrder({ hours: 2, name: 'Fila Um', phone: '11911112222', queueID: joined.entry.id });
    assert.equal(order.amountCents, 1300);
    markOrderPaid(order.id, { source: 'test' });

    assert.equal(store.data.session.hoursPurchased, 2);
    assert.equal(store.data.queue.find((q) => q.id === joined.entry.id).status, 'consumed');
    assert.equal(findOrder(order.id).status, 'paid');
  });
});
