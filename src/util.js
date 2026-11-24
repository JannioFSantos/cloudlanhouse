import crypto from 'node:crypto';

export const now = () => Date.now();

export function id(prefix = '') {
  return prefix + crypto.randomBytes(9).toString('base64url');
}

export function token() {
  return crypto.randomBytes(32).toString('base64url');
}

export function safeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export function hmac(secret, value) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

/** R$ 7,00 a partir de centavos. */
export function brl(cents) {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

/** Normaliza telefone para dígitos (usado só como contato, não como login). */
export function phoneDigits(input) {
  return String(input ?? '').replace(/\D+/g, '').slice(0, 13);
}

export function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

export function shortToken(t, size = 6) {
  return t ? t.slice(0, size) + '…' : '';
}

export function fmtClock(ms) {
  if (ms <= 0) return '00:00';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
