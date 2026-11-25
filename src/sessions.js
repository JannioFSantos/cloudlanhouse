import { config } from './config.js';
import { store, pushEvent } from './state.js';
import { bus } from './bus.js';
import { ApiError, bad, conflict, notFound } from './errors.js';
import { id, now, phoneDigits } from './util.js';
import { HOURLY_CENTS, MAX_HOURS, quote, nextHourPrice } from './pricing.js';
import { availability } from './availability.js';

export const ACTIVE_STATUSES = ['provisioning', 'active'];
export const OPEN_ORDER_STATUSES = ['pending'];

export function validateCustomer({ name, phone }) {
  const cleanName = String(name ?? '').trim().replace(/\s+/g, ' ');
  const digits = phoneDigits(phone);
  if (cleanName.length < 2 || cleanName.length > 60) {
    throw bad('Informe seu nome (2 a 60 caracteres).', 'invalid_name');
  }
  if (digits.length < 10) {
    throw bad('Informe um WhatsApp válido com DDD.', 'invalid_phone');
  }
  return { name: cleanName, phone: digits };
}

export function activeSession(state = store.data) {
  const s = state.session;
  return s && ACTIVE_STATUSES.includes(s.status) ? s : null;
}

export function pendingOrderForSlot(state = store.data, t = now()) {
  return state.orders
    .filter((o) => o.kind === 'new' && o.status === 'pending' && o.expiresAt > t)
    .sort((a, b) => a.createdAt - b.createdAt)[0] ?? null;
}

export function heldQueueEntry(state = store.data, t = now()) {
  return state.queue.find((q) => q.status === 'notified' && q.holdUntil > t) ?? null;
}

/**
 * Quem pode usar o Xbox agora?
 * busy     → sessão em andamento (ou provisionando)
 * reserved → alguém está com um Pix aberto (15 min)
 * held     → alguém da fila foi chamado e tem 5 min para pagar
 * free     → livre
 */
export function slotStatus(t = now(), state = store.data) {
  const session = activeSession(state);
  if (session) {
    return {
      status: 'busy',
      until: session.endsAt,
      sessionStatus: session.status,
      streamReady: Boolean(session.streamReady),
    };
  }

  const pending = pendingOrderForSlot(state, t);
  if (pending) {
    return { status: 'reserved', until: pending.expiresAt, orderID: pending.id };
  }

  const hold = heldQueueEntry(state, t);
  if (hold) {
    return { status: 'held', until: hold.holdUntil, queueID: hold.id };
  }

  return { status: 'free' };
}

export function remainingMs(session, t = now()) {
  if (!session || !session.endsAt) return 0;
  return Math.max(0, session.endsAt - t);
}

export function publicSession(session, t = now()) {
  if (!session) return null;
  return {
    status: session.status,
    streamReady: Boolean(session.streamReady),
    startedAt: session.startedAt,
    endsAt: session.endsAt,
    remainingMs: remainingMs(session, t),
    hoursPurchased: session.hoursPurchased,
    nextHourCents: nextHourPrice(session.hoursPurchased),
    canExtend: session.status === 'active'
      && t < session.endsAt
      && session.hoursPurchased < MAX_HOURS,
    failedProvision: session.status === 'provisioning'
      && t - session.createdAt > config.provisionTimeoutSec * 1000,
  };
}

/** Estado público (landing, polling) — sem telefone, sem token, sem id interno. */
export function publicStatus(t = now(), state = store.data) {
  const session = activeSession(state);
  const hold = heldQueueEntry(state, t);
  return {
    serverNow: t,
    slot: slotStatus(t, state),
    session: session ? publicSession(session, t) : null,
    queue: {
      waiting: state.queue.filter((q) => q.status === 'waiting').length,
      holdUntil: hold?.holdUntil ?? null,
    },
    pricing: {
      hourlyCents: HOURLY_CENTS,
      maxHours: MAX_HOURS,
    },
    paymentMode: config.paymentMode,
    availability: availability(),
  };
}

/** Visão do dono da sessão (por token). */
export function sessionView(tokenValue) {
  const t = now();
  const session = store.data.session;
  if (!session || session.token !== tokenValue) {
    throw new ApiError(401, 'invalid_token', 'Link de sessão inválido ou expirado.');
  }
  return {
    serverNow: t,
    id: session.id,
    status: session.status,
    customer: { name: session.customer.name },
    startedAt: session.startedAt,
    endsAt: session.endsAt,
    remainingMs: remainingMs(session, t),
    hoursPurchased: session.hoursPurchased,
    amountCentsTotal: session.amountCentsTotal,
    nextHourCents: nextHourPrice(session.hoursPurchased),
    maxHours: MAX_HOURS,
    canExtend: session.status === 'active'
      && t < session.endsAt
      && session.hoursPurchased < MAX_HOURS,
    streamReady: Boolean(session.streamReady),
    playerUrl: `${config.baseUrl}/play.html?s=${encodeURIComponent(session.token)}`,
    warnings: session.warningsSent,
    endedReason: session.endedReason,
  };
}

/**
 * Pagamento aprovado de pacote inicial → cria a sessão.
 * Só é chamado quando a ordem passa de pending para paid (idempotente).
 */
export function startSessionForOrder(order) {
  const t = now();
  return store.mutate((state) => {
    if (activeSession(state)) {
      order.needsAttention = true;
      order.attentionReason = 'slot_ocupado_no_pagamento';
      pushEvent(state, 'order.orphan', {
        orderID: order.id,
        reason: 'slot_ocupado_no_pagamento',
        amountCents: order.amountCents,
      }, 'warn');
      return null;
    }

    const session = {
      id: id('ses_'),
      token: order.sessionToken,
      createdAt: t,
      startedAt: null,
      endsAt: null,
      status: 'provisioning',
      customer: { name: order.name, phone: order.phone },
      hoursPurchased: order.hours,
      amountCentsTotal: order.amountCents,
      orderIDs: [order.id],
      warningsSent: [],
      streamReady: false,
      viewer: { connected: false, lastSeenAt: null, connections: 0 },
      endedAt: null,
      endedReason: null,
    };

    state.session = session;
    order.sessionID = session.id;
    state.counters.sessionsTotal += 1;
    state.counters.hoursSold += order.hours;
    state.counters.revenueCents += order.amountCents;

    if (order.queueID) {
      const entry = state.queue.find((q) => q.id === order.queueID);
      if (entry) {
        entry.status = 'consumed';
        entry.consumedAt = t;
      }
    }

    pushEvent(state, 'session.created', {
      sessionID: session.id,
      hours: order.hours,
      amountCents: order.amountCents,
      orderID: order.id,
    });

    bus.emit('session:created', { session });
    return session;
  });
}

/** Host avisou que a captura está publicando. Aqui o relógio começa. */
export function markStreamReady(sessionID) {
  const t = now();
  const result = store.mutate((state) => {
    const s = state.session;
    if (!s || s.id !== sessionID) return null;
    if (s.status !== 'provisioning') {
      if (s.status === 'active') {
        s.streamReady = true;
        return { changed: false, session: s };
      }
      return null;
    }

    s.streamReady = true;
    s.startedAt = t;
    s.endsAt = t + s.hoursPurchased * 3600_000;
    s.status = 'active';
    pushEvent(state, 'session.started', { sessionID: s.id, endsAt: s.endsAt });
    return { changed: true, session: s };
  });

  if (result?.changed) bus.emit('session:started', { session: result.session });
  return result?.session ?? null;
}

/** Pagamento aprovado de hora adicional. */
export function extendSessionWithOrder(order) {
  const t = now();
  return store.mutate((state) => {
    const s = state.session;

    const fail = (reason) => {
      order.needsAttention = true;
      order.attentionReason = reason;
      pushEvent(state, 'order.orphan', {
        orderID: order.id,
        reason,
        amountCents: order.amountCents,
      }, 'warn');
      return null;
    };

    if (!s || s.id !== order.sessionID) return fail('sessao_nao_encontrada');
    if (s.status !== 'active' || t >= s.endsAt) return fail('tempo_esgotado');

    const q = quote(s.hoursPurchased, order.hours);
    if (!q.ok) return fail(q.code);

    s.hoursPurchased = q.totalHoursAfter;
    s.endsAt += order.hours * 3600_000;
    s.amountCentsTotal += order.amountCents;
    s.orderIDs.push(order.id);

    state.counters.hoursSold += order.hours;
    state.counters.revenueCents += order.amountCents;

    pushEvent(state, 'session.extended', {
      sessionID: s.id,
      hours: order.hours,
      amountCents: order.amountCents,
      endsAt: s.endsAt,
    });

    bus.emit('session:extended', { session: s });
    return s;
  });
}

/** Fim natural (tempo esgotado) ou desistência. Libera o slot. */
export function endSession(reason, { sessionID = null, by = 'system' } = {}) {
  const t = now();
  const ended = store.mutate((state) => {
    const s = state.session;
    if (!s) return null;
    if (sessionID && s.id !== sessionID) return null;
    if (!ACTIVE_STATUSES.includes(s.status)) return null;

    s.status = reason === 'forfeited' ? 'forfeited' : 'ended';
    s.endedReason = reason;
    s.endedAt = t;
    s.streamReady = false;

    pushEvent(state, 'session.ended', {
      sessionID: s.id,
      reason,
      by,
      hoursPurchased: s.hoursPurchased,
      playedMs: s.startedAt ? t - s.startedAt : 0,
    }, reason === 'forfeited' ? 'warn' : 'info');

    return s;
  });

  if (ended) bus.emit('session:ended', { session: ended, reason });
  return ended;
}

/** Tick do relógio: avisos, expiração de pedidos, fila. */
export function tick(t = now()) {
  const snapshot = store.data;
  const current = snapshot.session;

  const needsWarning = current?.status === 'active'
    && [10, 5, 1].some((m) => {
      const left = current.endsAt - t;
      return left <= m * 60_000 && left > 0 && !current.warningsSent.includes(String(m));
    });
  const needsExpiry = current?.status === 'active' && current.endsAt - t <= 0;
  const needsTimeout = current?.status === 'provisioning'
    && t - current.createdAt > config.provisionTimeoutSec * 1000;
  const expiredOrdersPending = snapshot.orders.some((o) => o.status === 'pending' && t > o.expiresAt);
  const heldExpired = snapshot.queue.some((q) => q.status === 'notified' && t > q.holdUntil);
  const slotOpen = !activeSession(snapshot) && !pendingOrderForSlot(snapshot, t)
    && !heldQueueEntry(snapshot, t);
  const someoneWaiting = snapshot.queue.some((q) => q.status === 'waiting');

  if (!needsWarning && !needsExpiry && !needsTimeout && !expiredOrdersPending
    && !heldExpired && !(slotOpen && someoneWaiting)) {
    return { warnings: [], expiredOrders: [], sessionEnded: null, provisionFailed: null };
  }

  let changed = false;
  const warnings = [];
  const expiredOrders = [];
  let notifyQueue = false;
  let sessionEnded = null;
  let provisionFailed = null;
  const refundOrders = [];

  store.mutate((state) => {
    const s = state.session;

    // Sessão em andamento
    if (s && s.status === 'active') {
      const left = s.endsAt - t;

      for (const minutes of [10, 5, 1]) {
        const key = String(minutes);
        const threshold = minutes * 60_000;
        if (left <= threshold && left > 0 && !s.warningsSent.includes(key)) {
          s.warningsSent.push(key);
          warnings.push({ minutes, remainingMs: left });
        }
      }

      if (left <= 0) {
        s.status = 'ended';
        s.endedReason = 'time_up';
        s.endedAt = t;
        s.streamReady = false;
        pushEvent(state, 'session.ended', {
          sessionID: s.id,
          reason: 'time_up',
          hoursPurchased: s.hoursPurchased,
        });
        sessionEnded = s;
        changed = true;
      }
    }

    // Provisionamento que nunca ficou pronto (host sem transmitir): o cliente
    // não chegou a jogar. O relógio NÃO começa; a sessão é encerrada, o slot
    // volta a ficar livre e o pagamento é estornado automaticamente.
    if (s && s.status === 'provisioning'
      && t - s.createdAt > config.provisionTimeoutSec * 1000) {
      s.status = 'ended';
      s.endedReason = 'provision_timeout';
      s.endedAt = t;
      s.streamReady = false;
      pushEvent(state, 'session.provision_failed', {
        sessionID: s.id,
        timeoutSec: config.provisionTimeoutSec,
      }, 'warn');

      const initial = state.orders.find(
        (o) => o.id === s.orderIDs[0] && o.status === 'paid',
      );
      if (initial) {
        initial.refundPending = true;
        initial.refundReason = 'provision_timeout';
        refundOrders.push(initial);
      }
      provisionFailed = s;
      changed = true;
    }

    // Pix não pago dentro da janela → libera
    for (const order of state.orders) {
      if (order.status === 'pending' && t > order.expiresAt) {
        order.status = 'expired';
        order.expiredAt = t;
        pushEvent(state, 'order.expired', { orderID: order.id, kind: order.kind });
        expiredOrders.push(order);
        changed = true;
      }
    }

    // Fila: chamado que não pagou a tempo perde a vez
    for (const entry of state.queue) {
      if (entry.status === 'notified' && t > entry.holdUntil) {
        entry.status = 'expired';
        entry.expiredAt = t;
        pushEvent(state, 'queue.expired', { entryID: entry.id }, 'info');
        changed = true;
      }
    }

    // Slot livre + fila esperando → chama o próximo
    if (!activeSession(state) && !pendingOrderForSlot(state, t) && !heldQueueEntry(state, t)) {
      const next = state.queue
        .filter((q) => q.status === 'waiting')
        .sort((a, b) => a.joinedAt - b.joinedAt)[0];
      if (next) {
        next.status = 'notified';
        next.notifiedAt = t;
        next.holdUntil = t + config.queueHoldSec * 1000;
        pushEvent(state, 'queue.notified', { entryID: next.id, name: next.name });
        notifyQueue = next;
        changed = true;
      }
    }
  });

  for (const w of warnings) bus.emit('session:warning', w);
  for (const o of expiredOrders) bus.emit('order:expired', { order: o });
  if (notifyQueue) bus.emit('queue:notified', { entry: notifyQueue });
  if (sessionEnded) bus.emit('session:ended', { session: sessionEnded, reason: 'time_up' });
  if (provisionFailed) {
    bus.emit('session:ended', { session: provisionFailed, reason: 'provision_timeout' });
  }
  for (const order of refundOrders) bus.emit('order:refund_needed', { order });
  if (changed) bus.emit('state:changed');

  return { warnings, expiredOrders, sessionEnded, provisionFailed };
}
