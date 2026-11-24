import http from 'node:http';
import { exec } from 'node:child_process';
import path from 'node:path';

import { config } from './config.js';
import { createApp, jsonBody, staticFiles } from './web.js';
import { store, pushEvent } from './state.js';
import { bus } from './bus.js';
import { ApiError, bad, conflict, notFound } from './errors.js';
import { brl, log, now, safeEqual } from './util.js';
import { HOURLY_CENTS, MAX_HOURS, quote, nextHourPrice } from './pricing.js';
import {
  endSession,
  publicSession,
  publicStatus,
  remainingMs,
  sessionView,
  slotStatus,
  tick,
} from './sessions.js';
import { getQueueEntry, joinQueue, leaveQueue } from './queue.js';
import {
  adminOrders,
  cancelOrder,
  createExtensionOrder,
  createInitialOrder,
  findOrder,
  markOrderPaid,
  publicOrderView,
  refreshOrder,
} from './orders.js';
import { getPayment, refundPayment, verifyWebhookSignature } from './payments.js';
import {
  ADMIN_COOKIE,
  checkPassword,
  isAdminRequest,
  issueAdminCookie,
  parseCookies,
  rateLimit,
  requireAdmin,
  resetRateLimit,
} from './security.js';
import { attachRealtime } from './realtime.js';

const app = createApp({ trustProxy: config.trustProxy });

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; "
    + "script-src 'self'; style-src 'self' 'unsafe-inline'; "
    + "connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'none'",
  );
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});

app.use(jsonBody({ limit: 64 * 1024 }));

const clientIP = (req) => req.ip || req.socket.remoteAddress || 'desconhecido';

function limit(req, key, max, windowMs) {
  const result = rateLimit(`${key}:${clientIP(req)}`, max, windowMs);
  if (!result.ok) {
    throw new ApiError(429, 'rate_limited', 'Muitas tentativas. Aguarde um pouco.', {
      retryAfterSec: result.retryAfterSec,
    });
  }
}

const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* ------------------------------------------------------------------ */
/* Público                                                            */
/* ------------------------------------------------------------------ */

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, at: now(), paymentMode: config.paymentMode });
});

app.get('/api/config', (_req, res) => {
  res.json({
    pricing: { hourlyCents: HOURLY_CENTS, maxHours: MAX_HOURS },
    paymentMode: config.paymentMode,
    iceServers: config.iceServers,
    rules: {
      paymentTtlSec: config.paymentTtlSec,
      queueHoldSec: config.queueHoldSec,
      provisionTimeoutSec: config.provisionTimeoutSec,
    },
  });
});

app.get('/api/status', (_req, res) => {
  res.json(publicStatus());
});

app.post('/api/queue', (req, res) => {
  limit(req, 'queue:join', 20, 10 * 60_000);
  const { name, phone } = req.body ?? {};
  res.status(201).json(joinQueue({ name, phone }));
});

app.get('/api/queue/:id', (req, res) => {
  limit(req, 'queue:get', 120, 60_000);
  res.json(getQueueEntry(req.params.id));
});

app.delete('/api/queue/:id', (req, res) => {
  res.json(leaveQueue(req.params.id));
});

app.post('/api/orders', asyncH(async (req, res) => {
  limit(req, 'order:create', 12, 10 * 60_000);
  const { hours, name, phone, email, queueID } = req.body ?? {};
  const order = await createInitialOrder({ hours, name, phone, email, queueID });
  res.status(201).json(publicOrderView(order));
}));

app.get('/api/orders/:id', asyncH(async (req, res) => {
  limit(req, 'order:get', 180, 60_000);
  const order = await refreshOrder(req.params.id);
  if (!order) throw notFound('Pedido não encontrado.');
  res.json(publicOrderView(order));
}));

app.post('/api/orders/:id/cancel', (req, res) => {
  const order = cancelOrder(req.params.id);
  res.json(publicOrderView(order));
});

app.post('/api/orders/:id/mock-pay', asyncH(async (req, res) => {
  if (config.paymentMode !== 'mock') {
    throw new ApiError(403, 'mock_disabled', 'Pagamento simulado desativado.');
  }
  limit(req, 'order:mockpay', 30, 10 * 60_000);
  const order = findOrder(req.params.id);
  if (!order) throw notFound('Pedido não encontrado.');
  if (order.status === 'pending') {
    markOrderPaid(order.id, { paymentId: `mock_${order.id}`, source: 'mock' });
  }
  res.json(publicOrderView(findOrder(order.id)));
}));

/* ------------------------------------------------------------------ */
/* Sessão do jogador                                                  */
/* ------------------------------------------------------------------ */

function sessionByToken(tokenValue) {
  const session = store.data.session;
  if (!session || !tokenValue || !safeEqual(session.token, tokenValue)) {
    throw new ApiError(401, 'invalid_token', 'Link de sessão inválido ou expirado.');
  }
  return session;
}

app.get('/api/session', (req, res) => {
  limit(req, 'session:view', 240, 60_000);
  const tokenValue = String(req.query.s ?? '');
  res.json(sessionView(sessionByToken(tokenValue).token));
});

app.post('/api/session/extend', asyncH(async (req, res) => {
  limit(req, 'session:extend', 20, 10 * 60_000);
  const { token: tokenValue, hours } = req.body ?? {};
  sessionByToken(tokenValue);
  const order = await createExtensionOrder({ sessionToken: tokenValue, hours });
  res.status(201).json(publicOrderView(order));
}));

app.post('/api/session/forfeit', (req, res) => {
  limit(req, 'session:forfeit', 10, 10 * 60_000);
  const { token: tokenValue, confirm } = req.body ?? {};
  if (confirm !== true) throw bad('Confirmação obrigatória.', 'confirm_required');
  const session = sessionByToken(tokenValue);
  if (!['active', 'provisioning'].includes(session.status)) {
    throw conflict('Esta sessão já foi encerrada.', 'session_already_ended');
  }
  const ended = endSession('forfeited', { sessionID: session.id, by: 'player' });
  res.json({ ok: true, ended: Boolean(ended), status: ended?.status ?? session.status });
});

/* ------------------------------------------------------------------ */
/* Webhook Mercado Pago                                               */
/* ------------------------------------------------------------------ */

app.post('/api/webhooks/mercadopago', asyncH(async (req, res) => {
  const check = verifyWebhookSignature({
    headers: req.headers,
    query: req.query,
    body: req.body,
  });
  if (!check.ok) {
    store.mutate((state) => pushEvent(state, 'webhook.invalid', { reason: check.reason }, 'warn'));
    return res.status(401).json({ ok: false });
  }

  const type = req.body?.type ?? req.body?.topic;
  const paymentID = req.body?.data?.id ?? req.query?.['data.id'];

  // Responde rápido; o MP reenvia se demorar.
  res.status(200).json({ ok: true });

  if (type !== 'payment' || !paymentID) return;

  try {
    const payment = await getPayment(paymentID);
    const orderID = payment?.external_reference;
    if (!orderID) return;

    if (payment.status === 'approved') {
      markOrderPaid(orderID, { paymentId: payment.id, source: 'webhook' });
    } else {
      store.mutate((state) => {
        pushEvent(state, 'webhook.payment_status', {
          orderID,
          status: payment.status,
          paymentID: payment.id,
        });
      });
    }
  } catch (err) {
    log('[webhook] falha ao processar pagamento', paymentID, err.message);
  }
}));

/* ------------------------------------------------------------------ */
/* Admin                                                              */
/* ------------------------------------------------------------------ */

app.post('/api/admin/login', (req, res) => {
  const key = `admin:login:${clientIP(req)}`;
  const rl = rateLimit(key, 8, 10 * 60_000);
  if (!rl.ok) {
    throw new ApiError(429, 'rate_limited', 'Muitas tentativas. Aguarde.', {
      retryAfterSec: rl.retryAfterSec,
    });
  }
  if (!checkPassword(req.body?.password ?? '')) {
    throw new ApiError(401, 'invalid_password', 'Senha incorreta.');
  }
  resetRateLimit(key);
  const cookie = issueAdminCookie();
  res.cookie(ADMIN_COOKIE, cookie.value, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: cookie.maxAgeSec * 1000,
    path: '/',
    secure: config.baseUrl.startsWith('https://'),
  });
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  res.clearCookie(ADMIN_COOKIE, { path: '/' });
  res.json({ ok: true });
});

app.get('/api/admin/session', (req, res) => {
  res.json({ admin: isAdminRequest(req) });
});

app.get('/api/admin/overview', (req, res) => {
  requireAdmin(req);
  const state = store.data;
  const s = state.session;
  const presence = realtime.presence();

  res.json({
    serverNow: now(),
    paymentMode: config.paymentMode,
    baseUrl: config.baseUrl,
    presence,
    counters: state.counters,
    slot: slotStatus(),
    session: s
      ? {
          id: s.id,
          status: s.status,
          customer: s.customer,
          createdAt: s.createdAt,
          startedAt: s.startedAt,
          endsAt: s.endsAt,
          remainingMs: remainingMs(s),
          hoursPurchased: s.hoursPurchased,
          amountCentsTotal: s.amountCentsTotal,
          amountLabel: brl(s.amountCentsTotal),
          nextHourCents: nextHourPrice(s.hoursPurchased),
          streamReady: s.streamReady,
          viewerConnected: Boolean(s.viewer?.connected),
          endedReason: s.endedReason,
          playUrl: `${config.baseUrl}/play.html?s=${encodeURIComponent(s.token)}`,
        }
      : null,
    queue: state.queue
      .filter((q) => ['waiting', 'notified'].includes(q.status))
      .map((q, index) => ({
        id: q.id,
        name: q.name,
        phone: q.phone,
        status: q.status,
        position: index + 1,
        joinedAt: q.joinedAt,
        holdUntil: q.holdUntil,
      })),
    orders: adminOrders(25),
    events: state.events.slice(0, 40),
    config: {
      maxHours: MAX_HOURS,
      hourlyCents: HOURLY_CENTS,
      paymentTtlSec: config.paymentTtlSec,
      queueHoldSec: config.queueHoldSec,
      provisionTimeoutSec: config.provisionTimeoutSec,
      xboxPowerConfigured: Boolean(config.xboxPowerOnCmd || config.xboxPowerOffCmd),
    },
  });
});

app.get('/api/admin/host-key', (req, res) => {
  requireAdmin(req);
  res.json({ hostKey: config.hostKey });
});

app.post('/api/admin/action', asyncH(async (req, res) => {
  requireAdmin(req);
  const { action, ...payload } = req.body ?? {};
  const t = now();

  switch (action) {
    case 'end_session': {
      const ended = endSession(String(payload.reason ?? 'admin'), { by: 'admin' });
      return res.json({ ok: true, ended: Boolean(ended) });
    }

    case 'forfeit': {
      const ended = endSession('forfeited', { by: 'admin' });
      return res.json({ ok: true, ended: Boolean(ended) });
    }

    case 'extend': {
      const hours = Math.trunc(Number(payload.hours));
      const session = store.data.session;
      if (!session || session.status !== 'active') {
        throw conflict('Não há sessão ativa.', 'no_active_session');
      }
      if (t >= session.endsAt) throw conflict('O tempo já acabou.', 'time_up');
      const q = quote(session.hoursPurchased, hours);
      if (!q.ok) throw bad(q.message, q.code);

      store.mutate((state) => {
        state.session.hoursPurchased = q.totalHoursAfter;
        state.session.endsAt += hours * 3600_000;
        pushEvent(state, 'session.extended_manual', {
          sessionID: state.session.id,
          hours,
          by: 'admin',
        }, 'warn');
      });
      bus.emit('session:extended', { session: store.data.session });
      bus.emit('state:changed');
      return res.json({ ok: true, session: publicSession(store.data.session) });
    }

    case 'release_slot': {
      const released = store.mutate((state) => {
        let count = 0;
        for (const o of state.orders) {
          if (o.kind === 'new' && o.status === 'pending') {
            o.status = 'canceled';
            o.canceledAt = t;
            o.cancelReason = 'admin_release';
            count++;
          }
        }
        return count;
      });
      bus.emit('state:changed');
      return res.json({ ok: true, canceledOrders: released });
    }

    case 'remove_queue': {
      const entryID = String(payload.id ?? '');
      store.mutate((state) => {
        const entry = state.queue.find((q) => q.id === entryID);
        if (entry) {
          entry.status = 'removed';
          entry.removedAt = t;
          pushEvent(state, 'queue.removed', { entryID }, 'warn');
        }
      });
      bus.emit('state:changed');
      return res.json({ ok: true });
    }

    case 'clear_queue': {
      store.mutate((state) => {
        for (const q of state.queue) {
          if (['waiting', 'notified'].includes(q.status)) {
            q.status = 'removed';
            q.removedAt = t;
          }
        }
      });
      bus.emit('state:changed');
      return res.json({ ok: true });
    }

    case 'refund_order': {
      const order = findOrder(String(payload.orderID ?? ''));
      if (!order) throw notFound('Pedido não encontrado.');
      if (order.status !== 'paid') throw conflict('Pedido não está pago.', 'not_paid');

      await refundPayment(order.mpPaymentId, order.amountCents);

      store.mutate((state) => {
        const o = state.orders.find((x) => x.id === order.id);
        o.status = 'refunded';
        o.refundedAt = t;
        pushEvent(state, 'order.refunded', { orderID: o.id, amountCents: o.amountCents }, 'warn');
      });

      if (order.kind === 'new' && store.data.session?.id === order.sessionID) {
        endSession('refunded', { by: 'admin' });
      }
      bus.emit('state:changed');
      return res.json({ ok: true });
    }

    case 'reprocess_order': {
      const order = findOrder(String(payload.orderID ?? ''));
      if (!order) throw notFound('Pedido não encontrado.');
      if (order.status !== 'paid') throw conflict('Pedido não está pago.', 'not_paid');
      const { startSessionForOrder, extendSessionWithOrder } = await import('./sessions.js');
      const session = order.kind === 'new'
        ? startSessionForOrder(order)
        : extendSessionWithOrder(order);
      store.mutate(() => {
        order.needsAttention = false;
        order.attentionReason = null;
      });
      bus.emit('state:changed');
      return res.json({ ok: true, session: Boolean(session) });
    }

    case 'xbox_power': {
      const which = payload.mode === 'off' ? 'off' : 'on';
      const cmd = which === 'on' ? config.xboxPowerOnCmd : config.xboxPowerOffCmd;
      if (!cmd) throw bad('Comando de energia do Xbox não configurado.', 'xbox_power_not_configured');
      const output = await runCommand(cmd);
      store.mutate((state) => {
        pushEvent(state, 'xbox.power', { mode: which, ok: output.ok }, output.ok ? 'info' : 'error');
      });
      return res.json(output);
    }

    case 'reset_session_state': {
      // Último recurso: limpa a sessão travada sem apagar pedidos/histórico.
      endSession('admin_reset', { by: 'admin' });
      store.mutate((state) => {
        for (const o of state.orders) {
          if (o.status === 'pending') {
            o.status = 'canceled';
            o.canceledAt = t;
            o.cancelReason = 'admin_reset';
          }
        }
        for (const q of state.queue) {
          if (['waiting', 'notified'].includes(q.status)) {
            q.status = 'removed';
            q.removedAt = t;
          }
        }
        pushEvent(state, 'admin.reset', {}, 'warn');
      });
      bus.emit('state:changed');
      return res.json({ ok: true });
    }

    default:
      throw bad('Ação desconhecida.', 'unknown_action');
  }
}));

function runCommand(cmd) {
  return new Promise((resolve) => {
    exec(cmd, { timeout: 30_000, windowsHide: true }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        stdout: String(stdout ?? '').slice(0, 2000),
        stderr: String(stderr ?? '').slice(0, 2000),
        code: err?.code ?? 0,
      });
    });
  });
}

/* ------------------------------------------------------------------ */
/* Páginas                                                            */
/* ------------------------------------------------------------------ */

app.get('/', (_req, res) => res.sendFile(path.join(config.publicDir, 'index.html')));
app.get('/play', (_req, res) => res.sendFile(path.join(config.publicDir, 'play.html')));
app.get('/host', (_req, res) => res.sendFile(path.join(config.publicDir, 'host.html')));
app.get('/admin', (_req, res) => res.sendFile(path.join(config.publicDir, 'admin.html')));
app.use(staticFiles(config.publicDir));

app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    res.status(404).json({ error: { code: 'not_found', message: 'Rota não encontrada.' } });
    return;
  }
  res.status(404).send('Não encontrado.');
});

/* ------------------------------------------------------------------ */
/* Erros                                                              */
/* ------------------------------------------------------------------ */

app.use((err, req, res, _next) => {
  if (err instanceof ApiError) {
    return res.status(err.status).json({
      error: { code: err.code, message: err.message, ...err.extra },
    });
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'invalid_json', message: 'JSON inválido.' } });
  }
  console.error('[http]', err);
  res.status(500).json({ error: { code: 'internal', message: 'Erro interno.' } });
});

/* ------------------------------------------------------------------ */
/* Boot                                                               */
/* ------------------------------------------------------------------ */

const server = http.createServer(app);
const realtime = attachRealtime(server);

const scheduler = setInterval(() => {
  try {
    tick();
  } catch (err) {
    console.error('[tick]', err);
  }
}, 1000);
scheduler.unref?.();

server.listen(config.port, '0.0.0.0', () => {
  const generated = (name) => !process.env[name];
  log('──────────────────────────────────────────────');
  log(`xbox-play no ar em http://localhost:${config.port}`);
  log(`Página do cliente : ${config.baseUrl}/`);
  log(`Painel admin      : ${config.baseUrl}/admin`);
  log(`Host de captura   : ${config.baseUrl}/host`);
  log(`Pagamento         : ${config.paymentMode}`);
  if (generated('ADMIN_PASSWORD')) log(`Senha admin gerada: ${config.adminPassword}`);
  if (generated('HOST_KEY')) log(`Chave do host     : ${config.hostKey}`);
  log('──────────────────────────────────────────────');
});

function shutdown() {
  log('Encerrando...');
  clearInterval(scheduler);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
