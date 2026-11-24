import { config } from './config.js';
import { store, pushEvent } from './state.js';
import { bus } from './bus.js';
import { bad, conflict, notFound } from './errors.js';
import { id, now } from './util.js';
import { activeSession, pendingOrderForSlot, slotStatus, validateCustomer } from './sessions.js';

function positionOf(state, entry, t = now()) {
  if (entry.status === 'notified') return 1;
  if (entry.status !== 'waiting') return null;
  const waiting = state.queue
    .filter((q) => q.status === 'waiting' && q.joinedAt <= entry.joinedAt)
    .sort((a, b) => a.joinedAt - b.joinedAt);
  return waiting.findIndex((q) => q.id === entry.id) + 1;
}

/** Entra na fila. Não faz sentido entrar se o Xbox está livre. */
export function joinQueue({ name, phone }) {
  const customer = validateCustomer({ name, phone });
  const t = now();

  return store.mutate((state) => {
    const mine = state.queue.find(
      (q) => q.phone === customer.phone && ['waiting', 'notified'].includes(q.status),
    );
    if (mine) {
      return {
        entry: queueView(state, mine, t),
        alreadyInQueue: true,
      };
    }

    const slot = slotStatus(t, state);
    if (slot.status === 'free') {
      throw conflict('O Xbox está livre agora. Compre direto, sem fila.', 'slot_free');
    }

    const entry = {
      id: id('q_'),
      name: customer.name,
      phone: customer.phone,
      joinedAt: t,
      status: 'waiting',
      notifiedAt: null,
      holdUntil: null,
      consumedAt: null,
      expiredAt: null,
    };
    state.queue.push(entry);
    state.queue.sort((a, b) => a.joinedAt - b.joinedAt);
    pushEvent(state, 'queue.joined', { entryID: entry.id, name: entry.name });
    return { entry: queueView(state, entry, t), alreadyInQueue: false };
  });
}

function queueView(state, entry, t = now()) {
  return {
    id: entry.id,
    name: entry.name,
    status: entry.status,
    position: positionOf(state, entry, t),
    joinedAt: entry.joinedAt,
    holdUntil: entry.holdUntil,
    canBuyNow: entry.status === 'notified' && entry.holdUntil > t,
    waitAhead: Math.max(0, (positionOf(state, entry, t) ?? 1) - 1),
  };
}

export function getQueueEntry(entryID) {
  const entry = store.data.queue.find((q) => q.id === entryID);
  if (!entry) throw notFound('Entrada na fila não encontrada.');
  const t = now();
  const view = queueView(store.data, entry, t);
  if (entry.status === 'notified' && entry.holdUntil <= t) {
    return { ...view, status: 'expired', canBuyNow: false };
  }
  return view;
}

export function leaveQueue(entryID) {
  return store.mutate((state) => {
    const entry = state.queue.find((q) => q.id === entryID);
    if (!entry) throw notFound('Entrada na fila não encontrada.');
    if (entry.status === 'consumed') throw bad('Esta entrada já virou sessão.');
    entry.status = 'left';
    entry.leftAt = now();
    pushEvent(state, 'queue.left', { entryID: entry.id });
    return { ok: true };
  });
}

/**
 * Garante que quem está comprando é quem tem direito ao slot.
 * Lança 409 explicando o motivo — a UI usa isso para mostrar a fila.
 */
export function assertSlotAvailableFor(queueID = null) {
  const t = now();
  const slot = slotStatus(t);
  if (slot.status === 'busy') {
    throw conflict(
      'O Xbox está em uso agora.',
      'slot_busy',
      { until: slot.until },
    );
  }
  if (slot.status === 'reserved') {
    throw conflict(
      'Outra pessoa está finalizando o pagamento. Tente em alguns minutos.',
      'slot_reserved',
      { until: slot.until },
    );
  }
  if (slot.status === 'held' && slot.queueID !== queueID) {
    throw conflict(
      'A vez é de quem está na fila.',
      'slot_held',
      { until: slot.until },
    );
  }
  return slot;
}

export function queueSnapshot(t = now()) {
  const state = store.data;
  return {
    waiting: state.queue.filter((q) => q.status === 'waiting').length,
    notified: state.queue.find((q) => q.status === 'notified' && q.holdUntil > t)?.id ?? null,
    blocked: Boolean(activeSession(state) || pendingOrderForSlot(state, t)),
  };
}
