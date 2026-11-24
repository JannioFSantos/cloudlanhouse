import {
  fmtClock,
  remainingFrom,
  setServerNow,
  toast,
  connectWS,
} from './common.js';

const $ = (id) => document.getElementById(id);

let ws = null;
let key = '';
let stream = null;
let pc = null;
let session = null;
let viewerPresent = false;
let readySent = false;
let publishing = false;
let bitrateKbps = 6000;
let fps = 60;
let captureMode = 'card';
let iceServers = [];
let audioCtx = null;
let analyser = null;
let meterRaf = 0;
let statsTimer = null;
let lastStats = null;

/* ------------------------------------------------------------------ */
/* Boot                                                               */
/* ------------------------------------------------------------------ */

boot();

function boot() {
  restorePrefs();
  bindUI();
  applyCaptureMode();

  const saved = localStorage.getItem('xp_host_key') || '';
  if (saved) {
    $('hostKeyInput').value = saved;
    connect(saved);
  }

  setInterval(updateClock, 500);
}

function restorePrefs() {
  const prefs = JSON.parse(localStorage.getItem('xp_host_prefs') || '{}');
  if (prefs.autoStart === false) $('autoStart').checked = false;
  if (prefs.captureMode === 'window' || prefs.captureMode === 'card') captureMode = prefs.captureMode;
  if (prefs.resolution) $('resSelect').value = prefs.resolution;
  if (prefs.fps) $('fpsSelect').value = prefs.fps;
  if (prefs.bitrate) $('bitrateSelect').value = prefs.bitrate;
  bitrateKbps = Number($('bitrateSelect').value);
  fps = Number($('fpsSelect').value);
  $('videoSelect').dataset.saved = prefs.videoId || '';
  $('audioSelect').dataset.saved = prefs.audioId || '';
}

function savePrefs() {
  localStorage.setItem('xp_host_prefs', JSON.stringify({
    autoStart: $('autoStart').checked,
    captureMode,
    resolution: $('resSelect').value,
    fps: $('fpsSelect').value,
    bitrate: $('bitrateSelect').value,
    videoId: $('videoSelect').value || '',
    audioId: $('audioSelect').value || '',
  }));
}

function applyCaptureMode() {
  const windowMode = captureMode === 'window';
  for (const btn of document.querySelectorAll('#sourceMode [data-mode]')) {
    btn.classList.toggle('active', btn.dataset.mode === captureMode);
  }
  $('cardFields').classList.toggle('hidden', windowMode);
  $('windowFields').classList.toggle('hidden', !windowMode);
  $('btnDetect').classList.toggle('hidden', windowMode);
  $('btnWindow').classList.toggle('hidden', windowMode);
  $('btnStart').textContent = windowMode ? 'Escolher janela do jogo' : 'Iniciar captura da placa';
  $('sourceHint').textContent = windowMode
    ? 'O jogo roda no próprio PC (Steam, emulador ou qualquer app).'
    : 'O jogo roda em um console ligado à placa de captura HDMI.';
}

/* ------------------------------------------------------------------ */
/* Conexão                                                            */
/* ------------------------------------------------------------------ */

function connect(hostKey) {
  key = hostKey.trim();
  if (!key) return toast('Informe a chave do host.', 'warn');
  localStorage.setItem('xp_host_key', key);

  ws?.close();
  setBadge('connecting', 'conectando');

  ws = connectWS({
    role: 'host',
    key,
    onStatus(status) {
      if (status === 'online') setBadge('live', 'conectado');
      else if (status === 'connecting') setBadge('reserved', 'conectando');
      else if (status === 'replaced') {
        setBadge('off', 'aberto em outro lugar');
        toast('Este host foi conectado em outra aba. Feche uma delas.', 'warn', 8000);
      } else setBadge('off', 'reconectando');
    },
    onOpen(msg) {
      $('authCard').classList.add('hidden');
      $('main').classList.remove('hidden');
      if (msg.iceServers?.length) iceServers = msg.iceServers;
      if (msg.state?.serverNow) setServerNow(msg.state.serverNow);
      applySession(msg.session);
      log('Conectado ao servidor como host.');
      loadDevices(false);
      updateUI();
    },
    onClose(event) {
      if (event?.code === 4001) log('Outra aba assumiu o papel de host.', 'warn');
      else log('Conexão com o servidor caiu. Tentando reconectar…', 'warn');
    },
    onMessage: handleMessage,
  });
}

async function handleMessage(msg) {
  switch (msg.type) {
    case 'host:state':
      if (msg.state?.serverNow) setServerNow(msg.state.serverNow);
      applySession(msg.session);
      break;

    case 'session:created':
    case 'session:started':
    case 'session:extended': {
      const previousStatus = session?.status;
      applySession(msg.session);
      log(`Sessão ${msg.type.split(':')[1]}${msg.session?.id ? ` (${msg.session.id.slice(-6)})` : ''}.`, 'info');
      if (msg.type === 'session:extended') toast('Cliente adicionou tempo.', 'green');
      if (['provisioning', 'active'].includes(session?.status)) {
        if ($('autoStart').checked && !stream && captureMode === 'card') {
          log('Sessão paga: iniciando captura automática…');
          await startCapture();
        } else if (captureMode === 'window' && !stream) {
          log('Modo janela: clique em “Escolher janela do jogo” para publicar.', 'warn');
        } else if (stream && !readySent) {
          sendReady();
        }
      }
      if (previousStatus === 'provisioning' && session?.status === 'active') {
        log('Relógio do cliente iniciado.');
      }
      break;
    }

    case 'session:warning':
      log(`Aviso enviado ao cliente: faltam ${msg.minutes} min.`);
      break;

    case 'session:ended':
      log('Sessão encerrada. Parando captura.', 'warn');
      applySession({ ...session, status: 'ended', endsAt: session?.endsAt ?? null });
      teardown();
      break;

    case 'viewer:joined':
      viewerPresent = true;
      log('Player conectado.');
      updateUI();
      if (stream) await publish();
      break;

    case 'viewer:left':
      viewerPresent = false;
      log('Player desconectou (o tempo continua correndo).', 'warn');
      closePeer();
      updateUI();
      break;

    case 'answer':
      try {
        await pc?.setRemoteDescription(msg.payload);
        log('Negociação WebRTC concluída.');
      } catch (err) {
        log(`Falha no answer: ${err.message}`, 'error');
      }
      break;

    case 'candidate':
      try {
        await pc?.addIceCandidate(msg.payload);
      } catch {
        /* candidato atrasado */
      }
      break;

    case 'request-offer':
      if (stream) await publish();
      break;

    case 'input:ack':
      break;

    case 'error':
      if (msg.code === 'invalid_host_key') {
        toast('Chave do host inválida.', 'danger');
        $('main').classList.add('hidden');
        $('authCard').classList.remove('hidden');
        localStorage.removeItem('xp_host_key');
      } else {
        log(`Erro: ${msg.message}`, 'error');
      }
      break;

    default:
      break;
  }
}

function setBadge(kind, text) {
  $('connDot').className = `dot ${kind}`;
  $('connText').textContent = text;
}

/* ------------------------------------------------------------------ */
/* Sessão                                                             */
/* ------------------------------------------------------------------ */

function applySession(next) {
  if (next === null || next === undefined) {
    if (session && ['provisioning', 'active'].includes(session.status)) return;
    session = null;
  } else {
    session = { ...(session ?? {}), ...next };
  }
  updateUI();
}

function updateUI() {
  const status = session?.status;
  const badge = $('sessionBadge');
  const badgeText = $('sessionBadgeText');

  if (!status || status === 'ended' || status === 'forfeited') {
    badgeText.textContent = status ? 'encerrada' : 'sem sessão';
    badge.className = 'badge';
    $('sessionState').textContent = status ? 'encerrada' : '—';
    $('sessionCustomer').textContent = '—';
    $('sessionHours').textContent = '—';
  } else {
    badgeText.textContent = status === 'active' ? 'ativa' : 'provisionando';
    badge.className = `badge ${status === 'active' ? 'green' : 'purple'}`;
    $('sessionState').textContent = status === 'active' ? 'jogando' : 'preparando';
    $('sessionCustomer').textContent = session.customerFirstName ?? '—';
    $('sessionHours').textContent = session.hoursPurchased ? `${session.hoursPurchased}h` : '—';
  }

  $('viewerState').textContent = viewerPresent ? 'sim' : 'não';
  $('publishState').textContent = publishing ? 'sim' : 'não';

  $('btnStart').disabled = Boolean(stream);
  $('btnStop').disabled = !stream;
  $('btnPublish').disabled = !stream || !['active', 'provisioning'].includes(status);

  if (stream) {
    const track = stream.getVideoTracks()[0];
    const settings = track?.getSettings?.() ?? {};
    $('previewBadge').textContent = settings.width
      ? `${settings.width}×${settings.height} @ ${Math.round(settings.frameRate ?? 0)}`
      : 'sinal ativo';
  } else {
    $('previewBadge').textContent = 'sem sinal';
  }

  updateClock();
}

function updateClock() {
  const clock = $('sessionClock');
  if (!session?.endsAt) {
    clock.textContent = '—';
    clock.classList.remove('warn', 'danger');
    return;
  }
  if (session.status !== 'active') {
    clock.textContent = '—';
    return;
  }
  const left = remainingFrom(session.endsAt);
  clock.textContent = fmtClock(left);
  clock.classList.toggle('warn', left <= 5 * 60_000 && left > 60_000);
  clock.classList.toggle('danger', left <= 60_000);
}

/* ------------------------------------------------------------------ */
/* Captura                                                            */
/* ------------------------------------------------------------------ */

async function loadDevices(requestPermission) {
  try {
    if (requestPermission) {
      const temp = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      temp.getTracks().forEach((t) => t.stop());
      log('Permissão de câmera/microfone concedida (usada só para listar a placa).');
    }
  } catch (err) {
    log(`Permissão negada ou indisponível: ${err.message}`, 'warn');
  }

  const devices = await navigator.mediaDevices.enumerateDevices();
  const videos = devices.filter((d) => d.kind === 'videoinput');
  const audios = devices.filter((d) => d.kind === 'audioinput');

  fillSelect($('videoSelect'), videos, 'Nenhuma placa encontrada');
  fillSelect($('audioSelect'), audios, 'Sem áudio (vídeo mudo)');

  $('deviceCount').textContent = `${videos.length} vídeo · ${audios.length} áudio`;
  log(`Dispositivos: ${videos.length} entrada(s) de vídeo, ${audios.length} de áudio.`);

  if (videos.length) {
    const saved = $('videoSelect').dataset.saved;
    const match = videos.find((d) => d.deviceId === saved)
      ?? videos.find((d) => /capture|elgato|avermedia|hdmi|usb video|game/i.test(d.label))
      ?? videos[0];
    if (match) $('videoSelect').value = match.deviceId;
  }
  if (audios.length) {
    const saved = $('audioSelect').dataset.saved;
    const match = audios.find((d) => d.deviceId === saved)
      ?? audios.find((d) => /capture|elgato|avermedia|hdmi|usb|line/i.test(d.label))
      ?? audios[0];
    if (match) $('audioSelect').value = match.deviceId;
  }

  savePrefs();
  return { videos, audios };
}

function fillSelect(select, devices, emptyLabel) {
  const current = select.value;
  select.innerHTML = '';

  if (!devices.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = emptyLabel;
    select.appendChild(option);
    return;
  }

  for (const device of devices) {
    const option = document.createElement('option');
    option.value = device.deviceId;
    option.textContent = device.label || `Dispositivo ${device.deviceId.slice(0, 6)}`;
    select.appendChild(option);
  }
  if (current && devices.some((d) => d.deviceId === current)) select.value = current;
}

async function startCapture() {
  if (stream) return stream;

  const videoId = $('videoSelect').value;
  const audioId = $('audioSelect').value;
  const [width, height] = $('resSelect').value.split('x').map(Number);
  fps = Number($('fpsSelect').value);
  bitrateKbps = Number($('bitrateSelect').value);

  const constraints = {
    video: {
      ...(videoId ? { deviceId: { exact: videoId } } : {}),
      width: { ideal: width },
      height: { ideal: height },
      frameRate: { ideal: fps, max: fps },
    },
    audio: audioId
      ? {
          deviceId: { exact: audioId },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 2,
          sampleRate: 48000,
        }
      : false,
  };

  try {
    log('Abrindo a placa de captura…');
    stream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    log(`Falha ao abrir a captura: ${err.message}`, 'error');
    toast('Não foi possível abrir a placa de captura. Veja o log.', 'danger', 7000);
    stream = null;
    return null;
  }

  const videoTrack = stream.getVideoTracks()[0];
  const audioTrack = stream.getAudioTracks()[0];
  const settings = videoTrack?.getSettings?.() ?? {};

  if (videoTrack) videoTrack.contentHint = 'motion';
  if (audioTrack) audioTrack.contentHint = 'music';

  $('preview').srcObject = stream;
  $('preview').play().catch(() => {});

  log(
    `Captura ativa: ${settings.width ?? '?'}×${settings.height ?? '?'} `
    + `@ ${Math.round(settings.frameRate ?? 0)}fps — ${videoTrack?.label ?? 'vídeo'}`,
  );
  if (audioTrack) {
    const a = audioTrack.getSettings?.() ?? {};
    log(`Áudio: ${audioTrack.label} (${a.sampleRate ?? '?'} Hz, ${a.channelCount ?? '?'} canais).`);
  } else {
    log('Sem áudio capturado: o cliente ouvirá silêncio.', 'warn');
  }

  setupMeter(stream);
  updateUI();

  if (['provisioning', 'active'].includes(session?.status)) sendReady();
  if (viewerPresent) await publish();

  return stream;
}

async function startWindowCapture() {
  if (stream) return toast('Pare a captura atual primeiro.', 'warn');
  if (!navigator.mediaDevices?.getDisplayMedia) {
    log('Este navegador não suporta captura de janela. Use Chrome ou Edge atualizado.', 'error');
    return toast('Captura de janela indisponível neste navegador.', 'danger', 7000);
  }
  try {
    log('Abrindo seletor de janela (jogo/emulador)…');
    const display = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 60 },
      audio: true,
    });
    stream = display;
    $('preview').srcObject = display;
    $('preview').play().catch(() => {});
    setupMeter(display);
    log('Captura de janela ativa. Mantenha a janela do jogo visível.');
    updateUI();
    if (['provisioning', 'active'].includes(session?.status)) sendReady();
    if (viewerPresent) await publish();
  } catch (err) {
    if (err.name === 'NotAllowedError') {
      log('Captura de janela cancelada pelo operador.', 'warn');
    } else {
      log(`Falha na captura de janela: ${err.message}`, 'error');
    }
  }
}

function sendReady() {
  if (!ws?.ready || !stream || !session) return;
  if (readySent) return;
  const sent = ws.send({ type: 'stream:ready' });
  if (sent) {
    readySent = true;
    log('Transmissão publicada: o relógio do cliente começou a contar.');
    toast('Transmissão no ar. Relógio iniciado.', 'green', 5000);
  }
}

async function publish() {
  if (!stream || !ws?.ready) return;

  closePeer();
  log('Negociando vídeo com o player…');

  pc = new RTCPeerConnection({ iceServers });

  pc.onicecandidate = (event) => {
    if (event.candidate) ws?.send({ type: 'candidate', payload: event.candidate });
  };

  pc.onconnectionstatechange = () => {
    const state = pc?.connectionState;
    if (state === 'connected') {
      publishing = true;
      log('Player recebendo vídeo (P2P conectado).');
      startStats();
    } else if (state === 'failed') {
      publishing = false;
      log('Conexão P2P falhou. O player vai pedir uma nova negociação.', 'error');
    } else if (state === 'disconnected') {
      publishing = false;
      log('Conexão P2P instável.', 'warn');
    }
    updateUI();
  };

  for (const track of stream.getTracks()) {
    const sender = pc.addTrack(track, stream);
    if (track.kind === 'video') await tuneSender(sender, true);
    if (track.kind === 'audio') await tuneSender(sender, false);
  }

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    ws.send({ type: 'offer', payload: offer });
  } catch (err) {
    log(`Falha ao criar oferta: ${err.message}`, 'error');
    closePeer();
  }
  updateUI();
}

async function tuneSender(sender, isVideo) {
  try {
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
    if (isVideo) {
      params.encodings[0].maxBitrate = bitrateKbps * 1000;
      params.encodings[0].maxFramerate = fps;
      params.degradationPreference = 'maintain-framerate';
    }
    await sender.setParameters(params);
  } catch (err) {
    log(`Ajuste de bitrate ignorado: ${err.message}`, 'warn');
  }
}

function closePeer() {
  stopStats();
  publishing = false;
  try {
    pc?.close();
  } catch {
    /* ignore */
  }
  pc = null;
  updateUI();
}

function teardown() {
  closePeer();
  stopMeter();
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  $('preview').srcObject = null;
  readySent = false;
  viewerPresent = false;
  publishing = false;
  updateUI();
  log('Captura parada.');
}

/* ------------------------------------------------------------------ */
/* Medidor de áudio                                                   */
/* ------------------------------------------------------------------ */

function setupMeter(mediaStream) {
  stopMeter();
  const audioTrack = mediaStream.getAudioTracks()[0];
  const bar = $('meterBar');
  const text = $('meterText');

  if (!audioTrack) {
    text.textContent = 'sem áudio';
    bar.style.width = '0%';
    return;
  }

  try {
    audioCtx = new AudioContext();
    const source = audioCtx.createMediaStreamSource(new MediaStream([audioTrack]));
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    const sink = audioCtx.createGain();
    sink.gain.value = 0;
    source.connect(analyser);
    analyser.connect(sink);
    sink.connect(audioCtx.destination);

    const buffer = new Uint8Array(analyser.fftSize);

    const loop = () => {
      analyser.getByteTimeDomainData(buffer);
      let peak = 0;
      for (let i = 0; i < buffer.length; i++) {
        peak = Math.max(peak, Math.abs(buffer[i] - 128));
      }
      const pct = Math.min(100, (peak / 128) * 140);
      bar.style.width = `${pct}%`;
      text.textContent = pct < 1 ? 'silêncio' : pct < 12 ? 'baixo' : pct < 60 ? 'ok' : 'alto';
      meterRaf = requestAnimationFrame(loop);
    };
    loop();
  } catch (err) {
    text.textContent = 'erro';
    log(`Medidor de áudio: ${err.message}`, 'warn');
  }
}

function stopMeter() {
  cancelAnimationFrame(meterRaf);
  meterRaf = 0;
  if (audioCtx) {
    audioCtx.close().catch(() => {});
    audioCtx = null;
  }
  analyser = null;
  const bar = $('meterBar');
  if (bar) bar.style.width = '0%';
  const text = $('meterText');
  if (text) text.textContent = '—';
}

/* ------------------------------------------------------------------ */
/* Estatísticas                                                       */
/* ------------------------------------------------------------------ */

function startStats() {
  clearInterval(statsTimer);
  lastStats = null;
  statsTimer = setInterval(sendStats, 3000);
}

function stopStats() {
  clearInterval(statsTimer);
  statsTimer = null;
  lastStats = null;
}

async function sendStats() {
  if (!pc || pc.connectionState !== 'connected') return;
  try {
    const report = await pc.getStats();
    let out = null;
    let pair = null;

    report.forEach((entry) => {
      if (entry.type === 'outbound-rtp' && entry.kind === 'video') out = entry;
      if (entry.type === 'candidate-pair' && entry.state === 'succeeded'
        && (entry.nominated || entry.selected)) pair = entry;
    });
    if (!out) return;

    const nowTs = performance.now();
    let bitrate = null;
    if (lastStats && nowTs > lastStats.ts) {
      bitrate = ((out.bytesSent - lastStats.bytes) * 8) / ((nowTs - lastStats.ts) / 1000);
    }
    lastStats = { ts: nowTs, bytes: out.bytesSent };

    ws?.send({
      type: 'stream:stats',
      payload: {
        bitrateKbps: bitrate ? Math.round(bitrate / 1000) : null,
        fps: out.framesPerSecond ?? null,
        quality: out.qualityLimitationReason ?? null,
        rttMs: pair?.currentRoundTripTime != null
          ? Math.round(pair.currentRoundTripTime * 1000)
          : null,
        width: out.frameWidth ?? null,
        height: out.frameHeight ?? null,
      },
    });

    if (out.qualityLimitationReason && out.qualityLimitationReason !== 'none') {
      log(`Qualidade limitada por: ${out.qualityLimitationReason}`, 'warn');
    }
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ */
/* Log + UI                                                           */
/* ------------------------------------------------------------------ */

function log(message, level = 'info') {
  const host = $('log');
  if (!host) return;
  const entry = document.createElement('div');
  entry.className = `entry ${level}`;
  const time = new Date().toLocaleTimeString('pt-BR');
  entry.innerHTML = `<time>${time}</time><span class="type">${level}</span><span class="detail"></span>`;
  entry.querySelector('.detail').textContent = message;
  host.prepend(entry);
  while (host.children.length > 120) host.lastChild.remove();
  console.log(`[host] ${message}`);
}

function bindUI() {
  $('btnConnect').addEventListener('click', () => connect($('hostKeyInput').value));

  $('hostKeyInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') connect($('hostKeyInput').value);
  });

  $('btnDetect').addEventListener('click', async () => {
    $('btnDetect').disabled = true;
    $('btnDetect').textContent = 'Detectando…';
    try {
      await loadDevices(true);
      toast('Dispositivos atualizados.', 'green');
    } catch (err) {
      log(`Não foi possível listar dispositivos: ${err.message}`, 'error');
    } finally {
      $('btnDetect').disabled = false;
      $('btnDetect').textContent = 'Detectar dispositivos';
    }
  });

  $('btnStart').addEventListener('click', () => {
    if (captureMode === 'window') return startWindowCapture();
    return startCapture();
  });
  $('btnWindow').addEventListener('click', startWindowCapture);
  $('sourceMode').addEventListener('click', (event) => {
    const btn = event.target.closest('[data-mode]');
    if (!btn || btn.dataset.mode === captureMode) return;
    if (stream) return toast('Pare a captura antes de trocar a fonte.', 'warn');
    captureMode = btn.dataset.mode;
    savePrefs();
    applyCaptureMode();
  });
  $('btnStop').addEventListener('click', () => {
    if (stream && !confirm('Parar a captura? O cliente vai ficar sem imagem, mas o relógio continua.')) return;
    teardown();
  });
  $('btnPublish').addEventListener('click', async () => {
    if (!stream) return toast('Inicie a captura primeiro.', 'warn');
    if (!['provisioning', 'active'].includes(session?.status)) {
      return toast('Não há sessão ativa para publicar.', 'warn');
    }
    await publish();
  });

  $('btnClearLog').addEventListener('click', () => {
    $('log').innerHTML = '';
  });

  for (const id of ['videoSelect', 'audioSelect', 'resSelect', 'fpsSelect', 'bitrateSelect', 'autoStart']) {
    $(id).addEventListener('change', savePrefs);
  }

  navigator.mediaDevices?.addEventListener?.('devicechange', () => {
    loadDevices(false).catch(() => {});
  });

  window.addEventListener('beforeunload', () => {
    stream?.getTracks().forEach((t) => t.stop());
    pc?.close();
  });
}
