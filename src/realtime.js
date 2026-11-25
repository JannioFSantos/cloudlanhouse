import { createWebSocketServer } from './ws.js';
import { config } from './config.js';
import { store } from './state.js';
import { bus } from './bus.js';
import { now, safeEqual } from './util.js';
import { setOnline } from './availability.js';
import {
  ACTIVE_STATUSES,
  markStreamReady,
  publicSession,
  publicStatus,
  sessionView,
} from './sessions.js';
import { isAdminRequest } from './security.js';

/**
 * Protocolo (JSON, um por mensagem):
 *
 *  cliente → servidor
 *    {type:'hello', role:'viewer', token}
 *    {type:'hello', role:'host', key}
 *    {type:'hello', role:'bridge', key}
 *    {type:'hello', role:'admin'}                  (cookie do painel)
 *    {type:'offer', payload}       viewer → host
 *    {type:'answer', payload}      host → viewer
 *    {type:'candidate', payload}   ambos
 *    {type:'stream:ready'}         host
 *    {type:'stream:stats', payload} host → admin
 *    {type:'input', payload}       viewer → bridge
 *
 *  servidor → cliente
 *    {type:'hello'|'state'|'session:started'|'session:warning'|'session:ended'
 *     |'offer'|'answer'|'candidate'|'input'|'viewer:joined'|'viewer:left'
 *     |'error'|'pong'}
 */

const PUBLIC_STATE_INTERVAL_MS = 400;

export function attachRealtime(server) {
  const wss = createWebSocketServer({ server, path: '/ws', maxPayload: 256 * 1024 });

  const presence = { host: null, bridge: null, viewer: null, admins: new Set() };
  let lastPublicBroadcast = 0;
  let pendingBroadcast = null;

  function send(ws, message) {
    if (ws && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  function closeSocket(ws, code, reason) {
    if (!ws) return;
    try {
      ws.close(code, reason);
    } catch {
      /* ignore */
    }
  }

  function fail(ws, code, message, extra = {}) {
    send(ws, { type: 'error', code, message, ...extra });
    closeSocket(ws, 4003, code);
  }

  function hostSessionInfo() {
    const s = store.data.session;
    if (!s || !ACTIVE_STATUSES.includes(s.status)) return null;
    return {
      id: s.id,
      status: s.status,
      startedAt: s.startedAt,
      endsAt: s.endsAt,
      remainingMs: s.endsAt ? Math.max(0, s.endsAt - now()) : null,
      hoursPurchased: s.hoursPurchased,
      streamReady: Boolean(s.streamReady),
      customerFirstName: s.customer.name.split(' ')[0],
    };
  }

  function publicState() {
    return publicStatus();
  }

  function broadcastState(force = false) {
    const t = now();
    if (!force && t - lastPublicBroadcast < PUBLIC_STATE_INTERVAL_MS) {
      if (!pendingBroadcast) {
        pendingBroadcast = setTimeout(() => {
          pendingBroadcast = null;
          broadcastState(true);
        }, PUBLIC_STATE_INTERVAL_MS);
      }
      return;
    }
    lastPublicBroadcast = t;

    const state = publicState();
    const payload = { type: 'state', state };

    if (presence.host) send(presence.host, { type: 'host:state', state, session: hostSessionInfo() });
    if (presence.viewer) send(presence.viewer, payload);
    if (presence.bridge) send(presence.bridge, payload);
    for (const admin of presence.admins) send(admin, payload);
  }

  function broadcastToAdmins(message) {
    for (const admin of presence.admins) send(admin, message);
  }

  function relayToViewer(message) {
    if (presence.viewer) send(presence.viewer, message);
  }

  function relayToHost(message) {
    if (presence.host) send(presence.host, message);
  }

  /* ----------------------------- conexão ----------------------------- */

  wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.meta = { role: null, sessionID: null, since: now() };
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    send(ws, {
      type: 'welcome',
      serverNow: now(),
      iceServers: config.iceServers,
      paymentMode: config.paymentMode,
    });

    const helloTimer = setTimeout(() => {
      if (!ws.meta.role) fail(ws, 'hello_timeout', 'Handshake não recebido.');
    }, 10_000);

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      try {
        handle(ws, msg);
      } catch (err) {
        console.error('[ws] erro ao processar mensagem', err);
        send(ws, { type: 'error', code: 'internal', message: 'Erro interno.' });
      }
    });

    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (presence.host === ws) {
        presence.host = null;
        setOnline('host', false);
        relayToViewer({ type: 'host:offline' });
        broadcastToAdmins({ type: 'presence', presence: presenceSnapshot() });
        broadcastState(true);
      }
      if (presence.bridge === ws) {
        presence.bridge = null;
        setOnline('bridge', false);
        broadcastToAdmins({ type: 'presence', presence: presenceSnapshot() });
        broadcastState(true);
      }
      if (presence.viewer === ws) {
        presence.viewer = null;
        store.mutate((state) => {
          if (state.session) {
            state.session.viewer.connected = false;
            state.session.viewer.lastSeenAt = now();
          }
        });
        relayToHost({ type: 'viewer:left' });
        broadcastToAdmins({ type: 'presence', presence: presenceSnapshot() });
      }
      presence.admins.delete(ws);
    });

    function handle(client, msg) {
      if (msg.type === 'hello') {
        clearTimeout(helloTimer);
        return onHello(client, msg);
      }

      const role = client.meta.role;
      if (!role) return fail(client, 'not_authenticated', 'Envie hello primeiro.');

      switch (msg.type) {
        case 'ping':
          return send(client, { type: 'pong', serverNow: now() });

        // Quem tem a mídia (host) cria a oferta; o player só responde.
        case 'offer':
          if (role !== 'host') return;
          return relayToViewer({ type: 'offer', payload: msg.payload });

        case 'answer':
          if (role !== 'viewer') return;
          return relayToHost({ type: 'answer', payload: msg.payload });

        case 'request-offer':
          if (role !== 'viewer') return;
          return relayToHost({ type: 'request-offer' });

        case 'candidate':
          if (role === 'viewer') return relayToHost({ type: 'candidate', payload: msg.payload });
          if (role === 'host') return relayToViewer({ type: 'candidate', payload: msg.payload });
          return;

        case 'input':
          if (role !== 'viewer') return;
          if (presence.bridge) send(presence.bridge, { type: 'input', payload: msg.payload });
          return;

        case 'stream:ready': {
          if (role !== 'host') return;
          const session = store.data.session;
          if (!session) return;
          const updated = markStreamReady(session.id);
          if (updated) {
            relayToViewer({
              type: 'stream:ready',
              session: { ...publicSession(updated), id: updated.id },
            });
            broadcastToAdmins({ type: 'host:stream_ready', sessionID: updated.id });
            broadcastState(true);
          }
          return;
        }

        case 'stream:stats':
          if (role !== 'host') return;
          return broadcastToAdmins({ type: 'stream:stats', payload: msg.payload });

        case 'input:ack':
          if (role !== 'bridge') return;
          return relayToHost({ type: 'input:ack', payload: msg.payload });

        default:
          return send(client, { type: 'error', code: 'unknown_message', message: msg.type });
      }
    }

    function onHello(client, msg) {
      if (client.meta.role) return fail(client, 'already_hello', 'Hello duplicado.');

      switch (msg.role) {
        case 'viewer': {
          const session = store.data.session;
          if (!session || !msg.token || !safeEqual(session.token, msg.token)) {
            return fail(client, 'invalid_token', 'Link de sessão inválido ou expirado.');
          }
          if (!ACTIVE_STATUSES.includes(session.status)) {
            return fail(client, 'session_ended', 'Esta sessão já terminou.', {
              status: session.status,
            });
          }

          if (presence.viewer && presence.viewer !== client) {
            closeSocket(presence.viewer, 4001, 'outra_aba');
          }

          client.meta.role = 'viewer';
          client.meta.sessionID = session.id;
          presence.viewer = client;

          store.mutate((state) => {
            if (!state.session) return;
            state.session.viewer.connected = true;
            state.session.viewer.lastSeenAt = now();
            state.session.viewer.connections = (state.session.viewer.connections ?? 0) + 1;
          });

          send(client, {
            type: 'hello',
            ok: true,
            role: 'viewer',
            iceServers: config.iceServers,
            state: publicState(),
            session: sessionView(msg.token),
            hostOnline: Boolean(presence.host),
          });
          relayToHost({ type: 'viewer:joined', at: now() });
          broadcastToAdmins({ type: 'presence', presence: presenceSnapshot() });
          return;
        }

        case 'host': {
          if (!safeEqual(msg.key ?? '', config.hostKey)) {
            return fail(client, 'invalid_host_key', 'Chave do host inválida.');
          }
          if (presence.host && presence.host !== client) {
            closeSocket(presence.host, 4001, 'outro_host');
          }
          client.meta.role = 'host';
          presence.host = client;
          setOnline('host', true);

          send(client, {
            type: 'hello',
            ok: true,
            role: 'host',
            iceServers: config.iceServers,
            state: publicState(),
            session: hostSessionInfo(),
          });
          if (presence.viewer) {
            send(presence.viewer, { type: 'host:online' });
            send(client, { type: 'viewer:joined', at: now() });
          }
          broadcastToAdmins({ type: 'presence', presence: presenceSnapshot() });
          broadcastState(true);
          return;
        }

        case 'bridge': {
          if (!safeEqual(msg.key ?? '', config.hostKey)) {
            return fail(client, 'invalid_host_key', 'Chave do host inválida.');
          }
          client.meta.role = 'bridge';
          presence.bridge = client;
          setOnline('bridge', true);
          send(client, { type: 'hello', ok: true, role: 'bridge', state: publicState() });
          broadcastToAdmins({ type: 'presence', presence: presenceSnapshot() });
          broadcastState(true);
          return;
        }

        case 'admin': {
          if (!isAdminRequest(client.meta.req ?? {})) {
            return fail(client, 'not_admin', 'Faça login no painel.');
          }
          client.meta.role = 'admin';
          presence.admins.add(client);
          send(client, { type: 'hello', ok: true, role: 'admin', state: publicState() });
          broadcastToAdmins({ type: 'presence', presence: presenceSnapshot() });
          return;
        }

        default:
          return fail(client, 'invalid_role', 'Papel desconhecido.');
      }
    }

    ws.meta.req = req;
  });

  function presenceSnapshot() {
    return {
      host: Boolean(presence.host),
      viewer: Boolean(presence.viewer),
      bridge: Boolean(presence.bridge),
      admins: presence.admins.size,
    };
  }

  /* --------------------------- heartbeat ----------------------------- */

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        /* ignore */
      }
    }
  }, 30_000);

  wss.on('close', () => clearInterval(heartbeat));

  /* --------------------------- eventos de domínio --------------------- */

  bus.on('state:changed', () => broadcastState());

  bus.on('session:created', ({ session }) => {
    relayToHost({ type: 'session:created', session: hostSessionInfo() });
    relayToViewer({ type: 'session:created', session: { ...publicSession(session) } });
    broadcastToAdmins({ type: 'session:created', sessionID: session.id });
    broadcastState(true);
  });

  bus.on('session:started', ({ session }) => {
    const info = hostSessionInfo();
    relayToHost({ type: 'session:started', session: info });
    relayToViewer({ type: 'session:started', session: publicSession(session) });
    broadcastState(true);
  });

  bus.on('session:extended', ({ session }) => {
    relayToViewer({ type: 'session:extended', session: publicSession(session) });
    relayToHost({ type: 'session:extended', session: hostSessionInfo() });
    broadcastState(true);
  });

  bus.on('session:warning', ({ minutes, remainingMs: left }) => {
    relayToViewer({ type: 'session:warning', minutes, remainingMs: left });
    relayToHost({ type: 'session:warning', minutes, remainingMs: left });
    broadcastToAdmins({ type: 'session:warning', minutes, remainingMs: left });
  });

  bus.on('session:ended', ({ session, reason }) => {
    const payload = { type: 'session:ended', reason, sessionID: session?.id ?? null };
    if (presence.viewer) {
      send(presence.viewer, payload);
      const viewer = presence.viewer;
      presence.viewer = null;
      setTimeout(() => closeSocket(viewer, 4003, 'session_ended'), 1500);
    }
    relayToHost(payload);
    if (presence.bridge) send(presence.bridge, payload);
    broadcastToAdmins(payload);
    store.mutate((state) => {
      if (state.session?.viewer) state.session.viewer.connected = false;
    });
    broadcastState(true);
  });

  bus.on('order:paid', ({ order, session }) => {
    broadcastToAdmins({ type: 'order:paid', orderID: order.id, kind: order.kind, session: Boolean(session) });
    if (order.kind === 'new' && session) {
      relayToHost({ type: 'session:created', session: hostSessionInfo() });
    }
    broadcastState(true);
  });

  bus.on('event', (entry) => broadcastToAdmins({ type: 'event', entry }));

  bus.on('queue:notified', ({ entry }) => {
    broadcastToAdmins({ type: 'queue:notified', entryID: entry.id, name: entry.name });
    broadcastState(true);
  });

  return { presence: presenceSnapshot, wss };
}
