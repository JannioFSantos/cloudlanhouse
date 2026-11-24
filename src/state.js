import path from 'node:path';
import { config } from './config.js';
import { createStore } from './store.js';
import { bus } from './bus.js';

const MAX_EVENTS = 300;

function initialState() {
  return {
    version: 1,
    createdAt: Date.now(),
    session: null,
    orders: [],
    queue: [],
    events: [],
    counters: { sessionsTotal: 0, hoursSold: 0, revenueCents: 0 },
  };
}

export const store = createStore(path.join(config.dataDir, 'state.json'), initialState);

/**
 * Adiciona um evento auditável ao estado já mutado (sem persistir).
 * Use dentro de `store.mutate`, para não aninhar mutações.
 */
export function pushEvent(state, type, detail = {}, level = 'info') {
  const entry = { at: Date.now(), type, level, detail };
  state.events.unshift(entry);
  if (state.events.length > MAX_EVENTS) state.events.length = MAX_EVENTS;
  bus.emit('event', entry);
  if (config.debug) console.log('[event]', type, JSON.stringify(detail));
  return entry;
}

/** Atalho para registrar um evento fora de uma mutação existente. */
export function addEvent(type, detail = {}, level = 'info') {
  return store.mutate((state) => pushEvent(state, type, detail, level));
}
