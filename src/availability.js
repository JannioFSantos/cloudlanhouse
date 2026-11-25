import { config } from './config.js';
import { ApiError } from './errors.js';

/**
 * A máquina está pronta para receber um cliente?
 *
 * O `realtime.js` avisa quando o host (aba /host) e a ponte de controle
 * entram ou saem. Quem vende (rotas HTTP) e quem mostra o estado (site)
 * consultam aqui, sem conhecer WebSocket.
 */
const online = { host: false, bridge: false };

export function setOnline(role, value) {
  if (role === 'host' || role === 'bridge') online[role] = Boolean(value);
}

/** @returns {{hostOnline:boolean, bridgeOnline:boolean, ready:boolean, reason:string|null}} */
export function availability() {
  let reason = null;
  if (config.requireOnline) {
    if (!online.host) reason = 'host_offline';
    else if (config.requireBridge && !online.bridge) reason = 'bridge_offline';
  }
  return {
    hostOnline: online.host,
    bridgeOnline: online.bridge,
    ready: reason === null,
    reason,
  };
}

const MESSAGES = {
  host_offline: 'O computador do jogo está offline no momento. Tente novamente em alguns minutos.',
  bridge_offline: 'O controle remoto da máquina está offline no momento. Tente novamente em alguns minutos.',
};

/** Recusa a venda quando a máquina não está pronta. */
export function assertOnline() {
  const { ready, reason } = availability();
  if (!ready) throw new ApiError(503, 'machine_offline', MESSAGES[reason], { reason });
}
