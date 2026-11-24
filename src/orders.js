import { config } from './config.js';
import { store, pushEvent } from './state.js';
import { bus } from './bus.js';
import { bad, conflict, notFound } from './errors.js';
import { id, now, token, brl } from './util.js';
import { quote, nextHourPrice, MAX_HOURS } from './pricing.js';
import {
  extendSessionWithOrder,
  publicSession,
  remainingMs,
  startSessionForOrder,
  validateCustomer,
} from './sessions.js';
import { assertSlotAvailableFor } from './queue.js';
import { createPixCharge, getPayment } from './payments.js';

export function findOrder(orderID, state = store.data) {
  return state.orders.find((o) => o.id === orderID) ?? null;
}

function requireOrder(orderID) {
  const order = findOrder(orderID);
  if (!order) throw notFound('Pedido não encontrado.');
  return order;
}

function newOrderBase({ kind, hours, customer, email, amountCents, breakdown, ttlSec }) {
  const t = now();
  return {
    id: id('ord_'),
    kind,
    hours,
    amountCents,
    breakdown,
    name: customer.name,
    phone: customer.phone,
    email: email || null,
    status: 'pending',
    createdAt: t,
    expiresAt: t + ttlSec * 1000,
    paidAt: null,
    mpPaymentId: null,
    qrCode: null,
    qrCodeBase64: null,
    ticketUrl: null,
    provider: config.paymentMode,
    sessionID: null,
    sessionToken: token(),
    queueID: null,
    needsAttention: false,
    attentionReason: null,
    lastCheckedAt: 0,
  };
}

async function attachCharge(order) {
  try {
    const charge = await createPixCharge(order);
    store.mutate((state) => {
      const o = state.orders.find((x) => x.id === order.id);
      if (!o) return;
      o.mpPaymentId = charge.mpPaymentId;
      o.qrCode = charge.qrCode;
      o.qrCodeBase64 = charge.qrCodeBase64;
      o.ticketUrl = charge.ticketUrl;
      o.provider = charge.provider;
      o.chargeStatus = charge.status ?? 'pending';
    });
    return order;
  } catch (err) {
    store.mutate((state) => {
      const o = state.orders.find((x) => x.id === order.id);
      if (!o) return;
      o.status = 'canceled';
      o.canceledAt = now();
      o.cancelReason = 'payment_provider_error';
      pushEvent(state, 'order.canceled', { orderID: o.id, reason: 'payment_provider_error' }, 'error');
    });
    throw err;
  }
}

/**
 * Compra inicial (1 a 4 horas de uma vez).
 * O slot fica reservado durante a janela do Pix.
 */
export async function createInitialOrder({ hours, name, phone, email, queueID = null }) {
  const customer = validateCustomer({ name, phone });
  const q = quote(0, hours);
  if (!q.ok) throw bad(q.message, q.code);

  assertSlotAvailableFor(queueID);

  const order = newOrderBase({
    kind: 'new',
    hours: q.totalHoursAfter,
    customer,
    email,
    amountCents: q.amountCents,
    breakdown: q.breakdown,
    ttlSec: config.paymentTtlSec,
  });
  order.queueID = queueID;

  store.mutate((state) => {
    // Revalida dentro da mutação: nada entra entre o assert e o push.
    const pending = state.orders.find(
      (o) => o.kind === 'new' && o.status === 'pending' && o.expiresAt > now(),
    );
    if (pending) {
      throw conflict('Outra pessoa está finalizando o pagamento.', 'slot_reserved', {
        until: pending.expiresAt,
      });
    }
    state.orders.push(order);
    pushEvent(state, 'order.created', {
      orderID: order.id,
      kind: 'new',
      hours: order.hours,
      amountCents: order.amountCents,
    });
  });

  bus.emit('state:changed');
  return attachCharge(order);
}

/**
 * Compra de hora adicional, só enquanto a sessão está ativa e antes de acabar.
 * Preço da próxima hora já vem com o desconto (7 → 6 → 5 → 4).
 */
export async function createExtensionOrder({ sessionToken, hours }) {
  const t = now();
  const session = store.data.session;

  if (!session || session.token !== sessionToken) {
    throw notFound('Sessão não encontrada. Abra o link que você recebeu.');
  }
  if (session.status !== 'active') {
    throw conflict('A sessão não está ativa. Não é possível adicionar tempo.', 'session_not_active');
  }
  if (t >= session.endsAt) {
    throw conflict('O tempo acabou. Não é possível adicionar horas.', 'time_up');
  }

  const q = quote(session.hoursPurchased, hours);
  if (!q.ok) throw bad(q.message, q.code);

  const expiresInMs = session.endsAt - t;
  if (expiresInMs < 120_000) {
    throw conflict(
      'Faltam menos de 2 minutos. Não dá tempo de pagar e aproveitar a hora extra.',
      'too_late_to_extend',
    );
  }

  const order = newOrderBase({
    kind: 'extension',
    hours,
    customer: { name: session.customer.name, phone: session.customer.phone },
    email: null,
    amountCents: q.amountCents,
    breakdown: q.breakdown,
    ttlSec: Math.min(config.paymentTtlSec, Math.floor(expiresInMs / 1000)),
  });
  order.sessionID = session.id;
  order.sessionToken = null;

  store.mutate((state) => {
    state.orders.push(order);
    pushEvent(state, 'order.created', {
      orderID: order.id,
      kind: 'extension',
      hours: order.hours,
      amountCents: order.amountCents,
      sessionID: order.sessionID,
    });
  });

  bus.emit('state:changed');
  return attachCharge(order);
}

/** Aplica o pagamento. Idempotente: webhook + polling podem chamar juntos. */
export function markOrderPaid(orderID, meta = {}) {
  const t = now();
  const result = store.mutate((state) => {
    const order = state.orders.find((o) => o.id === orderID);
    if (!order) return { error: 'not_found' };
    if (order.status === 'paid') return { order, already: true };
    if (order.status === 'refunded') return { order, ignored: 'refunded' };

    order.status = 'paid';
    order.paidAt = t;
    order.paymentSource = meta.source ?? 'webhook';
    if (meta.paymentId) order.mpPaymentId = String(meta.paymentId);

    pushEvent(state, 'order.paid', {
      orderID: order.id,
      kind: order.kind,
      amountCents: order.amountCents,
      source: order.paymentSource,
    });

    return { order, already: false };
  });

  if (result.error) throw notFound('Pedido não encontrado.');
  if (result.already || result.ignored) return result.order;

  let session = null;
  try {
    session = result.order.kind === 'new'
      ? startSessionForOrder(result.order)
      : extendSessionWithOrder(result.order);
  } catch (err) {
    // O dinheiro entrou. Registra para tratamento manual em vez de perder o fato.
    store.mutate((state) => {
      const o = state.orders.find((x) => x.id === result.order.id);
      if (o) {
        o.needsAttention = true;
        o.attentionReason = 'erro_ao_aplicar_pagamento';
      }
      pushEvent(state, 'order.apply_error', {
        orderID: orderID,
        message: err.message,
      }, 'error');
    });
  }

  bus.emit('order:paid', { order: result.order, session });
  bus.emit('state:changed');
  return result.order;
}

/** Consulta o MP quando o webhook não chega (localhost, sem túnel). */
export async function refreshOrder(orderID) {
  const order = requireOrder(orderID);

  if (
    order.status === 'pending'
    && config.paymentMode === 'mercadopago'
    && order.mpPaymentId
  ) {
    const t = now();
    if (t - (order.lastCheckedAt || 0) > 2500) {
      store.mutate(() => {
        order.lastCheckedAt = t;
      });
      try {
        const payment = await getPayment(order.mpPaymentId);
        if (payment?.status === 'approved') {
          markOrderPaid(order.id, { paymentId: payment.id, source: 'poll' });
        }
      } catch {
        // Falha de rede não derruba o polling; o próximo ciclo tenta de novo.
      }
    }
  }

  return findOrder(orderID);
}

export function cancelOrder(orderID) {
  const t = now();
  return store.mutate((state) => {
    const order = state.orders.find((o) => o.id === orderID);
    if (!order) throw notFound('Pedido não encontrado.');
    if (order.status === 'paid') {
      throw conflict('Este pedido já foi pago.', 'already_paid');
    }
    if (order.status !== 'pending') return order;
    order.status = 'canceled';
    order.canceledAt = t;
    order.cancelReason = 'user';
    pushEvent(state, 'order.canceled', { orderID: order.id, reason: 'user' });
    bus.emit('state:changed');
    return order;
  });
}

export function orderView(order, { withToken = true } = {}) {
  const t = now();
  const state = store.data;
  const session = order.sessionID
    ? state.session && state.session.id === order.sessionID ? state.session : null
    : null;

  const paid = order.status === 'paid';
  const isLive = session && ['provisioning', 'active'].includes(session.status);

  let priceNext = null;
  if (order.kind === 'extension') priceNext = order.amountCents;

  return {
    id: order.id,
    kind: order.kind,
    status: order.status,
    hours: order.hours,
    amountCents: order.amountCents,
    amountLabel: brl(order.amountCents),
    breakdown: order.breakdown,
    createdAt: order.createdAt,
    expiresAt: order.expiresAt,
    expiresInMs: Math.max(0, order.expiresAt - t),
    paid,
    needsAttention: Boolean(order.needsAttention),
    qrCode: order.status === 'pending' ? order.qrCode : null,
    qrCodeBase64: order.status === 'pending' ? order.qrCodeBase64 : null,
    ticketUrl: order.status === 'pending' ? order.ticketUrl : null,
    paymentMode: config.paymentMode,
    nextHourCents: priceNext ?? nextHourPrice(session?.hoursPurchased ?? 0),
    session: session
      ? {
          ...publicSession(session, t),
          // Só entrega o link de jogo ao dono do pedido pago.
          playUrl: withToken && paid && order.kind === 'new' && isLive
            ? `${config.baseUrl}/play.html?s=${encodeURIComponent(session.token)}`
            : null,
          remainingMs: remainingMs(session, t),
        }
      : null,
  };
}

export function publicOrderView(order) {
  return orderView(order, { withToken: order.status === 'paid' });
}

export function adminOrders(limit = 40) {
  return store.data.orders.slice(-limit).reverse().map((o) => ({
    id: o.id,
    kind: o.kind,
    status: o.status,
    hours: o.hours,
    amountCents: o.amountCents,
    amountLabel: brl(o.amountCents),
    name: o.name,
    phone: o.phone,
    createdAt: o.createdAt,
    paidAt: o.paidAt,
    needsAttention: Boolean(o.needsAttention),
    attentionReason: o.attentionReason,
    sessionID: o.sessionID,
  }));
}

export { MAX_HOURS };
