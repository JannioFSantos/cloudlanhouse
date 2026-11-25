import {
  api,
  brl,
  fmtClock,
  esc,
  toast,
  copyText,
  remainingFrom,
  setServerNow,
  serverNow,
  connectWS,
  keepAwake,
  fmtTime,
} from './common.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const token = params.get('s') || localStorage.getItem('xp_play_token') || '';

let session = null;
let config = null;
let ws = null;
let pc = null;
let remoteStream = null;
let ended = false;
let hostOnline = false;
let iceServers = [];
let statsTimer = null;
let statsInterval = null;
let lastStats = null;
let warned = new Set();
let lastInputKey = '';
let lastInputAt = 0;
let uiHideTimer = null;
const touchAxes = [0, 0, 0, 0];
const touchPointers = new Map();
const stickPointers = new Map();
const touchButtons = new Set();

if (!token) {
  fatal('Link incompleto', 'Abra o link que você recebeu depois do pagamento para entrar na sessão.');
} else {
  localStorage.setItem('xp_play_token', token);
  boot();
}

/* ------------------------------------------------------------------ */
/* Boot                                                               */
/* ------------------------------------------------------------------ */

async function boot() {
  bindUI();
  keepAwake();

  try {
    const [sessionData, configData] = await Promise.all([
      api(`/api/session?s=${encodeURIComponent(token)}`),
      api('/api/config'),
    ]);
    config = configData;
    iceServers = configData.iceServers ?? [];
    applySession(sessionData);
  } catch (err) {
    if (err.code === 'invalid_token') {
      fatal('Sessão não encontrada', 'Este link expirou ou a sessão já foi encerrada. Se você tinha tempo restante, fale com o suporte.');
    } else {
      fatal('Falha ao carregar', err.message);
    }
    return;
  }

  connect();
  setInterval(tick, 500);
  setInterval(backupRefresh, 20_000);
  setupTouchControls();
  setupGamepad();
}

function connect() {
  ws = connectWS({
    role: 'viewer',
    token,
    onStatus(status) {
      const dot = $('statusDot');
      const text = $('statusText');
      if (status === 'online') {
        dot.className = 'dot live';
        text.textContent = 'conectado';
        $('stSocket').textContent = 'online';
      } else if (status === 'connecting') {
        dot.className = 'dot reserved';
        text.textContent = 'conectando';
        $('stSocket').textContent = 'conectando';
      } else if (status === 'replaced') {
        dot.className = 'dot off';
        text.textContent = 'aberta em outra aba';
        $('stSocket').textContent = 'offline';
        toast('Esta sessão foi aberta em outra aba. Use apenas uma por vez.', 'warn', 8000);
      } else {
        dot.className = 'dot off';
        text.textContent = 'reconectando';
        $('stSocket').textContent = 'offline';
      }
    },
    onOpen(msg) {
      if (typeof msg.hostOnline === 'boolean') hostOnline = msg.hostOnline;
      if (msg.state?.session) {
        applySession({ ...session, ...msg.state.session, serverNow: msg.state.serverNow });
      }
      if (msg.session) applySession({ ...session, ...msg.session });
      if (msg.iceServers?.length) iceServers = msg.iceServers;
      if (!ended) {
        if (hostOnline && session?.streamReady) showOverlay('connecting');
        else if (session?.status === 'provisioning') showOverlay('preparing');
        else showOverlay('waiting');
      }
    },
    onMessage: handleMessage,
  });
}

async function backupRefresh() {
  if (ended) return;
  try {
    const fresh = await api(`/api/session?s=${encodeURIComponent(token)}`);
    applySession(fresh);
  } catch {
    /* ignora */
  }
}

/* ------------------------------------------------------------------ */
/* Estado da sessão                                                   */
/* ------------------------------------------------------------------ */

function applySession(next) {
  if (!next) return;
  if (next.serverNow) setServerNow(next.serverNow);

  const previous = session;
  session = next;

  if (previous?.endsAt && next.endsAt && next.endsAt > previous.endsAt) {
    const gained = Math.round((next.endsAt - previous.endsAt) / 60000);
    toast(`+${gained} min adicionados. Novo fim: ${fmtTime(next.endsAt)}.`, 'green', 6000);
  }

  updateHud();

  if (['ended', 'forfeited'].includes(session.status)) {
    showEnded(session.endedReason || session.status);
    return;
  }

  if (session.status === 'provisioning') {
    showOverlay('preparing');
  } else if (!session.streamReady) {
    showOverlay('waiting');
  }
}

function updateHud() {
  if (!session) return;
  $('hoursText').textContent = `${session.hoursPurchased}h / ${session.maxHours ?? 4}`;
  $('btnExtend').disabled = !session.canExtend;
  $('btnExtend').textContent = session.canExtend
    ? `+ tempo · ${brl(session.nextHourCents)}`
    : 'máximo';
}

/* ------------------------------------------------------------------ */
/* Mensagens do servidor                                              */
/* ------------------------------------------------------------------ */

async function handleMessage(msg) {
  switch (msg.type) {
    case 'state': {
      const s = msg.state?.session;
      if (s) applySession({ ...session, ...s, serverNow: msg.state.serverNow });
      break;
    }

    case 'host:online':
      hostOnline = true;
      if (!session?.streamReady) showOverlay('waiting');
      else showOverlay('connecting');
      break;

    case 'host:offline':
      hostOnline = false;
      closePeer();
      if (!ended) showOverlay('waiting', 'A transmissão caiu. Reconectando…');
      break;

    case 'stream:ready':
      hostOnline = true;
      if (msg.session) applySession({ ...session, ...msg.session });
      session.streamReady = true;
      showOverlay('connecting');
      break;

    case 'offer':
      await handleOffer(msg.payload);
      break;

    case 'candidate':
      try {
        await pc?.addIceCandidate(msg.payload);
      } catch {
        /* candidato atrasado */
      }
      break;

    case 'session:started':
    case 'session:extended':
      if (msg.session) applySession({ ...session, ...msg.session, serverNow: msg.session.serverNow ?? serverNow() });
      break;

    case 'session:warning': {
      const key = String(msg.minutes);
      if (!warned.has(key)) {
        warned.add(key);
        toast(`Faltam ${msg.minutes} minuto(s) de jogo.`, msg.minutes <= 1 ? 'danger' : 'warn', 8000);
      }
      break;
    }

    case 'session:ended':
      showEnded(msg.reason || 'time_up');
      break;

    case 'error':
      if (msg.code === 'session_ended') showEnded('time_up');
      else if (msg.code === 'invalid_token') fatal('Sessão inválida', msg.message);
      else toast(msg.message || 'Erro de conexão.', 'danger');
      break;

    default:
      break;
  }
}

/* ------------------------------------------------------------------ */
/* WebRTC                                                             */
/* ------------------------------------------------------------------ */

async function handleOffer(offer) {
  if (ended) return;
  closePeer();

  try {
    pc = new RTCPeerConnection({ iceServers });

    pc.onicecandidate = (event) => {
      if (event.candidate) ws?.send({ type: 'candidate', payload: event.candidate });
    };

    pc.ontrack = (event) => {
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      remoteStream = stream;
      const video = $('video');
      if (video.srcObject !== stream) {
        video.srcObject = stream;
      }
      if (!session?.streamReady) session = { ...session, streamReady: true };
      tryPlay();
    };

    pc.onconnectionstatechange = () => {
      const st = pc?.connectionState;
      if (st === 'connected') {
        startStats();
        showOverlay('connecting');
      } else if (st === 'failed') {
        toast('Conexão de vídeo falhou. Tentando de novo…', 'danger');
        showOverlay('waiting', 'Reconectando o vídeo…');
        ws?.send({ type: 'request-offer' });
      } else if (st === 'disconnected') {
        showOverlay('waiting', 'Conexão instável…');
      }
    };

    await pc.setRemoteDescription(offer);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    ws?.send({ type: 'answer', payload: answer });
  } catch (err) {
    toast('Falha ao montar o vídeo. Recarregue a página.', 'danger');
    console.error(err);
  }
}

function closePeer() {
  stopStats();
  try {
    pc?.close();
  } catch {
    /* ignore */
  }
  pc = null;
}

function tryPlay() {
  const video = $('video');
  if (!video.srcObject) return;

  if (!video.muted) {
    video.play().catch(() => {
      video.muted = true;
      video.play().catch(() => {});
      $('btnSound').classList.remove('hidden');
    });
    return;
  }
  video.play().catch(() => {});
}

/* ------------------------------------------------------------------ */
/* Overlay / fim                                                      */
/* ------------------------------------------------------------------ */

function showOverlay(kind, detail = '') {
  if (ended) return;
  const overlay = $('overlay');
  const inner = $('overlayInner');
  overlay.classList.remove('hidden');

  if (kind === 'preparing') {
    inner.innerHTML = `
      <div class="spinner"></div>
      <h2 style="margin: 0 0 8px; font-size: 20px;">Preparando seu Xbox</h2>
      <p class="tiny muted mb-0">
        Ligando a transmissão. Isso costuma levar de 20 a 90 segundos.
        ${detail ? `<br/>${esc(detail)}` : ''}
      </p>
      <p class="tiny muted" style="margin-top: 10px;">
        O relógio começa a contar quando a tela aparecer.
      </p>`;
    return;
  }

  if (kind === 'waiting') {
    inner.innerHTML = `
      <div class="spinner"></div>
      <h2 style="margin: 0 0 8px; font-size: 20px;">Aguardando a transmissão</h2>
      <p class="tiny muted mb-0">${esc(detail || (hostOnline ? 'O host está subindo o vídeo.' : 'O computador do Xbox está offline. Já estamos tentando.') )}</p>
      ${session?.status === 'active'
        ? `<p class="tiny" style="margin-top: 12px; color: var(--warn);">O tempo já está correndo. Restam <strong data-ends="${session.endsAt}">—</strong>.</p>`
        : ''}`;
    return;
  }

  inner.innerHTML = `
    <div class="spinner"></div>
    <h2 style="margin: 0 0 8px; font-size: 20px;">Conectando o vídeo</h2>
    <p class="tiny muted mb-0">Negociando a transmissão com o host…</p>`;
}

function hideOverlay() {
  if (ended) return;
  $('overlay').classList.add('hidden');
}

function showEnded(reason) {
  if (ended) return;
  releaseTouchControls();
  $('shell').classList.remove('touch-ready');
  ended = true;
  closePeer();
  $('video').srcObject = null;
  ws?.close();

  const messages = {
    time_up: ['Tempo esgotado', 'Seu tempo de jogo terminou. O Xbox já está livre para outra pessoa.'],
    forfeited: ['Você desistiu', 'A sessão foi encerrada na hora, sem devolução, como combinado nas regras.'],
    refunded: ['Sessão encerrada', 'O pagamento foi estornado e a sessão encerrada pelo operador.'],
    provision_timeout: ['Não conseguimos iniciar', 'A transmissão não ficou pronta a tempo e seu relógio nem começou. O pagamento é estornado automaticamente.'],
    admin: ['Sessão encerrada', 'O operador encerrou esta sessão.'],
    admin_reset: ['Sessão encerrada', 'O operador reiniciou o estado da máquina.'],
  };
  const [title, text] = messages[reason] ?? ['Sessão encerrada', 'Esta sessão não está mais ativa.'];

  $('overlay').classList.remove('hidden');
  $('overlayInner').innerHTML = `
    <div class="badge ${reason === 'time_up' ? 'warn' : 'danger'}" style="margin-bottom: 16px;">sessão encerrada</div>
    <h2 style="margin: 0 0 10px; font-size: 26px;">${title}</h2>
    <p class="tiny muted" style="max-width: 380px; margin: 0 auto 20px; line-height: 1.6;">${text}</p>
    <a class="btn btn-primary btn-lg" href="/">Voltar ao início</a>
    <p class="tiny muted" style="margin-top: 18px;">
      Quer jogar de novo? O Xbox pode estar livre agora.
    </p>`;
  $('btnExtend').disabled = true;
  $('btnForfeit').disabled = true;
  clearInterval(statsInterval);
}

function fatal(title, message) {
  ended = true;
  $('overlay').classList.remove('hidden');
  $('overlayInner').innerHTML = `
    <div class="badge danger" style="margin-bottom: 16px;">erro</div>
    <h2 style="margin: 0 0 10px; font-size: 24px;">${esc(title)}</h2>
    <p class="tiny muted" style="max-width: 380px; margin: 0 auto 20px; line-height: 1.6;">${esc(message)}</p>
    <a class="btn btn-primary" href="/">Ir para o início</a>`;
  $('btnExtend').disabled = true;
  $('btnForfeit').disabled = true;
}

/* ------------------------------------------------------------------ */
/* Relógio                                                            */
/* ------------------------------------------------------------------ */

function tick() {
  if (!session) return;

  if (session.endsAt) {
    const left = remainingFrom(session.endsAt);
    const clock = $('clock');
    clock.textContent = fmtClock(left);
    clock.classList.toggle('warn', left > 0 && left <= 5 * 60_000);
    clock.classList.toggle('danger', left > 0 && left <= 60_000);

    document.querySelectorAll('[data-ends]').forEach((node) => {
      const ends = Number(node.getAttribute('data-ends'));
      node.textContent = fmtClock(remainingFrom(ends));
    });

    for (const minutes of [10, 5, 1]) {
      if (left > 0 && left <= minutes * 60_000 && !warned.has(String(minutes))) {
        warned.add(String(minutes));
        toast(`Faltam ${minutes} minuto(s) de jogo.`, minutes <= 1 ? 'danger' : 'warn', 7000);
      }
    }

    if (left <= 0 && !ended) {
      $('statusText').textContent = 'tempo esgotado';
      $('statusDot').className = 'dot off';
    }
  }

  updateHud();
}

/* ------------------------------------------------------------------ */
/* UI                                                                 */
/* ------------------------------------------------------------------ */

function bindUI() {
  $('btnSound').addEventListener('click', async () => {
    const video = $('video');
    video.muted = false;
    try {
      await video.play();
      $('btnSound').classList.add('hidden');
      toast('Som ativado.', 'green', 2000);
    } catch {
      toast('Seu navegador bloqueou o áudio. Toque novamente.', 'warn');
    }
  });

  $('btnExtend').addEventListener('click', openExtend);
  $('btnForfeit').addEventListener('click', openForfeit);

  $('btnFull').addEventListener('click', () => {
    const shell = $('shell');
    if (document.fullscreenElement) document.exitFullscreen();
    else shell.requestFullscreen?.().catch(() => {});
  });

  $('btnStats').addEventListener('click', () => {
    $('statsPanel').classList.toggle('hidden');
  });

  const poke = () => {
    $('shell').classList.add('show-ui');
    clearTimeout(uiHideTimer);
    uiHideTimer = setTimeout(() => $('shell').classList.remove('show-ui'), 3200);
  };
  ['mousemove', 'touchstart', 'keydown'].forEach((evt) =>
    window.addEventListener(evt, poke, { passive: true }));
  poke();

  const video = $('video');
  video.addEventListener('playing', () => {
    $('shell').classList.add('touch-ready');
    if (!ended) hideOverlay();
  });
  video.addEventListener('click', () => {
    if (video.muted) {
      video.muted = false;
      $('btnSound').classList.add('hidden');
    }
    poke();
  });

  window.addEventListener('beforeunload', () => {
    // Sair da página NÃO encerra a sessão: o tempo continua, por regra.
    ws?.close();
  });
}

/* ------------------------------------------------------------------ */
/* Modal base                                                         */
/* ------------------------------------------------------------------ */

function openModal(html) {
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<div class="modal">${html}</div>`;
  $('modals').append(back);
  back.addEventListener('click', (event) => {
    if (event.target === back) back.remove();
  });
  return {
    root: back,
    body: back.querySelector('.modal'),
    close: () => back.remove(),
  };
}

/* ------------------------------------------------------------------ */
/* Adicionar tempo                                                    */
/* ------------------------------------------------------------------ */

function priceForHour(index) {
  const table = config?.pricing?.hourlyCents ?? [700, 600, 500, 400];
  return table[index] ?? null;
}

function openExtend() {
  if (!session?.canExtend) {
    toast('Não é possível adicionar tempo agora.', 'warn');
    return;
  }

  const purchased = session.hoursPurchased;
  const maxHours = session.maxHours ?? 4;
  const maxExtra = Math.max(0, maxHours - purchased);
  let selected = 1;

  const modal = openModal(`
    <h3>Adicionar tempo</h3>
    <p>
      Sua sessão já tem <strong>${purchased}h</strong> e termina às
      <strong>${fmtTime(session.endsAt)}</strong>. Comprar antes do fim mantém o desconto:
      a próxima hora custa <strong>${brl(priceForHour(purchased))}</strong>.
    </p>
    <div class="hours-grid" id="extHours">
      ${Array.from({ length: maxExtra }, (_, i) => `
        <button type="button" class="hour-opt ${i === 0 ? 'selected' : ''}" data-h="${i + 1}">
          <strong>+${i + 1}h</strong>
          <span>${brl(sumRange(purchased, i + 1))}</span>
        </button>`).join('')}
    </div>
    <div class="total-line">
      <div class="big" id="extTotal">${brl(priceForHour(purchased))}</div>
      <span class="badge green">Pix</span>
    </div>
    <div id="extBody"></div>
    <div class="actions">
      <button class="btn btn-ghost" id="extCancel">Agora não</button>
      <button class="btn btn-primary" id="extBuy">Gerar Pix</button>
    </div>
  `);

  const body = modal.body;
  body.querySelector('#extCancel').addEventListener('click', modal.close);

  body.querySelectorAll('.hour-opt').forEach((btn) => {
    btn.addEventListener('click', () => {
      selected = Number(btn.dataset.h);
      body.querySelectorAll('.hour-opt').forEach((b) =>
        b.classList.toggle('selected', Number(b.dataset.h) === selected));
      body.querySelector('#extTotal').textContent = brl(sumRange(purchased, selected));
    });
  });

  body.querySelector('#extBuy').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = 'Gerando…';

    try {
      const order = await api('/api/session/extend', {
        method: 'POST',
        body: { token, hours: selected },
      });
      renderPix(modal, order, purchased);
    } catch (err) {
      toast(err.message, 'danger');
      button.disabled = false;
      button.textContent = 'Gerar Pix';
      if (err.code === 'max_hours' || err.code === 'time_up' || err.code === 'session_not_active') {
        modal.close();
      }
    }
  });
}

function sumRange(startIndex, count) {
  let total = 0;
  for (let i = 0; i < count; i++) total += priceForHour(startIndex + i) ?? 0;
  return total;
}

function renderPix(modal, order, purchased) {
  const body = modal.body;
  const footer = body.querySelector('.actions');
  if (footer) footer.remove();

  body.querySelector('#extBody').innerHTML = `
    <div class="divider"></div>
    <div class="qr-box" style="width: 190px; height: 190px;">
      ${order.qrCodeBase64
        ? `<img alt="QR Pix" src="data:image/png;base64,${order.qrCodeBase64}" />`
        : `<div class="tiny muted center">Modo teste<br/>sem QR real</div>`}
    </div>
    <div class="pix-code mt-4" id="extCode">${esc(order.qrCode ?? '')}</div>
    <button class="btn btn-ghost btn-block mt-4" id="extCopy">Copiar código</button>
    ${order.paymentMode === 'mock'
      ? `<button class="btn btn-primary btn-block mt-4" id="extMock">Simular pagamento</button>`
      : ''}
    <div class="alert warn mt-4 center">
      Pague em <span class="timer" data-ends="${order.expiresAt}">—</span>.
      O tempo atual continua correndo.
    </div>
    <button class="btn btn-ghost btn-block mt-4" id="extClose">Fechar</button>
  `;

  body.querySelector('#extCopy')?.addEventListener('click', async () => {
    const ok = await copyText(order.qrCode ?? '');
    toast(ok ? 'Código copiado.' : 'Copie manualmente.', ok ? 'green' : 'warn');
  });

  body.querySelector('#extClose')?.addEventListener('click', modal.close);

  body.querySelector('#extMock')?.addEventListener('click', async (event) => {
    event.currentTarget.disabled = true;
    try {
      await api(`/api/orders/${order.id}/mock-pay`, { method: 'POST' });
    } catch (err) {
      toast(err.message, 'danger');
      event.currentTarget.disabled = false;
    }
  });

  let stop = false;
  const timer = setInterval(async () => {
    if (stop) return;
    try {
      const fresh = await api(`/api/orders/${order.id}`);
      if (fresh.status === 'paid') {
        stop = true;
        clearInterval(timer);
        modal.close();
        toast('Tempo adicionado. Bom jogo!', 'green', 5000);
        await backupRefresh();
        return;
      }
      if (fresh.status === 'expired' || fresh.status === 'canceled') {
        stop = true;
        clearInterval(timer);
        body.querySelector('#extBody').innerHTML = `
          <div class="divider"></div>
          <div class="alert danger">Este Pix expirou. Nenhum valor foi cobrado.</div>
          <button class="btn btn-primary btn-block mt-4" id="extAgain">Tentar de novo</button>`;
        body.querySelector('#extAgain')?.addEventListener('click', () => {
          modal.close();
          openExtend();
        });
      }
    } catch {
      /* tenta de novo */
    }
  }, 3000);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
  });
}

/* ------------------------------------------------------------------ */
/* Desistir                                                           */
/* ------------------------------------------------------------------ */

function openForfeit() {
  const modal = openModal(`
    <h3>Desistir da sessão?</h3>
    <p>
      Isso encerra sua sessão <strong>imediatamente</strong>. O tempo restante é perdido,
      <strong>não há devolução</strong> e o Xbox fica livre para outra pessoa.
      Você também <strong>não poderá voltar</strong> com este link.
    </p>
    <label class="row" style="gap: 10px; font-size: 13px; color: var(--muted);">
      <input type="checkbox" id="forfeitOk" style="width: auto;" />
      Entendi e quero desistir
    </label>
    <div class="actions">
      <button class="btn btn-ghost" id="forfeitNo">Continuar jogando</button>
      <button class="btn btn-danger" id="forfeitYes" disabled>Sim, desistir</button>
    </div>
  `);

  const check = modal.body.querySelector('#forfeitOk');
  const yes = modal.body.querySelector('#forfeitYes');
  check.addEventListener('change', () => {
    yes.disabled = !check.checked;
  });
  modal.body.querySelector('#forfeitNo').addEventListener('click', modal.close);

  yes.addEventListener('click', async () => {
    yes.disabled = true;
    yes.textContent = 'Encerrando…';
    try {
      await api('/api/session/forfeit', {
        method: 'POST',
        body: { token, confirm: true },
      });
      modal.close();
      showEnded('forfeited');
    } catch (err) {
      toast(err.message, 'danger');
      yes.disabled = false;
      yes.textContent = 'Sim, desistir';
    }
  });
}

/* ------------------------------------------------------------------ */
/* Estatísticas                                                       */
/* ------------------------------------------------------------------ */

function startStats() {
  if (statsInterval) return;
  statsInterval = setInterval(updateStats, 2000);
  updateStats();
}

function stopStats() {
  clearInterval(statsInterval);
  statsInterval = null;
  lastStats = null;
}

async function updateStats() {
  if (!pc || pc.connectionState !== 'connected') return;
  try {
    const report = await pc.getStats();
    let videoIn = null;
    let pair = null;

    report.forEach((entry) => {
      if (entry.type === 'inbound-rtp' && entry.kind === 'video') videoIn = entry;
      if (entry.type === 'candidate-pair' && entry.state === 'succeeded'
        && (entry.nominated || entry.selected)) pair = entry;
    });

    if (!videoIn) return;

    const nowTs = performance.now();
    let bitrate = null;
    if (lastStats && nowTs > lastStats.ts) {
      const deltaBytes = (videoIn.bytesReceived ?? 0) - lastStats.bytes;
      bitrate = (deltaBytes * 8) / ((nowTs - lastStats.ts) / 1000);
    }
    lastStats = { ts: nowTs, bytes: videoIn.bytesReceived ?? 0 };

    $('stRes').textContent = videoIn.frameWidth
      ? `${videoIn.frameWidth}×${videoIn.frameHeight}`
      : '—';
    $('stFps').textContent = videoIn.framesPerSecond ? `${videoIn.framesPerSecond}` : '—';
    $('stBitrate').textContent = bitrate
      ? bitrate > 1_000_000
        ? `${(bitrate / 1_000_000).toFixed(1)} Mbps`
        : `${Math.round(bitrate / 1000)} kbps`
      : '—';
    $('stRtt').textContent = pair?.currentRoundTripTime != null
      ? `${Math.round(pair.currentRoundTripTime * 1000)} ms`
      : '—';
    $('stJitter').textContent = videoIn.jitter != null
      ? `${(videoIn.jitter * 1000).toFixed(1)} ms`
      : '—';
    $('stLoss').textContent = videoIn.packetsLost != null
      ? `${videoIn.packetsLost}`
      : '—';

    const codecEntry = videoIn.codecId ? report.get(videoIn.codecId) : null;
    $('stCodec').textContent = codecEntry?.mimeType?.replace('video/', '') ?? '—';
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ */
/* Controle (gamepad)                                                 */
/* ------------------------------------------------------------------ */

function touchPayload() {
  const buttons = Array.from({ length: 17 }, (_, index) => {
    const pressed = touchButtons.has(index);
    return [pressed ? 1 : 0, pressed ? 1 : 0];
  });
  return {
    id: 'Touchscreen Controller',
    axes: touchAxes.map((value) => Math.round(value * 1000) / 1000),
    buttons,
  };
}

function sendInput(payload) {
  if (ended || !ws?.ready) return;
  const key = JSON.stringify(payload.axes) + JSON.stringify(payload.buttons);
  const nowTs = Date.now();
  if (key === lastInputKey && nowTs - lastInputAt < 1000) return;
  lastInputKey = key;
  lastInputAt = nowTs;
  ws.send({ type: 'input', payload });
}

function releaseTouchControls(sendNeutral = true) {
  for (const [pointerId, stick] of stickPointers) {
    const knob = stick.element.querySelector('.touch-stick-knob');
    knob.style.transform = 'translate(-50%, -50%)';
    touchAxes[stick.axis] = 0;
    touchAxes[stick.axis + 1] = 0;
    stickPointers.delete(pointerId);
  }
  for (const button of touchButtons) {
    document.querySelector(`[data-touch-button="${button}"]`)?.classList.remove('is-pressed');
  }
  touchButtons.clear();
  touchPointers.clear();
  if (sendNeutral) sendInput(touchPayload());
}

function updateStick(event, stick) {
  const rect = stick.element.getBoundingClientRect();
  const radius = Math.max(1, Math.min(rect.width, rect.height) * 0.5);
  const knobRadius = radius * 0.42;
  let x = (event.clientX - (rect.left + rect.width / 2)) / (radius - knobRadius);
  let y = (event.clientY - (rect.top + rect.height / 2)) / (radius - knobRadius);
  const magnitude = Math.hypot(x, y);
  if (magnitude > 1) {
    x /= magnitude;
    y /= magnitude;
  }
  if (Math.hypot(x, y) < 0.12) x = y = 0;

  touchAxes[stick.axis] = x;
  touchAxes[stick.axis + 1] = y;
  stick.knob.style.transform = `translate(calc(-50% + ${x * (radius - knobRadius)}px), calc(-50% + ${y * (radius - knobRadius)}px))`;
}

function setupTouchControls() {
  const supported = navigator.maxTouchPoints > 0
    || window.matchMedia?.('(pointer: coarse)').matches;
  if (!supported) return;

  const shell = $('shell');
  const controls = $('touchControls');
  controls.hidden = false;
  shell.classList.add('touch-device');

  controls.querySelectorAll('[data-touch-stick]').forEach((element) => {
    const axis = Number(element.dataset.touchStick);
    const knob = element.querySelector('.touch-stick-knob');

    element.addEventListener('pointerdown', (event) => {
      if (ended || shell.classList.contains('has-gamepad') || stickPointers.size > 1) return;
      if ([...stickPointers.values()].some((stick) => stick.element === element)) return;
      event.preventDefault();
      element.setPointerCapture(event.pointerId);
      const stick = { element, knob, axis };
      stickPointers.set(event.pointerId, stick);
      updateStick(event, stick);
      sendInput(touchPayload());
    });

    element.addEventListener('pointermove', (event) => {
      const stick = stickPointers.get(event.pointerId);
      if (stick?.element === element) updateStick(event, stick);
    });

    const release = (event) => {
      const stick = stickPointers.get(event.pointerId);
      if (!stick || stick.element !== element) return;
      stickPointers.delete(event.pointerId);
      touchAxes[axis] = 0;
      touchAxes[axis + 1] = 0;
      knob.style.transform = 'translate(-50%, -50%)';
      if (stickPointers.size === 0 && touchPointers.size === 0) sendInput(touchPayload());
    };
    element.addEventListener('pointerup', release);
    element.addEventListener('pointercancel', release);
    element.addEventListener('lostpointercapture', release);
  });

  controls.querySelectorAll('[data-touch-button]').forEach((element) => {
    const index = Number(element.dataset.touchButton);
    element.addEventListener('pointerdown', (event) => {
      if (ended || shell.classList.contains('has-gamepad')) return;
      event.preventDefault();
      element.setPointerCapture(event.pointerId);
      touchPointers.set(event.pointerId, { index, element });
      touchButtons.add(index);
      element.classList.add('is-pressed');
      sendInput(touchPayload());
    });

    const release = (event) => {
      const pressed = touchPointers.get(event.pointerId);
      if (!pressed || pressed.element !== element) return;
      touchPointers.delete(event.pointerId);
      if (![...touchPointers.values()].some((button) => button.index === index)) {
        touchButtons.delete(index);
        element.classList.remove('is-pressed');
      }
      if (stickPointers.size === 0 && touchPointers.size === 0) sendInput(touchPayload());
    };
    element.addEventListener('pointerup', release);
    element.addEventListener('pointercancel', release);
    element.addEventListener('lostpointercapture', release);
  });

  setInterval(() => {
    if (!ended && !shell.classList.contains('has-gamepad')
      && (stickPointers.size > 0 || touchPointers.size > 0)) {
      sendInput(touchPayload());
    }
  }, 50);

  window.addEventListener('blur', () => releaseTouchControls());
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) releaseTouchControls();
  });
}

function activeGamepad() {
  const pads = navigator.getGamepads?.() ?? [];
  return Array.from(pads).find((p) => p && p.connected) ?? null;
}

function setupGamepad() {
  window.addEventListener('gamepadconnected', (event) => {
    $('shell').classList.add('has-gamepad');
    releaseTouchControls(false);
    $('padPill').classList.remove('hidden');
    $('padText').textContent = event.gamepad.id.split('(')[0].trim().slice(0, 28);
    toast('Controle conectado.', 'green', 3000);
  });

  window.addEventListener('gamepaddisconnected', () => {
    if (!activeGamepad()) {
      $('shell').classList.remove('has-gamepad');
      $('padPill').classList.add('hidden');
    }
  });

  $('shell').classList.toggle('has-gamepad', Boolean(activeGamepad()));
  setInterval(() => {
    if (ended || !ws?.ready) return;
    const pad = activeGamepad();
    const shell = $('shell');
    const connected = Boolean(pad);
    if (connected !== shell.classList.contains('has-gamepad')) {
      shell.classList.toggle('has-gamepad', connected);
      if (connected) releaseTouchControls(false);
    }
    if (!pad) return;

    if ($('padPill').classList.contains('hidden')) {
      $('padPill').classList.remove('hidden');
      $('padText').textContent = pad.id.split('(')[0].trim().slice(0, 28);
    }

    const payload = {
      id: pad.id.slice(0, 64),
      axes: pad.axes.map((value) => Math.round(value * 1000) / 1000),
      buttons: pad.buttons.map((button) => [
        button.pressed ? 1 : 0,
        Math.round(button.value * 100) / 100,
      ]),
    };

    sendInput(payload);
  }, 50);
}

/* ------------------------------------------------------------------ */
/* Mostrar/esconder UI                                                */
/* ------------------------------------------------------------------ */

document.addEventListener('fullscreenchange', () => {
  $('btnFull').textContent = document.fullscreenElement ? 'sair da tela cheia' : 'tela cheia';
});
