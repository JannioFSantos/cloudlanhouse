/**
 * Converte o payload de gamepad enviado pelo player (Gamepad API do navegador,
 * layout "standard") para um estado neutro de controle Xbox 360 / XInput.
 *
 * Payload do player (public/assets/play.js):
 *   { id, axes: [lx, ly, rx, ry], buttons: [[pressed, value], ...] }
 *
 * Estado de saída:
 *   { buttons: ['A', 'DPAD_UP', ...], lt: 0..1, rt: 0..1, lx, ly, rx, ry }
 *   Eixos em -1..1 com Y positivo = para cima (convenção XInput).
 */

/** Índice do botão no layout standard do navegador → nome do botão XInput. */
export const BUTTON_BY_INDEX = {
  0: 'A',
  1: 'B',
  2: 'X',
  3: 'Y',
  4: 'LEFT_SHOULDER',
  5: 'RIGHT_SHOULDER',
  // 6 e 7 são os gatilhos analógicos (LT/RT), tratados à parte.
  8: 'BACK',
  9: 'START',
  10: 'LEFT_THUMB',
  11: 'RIGHT_THUMB',
  12: 'DPAD_UP',
  13: 'DPAD_DOWN',
  14: 'DPAD_LEFT',
  15: 'DPAD_RIGHT',
  16: 'GUIDE',
};

export const ALL_BUTTONS = Object.values(BUTTON_BY_INDEX);

export const DEADZONE = 0.05;
const MAX_BUTTONS = 32;

export function neutralState() {
  return { buttons: [], lt: 0, rt: 0, lx: 0, ly: 0, rx: 0, ry: 0 };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function axis(raw, invert = false) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  let v = clamp(n, -1, 1);
  if (Math.abs(v) < DEADZONE) v = 0;
  if (invert) v = -v;
  return Math.round(v * 1000) / 1000 || 0; // evita -0
}

function trigger(entry) {
  if (!Array.isArray(entry)) return 0;
  const pressed = Number(entry[0]) ? 1 : 0;
  const value = Number(entry[1]);
  const analog = Number.isFinite(value) ? clamp(value, 0, 1) : 0;
  // Alguns controles só informam "pressed"; garante que o gatilho funcione.
  const result = analog > 0 ? analog : pressed;
  return Math.round(result * 100) / 100;
}

/**
 * @param {unknown} payload mensagem `input` do player
 * @returns {object|null} estado XInput, ou null se o payload for inválido
 */
export function mapPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const { axes, buttons } = payload;
  if (!Array.isArray(axes) || !Array.isArray(buttons)) return null;

  const state = neutralState();

  state.lx = axis(axes[0]);
  state.ly = axis(axes[1], true); // navegador: cima = -1; XInput: cima = +1
  state.rx = axis(axes[2]);
  state.ry = axis(axes[3], true);

  const limit = Math.min(buttons.length, MAX_BUTTONS);
  for (let i = 0; i < limit; i++) {
    const entry = buttons[i];
    if (i === 6) {
      state.lt = trigger(entry);
    } else if (i === 7) {
      state.rt = trigger(entry);
    } else if (BUTTON_BY_INDEX[i] && Array.isArray(entry) && Number(entry[0])) {
      state.buttons.push(BUTTON_BY_INDEX[i]);
    }
  }

  return state;
}

export function isNeutral(state) {
  return (
    state.buttons.length === 0
    && state.lt === 0
    && state.rt === 0
    && state.lx === 0
    && state.ly === 0
    && state.rx === 0
    && state.ry === 0
  );
}

export function sameState(a, b) {
  if (!a || !b) return false;
  return (
    a.lt === b.lt
    && a.rt === b.rt
    && a.lx === b.lx
    && a.ly === b.ly
    && a.rx === b.rx
    && a.ry === b.ry
    && a.buttons.length === b.buttons.length
    && a.buttons.every((name) => b.buttons.includes(name))
  );
}
