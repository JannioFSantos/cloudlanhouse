import crypto from 'node:crypto';
import { config } from './config.js';
import { ApiError } from './errors.js';
import { log } from './util.js';
import { safeEqual } from './util.js';
const MP_API = 'https://api.mercadopago.com';

function assertConfigured() {
  if (!config.mpAccessToken) {
    throw new ApiError(503, 'payment_not_configured', 'Mercado Pago não configurado.');
  }
}

async function mpFetch(path, options = {}) {
  assertConfigured();
  const res = await fetch(`${MP_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${config.mpAccessToken}`,
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
  });

  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }

  if (!res.ok) {
    log('[mercadopago] erro', res.status, JSON.stringify(body).slice(0, 500));
    throw new ApiError(
      502,
      'payment_provider_error',
      'Não foi possível falar com o Mercado Pago. Tente novamente.',
      { providerStatus: res.status, providerMessage: body?.message },
    );
  }
  return body;
}

/** Data de expiração no formato que o MP aceita (offset de Brasília). */
function mpDate(ms) {
  const d = new Date(ms - 3 * 3600_000);
  return `${d.toISOString().slice(0, 19)}.000-03:00`;
}

/**
 * Cria uma cobrança Pix e devolve o "copia e cola" + QR em base64.
 */
export async function createPixCharge(order) {
  if (config.paymentMode === 'mock') {
    return {
      provider: 'mock',
      mpPaymentId: `mock_${order.id}`,
      qrCode: `00020126580014BR.GOV.BCB.PIX0136${order.id}5204000053039865406${(order.amountCents / 100).toFixed(2)}5802BR5925XBOX PLAY ALUGUEL6009SAO PAULO62070503***6304MOCK`,
      qrCodeBase64: null,
      ticketUrl: null,
    };
  }

  const body = {
    transaction_amount: Number((order.amountCents / 100).toFixed(2)),
    description: `Xbox Play — ${order.hours}h (pedido ${order.id})`,
    payment_method_id: 'pix',
    external_reference: order.id,
    notification_url: config.mpNotificationUrl || `${config.baseUrl}/api/webhooks/mercadopago`,
    date_of_expiration: mpDate(order.expiresAt),
    payer: {
      email: order.email || 'cliente@xboxplay.local',
      first_name: order.name.split(' ')[0],
    },
    metadata: {
      kind: order.kind,
      hours: order.hours,
      session_id: order.sessionID ?? null,
    },
  };

  const payment = await mpFetch('/v1/payments', {
    method: 'POST',
    headers: { 'X-Idempotency-Key': order.id },
    body: JSON.stringify(body),
  });

  const tx = payment?.point_of_interaction?.transaction_data ?? {};

  return {
    provider: 'mercadopago',
    mpPaymentId: String(payment.id),
    qrCode: tx.qr_code ?? null,
    qrCodeBase64: tx.qr_code_base64 ?? null,
    ticketUrl: tx.ticket_url ?? null,
    status: payment.status,
  };
}

export async function getPayment(paymentID) {
  return mpFetch(`/v1/payments/${encodeURIComponent(paymentID)}`, { method: 'GET' });
}

export async function refundPayment(paymentID, amountCents) {
  if (config.paymentMode === 'mock') return { ok: true, mock: true };
  return mpFetch(`/v1/payments/${encodeURIComponent(paymentID)}/refunds`, {
    method: 'POST',
    body: JSON.stringify(
      amountCents ? { amount: Number((amountCents / 100).toFixed(2)) } : {},
    ),
  });
}

/**
 * Valida o header x-signature do Mercado Pago.
 * manifest = "id:<data.id>;request-id:<x-request-id>;ts:<ts>;"
 */
export function verifyWebhookSignature({ headers, query, body }) {
  if (!config.mpWebhookSecret) {
    return { ok: true, skipped: true };
  }

  const signature = String(headers['x-signature'] ?? '');
  const requestId = String(headers['x-request-id'] ?? '');
  const parts = Object.fromEntries(
    signature.split(',').map((p) => {
      const [k, v] = p.split('=');
      return [k?.trim(), v?.trim()];
    }),
  );
  const ts = parts.ts;
  const v1 = parts.v1;
  const dataId = query?.['data.id'] ?? body?.data?.id;

  if (!ts || !v1 || !dataId) {
    return { ok: false, reason: 'assinatura_incompleta' };
  }

  const manifest = `id:${dataId};request-id:${requestId};ts:${ts};`;
  const expected = crypto
    .createHmac('sha256', config.mpWebhookSecret)
    .update(manifest)
    .digest('hex');

  const tsNumber = Number(ts);
  if (Number.isFinite(tsNumber)) {
    const ageSec = Math.abs(Date.now() / 1000 - tsNumber);
    if (ageSec > 600) return { ok: false, reason: 'assinatura_expirada' };
  }

  const ok = safeEqual(expected.toLowerCase(), String(v1).toLowerCase());
  return ok ? { ok: true } : { ok: false, reason: 'assinatura_invalida' };
}

export function paymentModeLabel() {
  return config.paymentMode === 'mock' ? 'teste' : 'mercadopago';
}
