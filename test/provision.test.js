import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xboxplay-provision-'));
process.env.DATA_DIR = tempDir;
process.env.PAYMENT_MODE = 'mock';
process.env.BASE_URL = 'http://localhost:9999';
process.env.ADMIN_PASSWORD = 'senha-teste';
process.env.HOST_KEY = 'chave-host-teste';
process.env.MP_ACCESS_TOKEN = '';
process.env.PROVISION_TIMEOUT_SEC = '180';

const { createInitialOrder, markOrderPaid, findOrder, publicOrderView } = await import('../src/orders.js');
const { markStreamReady, slotStatus, tick } = await import('../src/sessions.js');
const { store } = await import('../src/state.js');

const customer = { name: 'Cliente Timeout', phone: '11999998888' };

async function until(predicate, timeout = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condição não atingida a tempo');
}

const refundedEvents = (orderID) => store.data.events.filter(
  (e) => e.type === 'order.refunded' && e.detail.orderID === orderID,
);

test('host não sobe a transmissão a tempo: sem relógio, com estorno e vaga livre', async () => {
  const order = await createInitialOrder({ hours: 1, ...customer });
  markOrderPaid(order.id, { source: 'test' });

  assert.equal(store.data.session.status, 'provisioning');
  assert.equal(store.data.counters.revenueCents, 700);

  // Dentro do prazo, nada acontece.
  tick(Date.now() + 179_000);
  assert.equal(store.data.session.status, 'provisioning');
  assert.equal(findOrder(order.id).refundPending, undefined);

  // Passou do prazo: encerra sem iniciar o tempo.
  const result = tick(Date.now() + 181_000);
  const session = store.data.session;
  assert.equal(result.provisionFailed?.id, session.id);
  assert.equal(session.status, 'ended');
  assert.equal(session.endedReason, 'provision_timeout');
  assert.equal(session.startedAt, null, 'o relógio não pode ter começado');
  assert.equal(session.endsAt, null);
  assert.equal(slotStatus().status, 'free');
  assert.equal(findOrder(order.id).refundPending, true);

  // O estorno automático conclui sozinho.
  await until(() => findOrder(order.id).status === 'refunded');
  const refunded = findOrder(order.id);
  assert.equal(refunded.refundReason, 'provision_timeout');
  assert.equal(refunded.refundPending, false);
  assert.equal(store.data.counters.revenueCents, 0, 'estorno não conta como venda');
  assert.equal(store.data.counters.hoursSold, 0);

  // O cliente enxerga o que aconteceu.
  const view = publicOrderView(refunded);
  assert.equal(view.status, 'refunded');
  assert.equal(view.refundReason, 'provision_timeout');
  assert.equal(view.session.failedToStart, true);
  assert.equal(view.session.playUrl, null);

  // Ticks seguintes não estornam de novo.
  tick(Date.now() + 400_000);
  tick(Date.now() + 500_000);
  assert.equal(refundedEvents(order.id).length, 1);
});

test('estorno automático que falha fica marcado para o operador', async () => {
  const order = await createInitialOrder({ hours: 2, ...customer });
  markOrderPaid(order.id, { source: 'test' });

  // Sem id de pagamento não há o que estornar: simula a falha.
  store.mutate(() => {
    findOrder(order.id).mpPaymentId = null;
  });

  tick(Date.now() + 181_000);
  await until(() => findOrder(order.id).needsAttention === true);

  const stuck = findOrder(order.id);
  assert.equal(stuck.status, 'paid', 'continua pago: o dinheiro não foi devolvido');
  assert.equal(stuck.refundPending, true);
  assert.equal(stuck.attentionReason, 'estorno_automatico_falhou');
  assert.ok(store.data.events.some((e) => e.type === 'order.refund_failed' && e.detail.orderID === order.id));
  assert.equal(slotStatus().status, 'free', 'a vaga é liberada mesmo assim');

  const view = publicOrderView(stuck);
  assert.equal(view.refundPending, true);
  assert.equal(view.needsAttention, true);
});

test('sessão que já começou a transmitir não é afetada pelo prazo', async () => {
  const order = await createInitialOrder({ hours: 1, ...customer });
  markOrderPaid(order.id, { source: 'test' });
  const session = store.data.session;

  markStreamReady(session.id);
  const result = tick(Date.now() + 181_000);

  assert.equal(result.provisionFailed, null);
  assert.equal(store.data.session.status, 'active');
  assert.equal(findOrder(order.id).status, 'paid');
  assert.ok(store.data.session.startedAt > 0);
});
