/* Helpers compartilhados pelas páginas. */

export async function api(path, { method = 'GET', body, headers } = {}) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(headers ?? {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    const err = new Error(data?.error?.message ?? `Erro ${res.status}`);
    err.status = res.status;
    err.code = data?.error?.code;
    err.detail = data?.error ?? {};
    throw err;
  }
  return data;
}

export const brl = (cents) =>
  (Number(cents ?? 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export function fmtClock(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '00:00';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function fmtTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

export function fmtDateTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function phoneMask(value) {
  const d = String(value ?? '').replace(/\D+/g, '').slice(0, 11);
  if (d.length <= 2) return d;
  if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
}

/* ----------------------------- relógio ----------------------------- */

let serverOffset = 0;

export function setServerNow(serverNowValue) {
  if (Number.isFinite(serverNowValue)) serverOffset = serverNowValue - Date.now();
}

export const serverNow = () => Date.now() + serverOffset;

export const remainingFrom = (endsAt) => Math.max(0, (endsAt ?? 0) - serverNow());

/* ----------------------------- toast ------------------------------- */

function toastHost() {
  let host = document.querySelector('.toasts');
  if (!host) {
    host = document.createElement('div');
    host.className = 'toasts';
    document.body.appendChild(host);
  }
  return host;
}

export function toast(message, type = 'info', ms = 4200) {
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  node.textContent = message;
  toastHost().appendChild(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transition = 'opacity .25s';
    setTimeout(() => node.remove(), 260);
  }, ms);
  return node;
}

/* ----------------------------- clipboard --------------------------- */

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      /* ignore */
    }
    area.remove();
    return ok;
  }
}

/* ----------------------------- websocket --------------------------- */

export const wsURL = () =>
  `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`;

/**
 * Conexão com hello automático e reconexão exponencial.
 * Os handlers recebem as mensagens cruas do protocolo.
 */
export function connectWS({ role, token, key, onMessage, onOpen, onClose, onStatus }) {
  let socket = null;
  let stopped = false;
  let attempt = 0;
  let retryTimer = null;

  const notify = (status) => onStatus?.(status);

  function open() {
    notify('connecting');
    socket = new WebSocket(wsURL());

    socket.onopen = () => {
      attempt = 0;
      socket.send(JSON.stringify({ type: 'hello', role, token, key }));
    };

    socket.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === 'welcome') {
        setServerNow(msg.serverNow);
        return;
      }
      if (msg.type === 'hello' && msg.ok) {
        notify('online');
        onOpen?.(msg);
        return;
      }
      if (msg.type === 'error') {
        notify('error');
        onMessage?.(msg);
        if (['invalid_token', 'invalid_host_key', 'not_admin', 'session_ended'].includes(msg.code)) {
          stopped = true;
          socket.close();
        }
        return;
      }
      onMessage?.(msg);
    };

    socket.onclose = (event) => {
      // 4001 = o servidor fechou esta conexão porque outra aba assumiu o papel
      // (mesmo link aberto em dois lugares). Reconectar criaria uma briga infinita.
      if (event.code === 4001) {
        stopped = true;
        notify('replaced');
        onClose?.(event);
        return;
      }
      notify('offline');
      onClose?.(event);
      if (stopped) return;
      const delay = Math.min(8000, 500 * 2 ** attempt);
      attempt += 1;
      retryTimer = setTimeout(open, delay);
    };

    socket.onerror = () => {};
  }

  open();

  return {
    send(message) {
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(message));
        return true;
      }
      return false;
    },
    close() {
      stopped = true;
      clearTimeout(retryTimer);
      try {
        socket?.close();
      } catch {
        /* ignore */
      }
    },
    get ready() {
      return socket?.readyState === WebSocket.OPEN;
    },
  };
}

/* ----------------------------- janela de atenção -------------------- */

export function keepAwake() {
  let lock = null;
  const request = async () => {
    try {
      if ('wakeLock' in navigator && !lock) {
        lock = await navigator.wakeLock.request('screen');
        lock.addEventListener('release', () => {
          lock = null;
        });
      }
    } catch {
      /* ignore */
    }
  };
  request();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') request();
  });
}

/* ----------------------------- utilidades --------------------------- */

export function el(id) {
  return document.getElementById(id);
}

export function show(id, visible) {
  const node = el(id);
  if (node) node.classList.toggle('hidden', !visible);
}

export function setText(id, value) {
  const node = el(id);
  if (node) node.textContent = value;
}

export function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}
