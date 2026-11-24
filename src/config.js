import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const root = path.resolve(import.meta.dirname, '..');

function env(name, fallback = '') {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function num(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

const dataDir = path.resolve(root, env('DATA_DIR', './data'));
fs.mkdirSync(dataDir, { recursive: true });

/** Segredo persistente: sobrevive a restart, não fica no repositório. */
function persistedSecret(file, bytes = 32) {
  const full = path.join(dataDir, file);
  if (fs.existsSync(full)) return fs.readFileSync(full, 'utf8').trim();
  const secret = crypto.randomBytes(bytes).toString('base64url');
  fs.writeFileSync(full, secret, { mode: 0o600 });
  return secret;
}

export const config = {
  root,
  dataDir,
  publicDir: path.join(root, 'public'),
  port: num('PORT', 8080),
  baseUrl: env('BASE_URL', `http://localhost:${num('PORT', 8080)}`).replace(/\/$/, ''),

  hostKey: env('HOST_KEY') || persistedSecret('host-key.txt'),
  adminPassword: env('ADMIN_PASSWORD') || persistedSecret('admin-password.txt'),
  cookieSecret: persistedSecret('cookie-secret.txt'),

  paymentMode: (env('PAYMENT_MODE', 'mock') === 'mercadopago' && env('MP_ACCESS_TOKEN'))
    ? 'mercadopago'
    : 'mock',
  mpAccessToken: env('MP_ACCESS_TOKEN'),
  mpWebhookSecret: env('MP_WEBHOOK_SECRET'),
  mpNotificationUrl: env('MP_NOTIFICATION_URL'),

  // Regras de negócio
  maxHours: num('MAX_HOURS', 4),
  paymentTtlSec: num('PAYMENT_TTL_SEC', 900),
  provisionTimeoutSec: num('PROVISION_TIMEOUT_SEC', 180),
  queueHoldSec: num('QUEUE_HOLD_SEC', 300),

  xboxPowerOnCmd: env('XBOX_POWER_ON_CMD'),
  xboxPowerOffCmd: env('XBOX_POWER_OFF_CMD'),

  iceServers: [
    { urls: env('STUN_URL', 'stun:stun.l.google.com:19302') },
    ...(env('TURN_URL')
      ? [{
          urls: env('TURN_URL'),
          username: env('TURN_USERNAME'),
          credential: env('TURN_CREDENTIAL'),
        }]
      : []),
  ],

  trustProxy: env('TRUST_PROXY', '0') === '1',
  debug: env('DEBUG', '0') === '1',
};
