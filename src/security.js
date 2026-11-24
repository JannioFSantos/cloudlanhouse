import { config } from './config.js';
import { forbidden } from './errors.js';
import { hmac, safeEqual } from './util.js';

export const ADMIN_COOKIE = 'xp_admin';
const ADMIN_TTL_MS = 12 * 3600_000;

export function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

export function issueAdminCookie() {
  const exp = Date.now() + ADMIN_TTL_MS;
  const payload = String(exp);
  const sig = hmac(config.cookieSecret, payload);
  return {
    value: `${payload}.${sig}`,
    maxAgeSec: Math.floor(ADMIN_TTL_MS / 1000),
  };
}

export function verifyAdminCookie(raw) {
  if (!raw) return false;
  const [payload, sig] = String(raw).split('.');
  if (!payload || !sig) return false;
  if (!safeEqual(sig, hmac(config.cookieSecret, payload))) return false;
  const exp = Number(payload);
  return Number.isFinite(exp) && exp > Date.now();
}

export function isAdminRequest(req) {
  const cookies = parseCookies(req.headers?.cookie);
  return verifyAdminCookie(cookies[ADMIN_COOKIE]);
}

export function requireAdmin(req) {
  if (!isAdminRequest(req)) throw forbidden('Faça login no painel.');
}

export function checkPassword(password) {
  return safeEqual(password ?? '', config.adminPassword);
}

/* ------------------------------------------------------------------ */
/* Rate limit em memória (single process, volume baixo)               */
/* ------------------------------------------------------------------ */

const buckets = new Map();

export function rateLimit(key, limit, windowMs) {
  const t = Date.now();
  let bucket = buckets.get(key);

  if (!bucket || bucket.resetAt <= t) {
    bucket = { count: 0, resetAt: t + windowMs };
    buckets.set(key, bucket);
  }
  bucket.count += 1;

  if (buckets.size > 5000) {
    for (const [k, b] of buckets) if (b.resetAt <= t) buckets.delete(k);
  }

  if (bucket.count > limit) {
    return { ok: false, retryAfterSec: Math.ceil((bucket.resetAt - t) / 1000) };
  }
  return { ok: true };
}

export function resetRateLimit(key) {
  buckets.delete(key);
}
