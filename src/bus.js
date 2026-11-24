import { EventEmitter } from 'node:events';

/**
 * Barramento de eventos interno.
 *
 * `sessions.js` não conhece WebSocket: ele apenas emite fatos ("sessão
 * acabou", "estado mudou"). O `realtime.js` escuta e decide o que enviar
 * para host/viewer/admin. Isso evita import circular e deixa a regra de
 * negócio testável sem abrir socket.
 */
export const bus = new EventEmitter();
bus.setMaxListeners(50);
