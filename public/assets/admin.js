import {
  api,
  brl,
  fmtClock,
  fmtDateTime,
  fmtTime,
  esc,
  toast,
  copyText,
  remainingFrom,
  setServerNow,
  phoneMask,
} from './common.js';

const $ = (id) => document.getElementById(id);

let overview = null;
let pollTimer = null;
let lastEventAt = 0;
let adminWs = null;

boot();

async function boot() {
  bindStaticUI();
  try {
    const { admin } = await api('/api/admin/session');
    if (admin) enterDashboard();
    else showLogin();
  } catch {
    showLogin();
  }
}

function showLogin() {
  $('loginCard').classList.remove('hidden');
  $('dashboard').classList.add('hidden');
  $('btnLogout').classList.add('hidden');
}

function enterDashboard() {
  $('loginCard').classList.add('hidden');
  $('dashboard').classList.remove('hidden');
  $('btnLogout').classList.remove('hidden');
  load();
  clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (!document.hidden) load(true);
  }, 2500);
  setInterval(updateClocks, 500);
}

/* ------------------------------------------------------------------ */
/* Login                                                              */
/* ------------------------------------------------------------------ */

function bindStaticUI() {
  $('loginForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = $('loginBtn');
    button.disabled = true;
    button.textContent = 'Entrando…';
    try {
      await api('/api/admin/login', { method: 'POST', body: { password: $('password').value } });
      $('password').value = '';
      enterDashboard();
    } catch (err) {
      toast(err.message, 'danger');
      button.disabled = false;
      button.textContent = 'Entrar';
    }
  });

  $('btnLogout').addEventListener('click', async (event) => {
    event.preventDefault();
    await api('/api/admin/logout', { method: 'POST' }).catch(() => {});
    location.reload();
  });

  $('btnRevealKey').addEventListener('click', async () => {
    try {
      const { hostKey } = await api('/api/admin/host-key');
      const box = $('hostKeyBox');
      box.classList.remove('hidden');
      box.innerHTML = `<div class="row between" style="gap: 8px;">
        <span id="keyValue" style="word-break: break-all;">${esc(hostKey)}</span>
        <button class="btn btn-ghost btn-sm" id="btnCopyKey">copiar</button>
      </div>`;
      $('btnCopyKey').addEventListener('click', async () => {
        const ok = await copyText(hostKey);
        toast(ok ? 'Chave copiada.' : 'Copie manualmente.', ok ? 'green' : 'warn');
      });
    } catch (err) {
      toast(err.message, 'danger');
    }
  });

  document.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-action]');
    if (!btn) return;
    handleAction(btn).catch((err) => toast(err.message, 'danger'));
  });
}

/* ------------------------------------------------------------------ */
/* Carga                                                              */
/* ------------------------------------------------------------------ */

async function load(silent = false) {
  try {
    overview = await api('/api/admin/overview');
    setServerNow(overview.serverNow);
    render();
  } catch (err) {
    if (err.status === 401 || err.status === 403) {
      clearInterval(pollTimer);
      showLogin();
      if (!silent) toast('Sessão do painel expirou. Entre de novo.', 'warn');
      return;
    }
    if (!silent) toast(err.message, 'danger');
  }
}

/* ------------------------------------------------------------------ */
/* Render                                                             */
/* ------------------------------------------------------------------ */

function render() {
  if (!overview) return;
  const { session, presence, counters, queue, orders, events, config } = overview;

  $('modeDot').className = `dot ${overview.paymentMode === 'mock' ? 'warn' : 'live'}`;
  $('modeText').textContent = overview.paymentMode === 'mock' ? 'modo teste' : 'produção';

  const slotMap = {
    free: ['livre', 'green'],
    busy: ['em uso', 'warn'],
    reserved: ['pix aberto', 'purple'],
    held: ['fila', 'purple'],
  };
  const [slotText, slotClass] = slotMap[overview.slot?.status] ?? ['—', ''];
  $('slotBadge').textContent = slotText;
  $('slotBadge').className = `badge ${slotClass}`;
  $('slotBadge').innerHTML = `<span class="dot ${slotClass === 'green' ? 'live' : slotClass === 'warn' ? 'busy' : 'reserved'}"></span>${slotText}`;

  // Presença
  $('presenceHost').textContent = presence.host ? 'online' : 'offline';
  $('presenceViewer').textContent = presence.viewer ? 'conectado' : '—';
  $('presenceBridge').textContent = presence.bridge ? 'online' : '—';
  $('presenceAdmins').textContent = String(presence.admins ?? 0);

  // Contadores
  $('counterSessions').textContent = String(counters.sessionsTotal ?? 0);
  $('counterHours').textContent = `${counters.hoursSold ?? 0}h`;
  $('counterRevenue').textContent = brl(counters.revenueCents ?? 0);

  // Sessão
  const active = session && ['provisioning', 'active'].includes(session.status);
  $('sessionBadgeText').textContent = session
    ? session.status === 'active' ? 'ativa' : session.status === 'provisioning' ? 'provisionando' : 'encerrada'
    : 'livre';
  $('sessionBadge').className = `badge ${active ? 'green' : ''}`;
  $('sessionBadge').innerHTML = `<span class="dot ${active ? 'live' : ''}"></span>`
    + (session ? (session.status === 'active' ? 'ativa' : session.status === 'provisioning' ? 'provisionando' : 'encerrada') : 'livre');

  $('sessionHours').textContent = session ? `${session.hoursPurchased}h` : '—';
  $('sessionRevenue').textContent = session ? brl(session.amountCentsTotal) : '—';
  $('sessionCustomer').textContent = session?.customer?.name ?? '—';
  $('sessionPhone').innerHTML = session?.customer?.phone
    ? `<a class="wa-link" href="https://wa.me/55${esc(session.customer.phone)}" target="_blank" rel="noreferrer">${esc(phoneMask(session.customer.phone))}</a>`
    : '—';
  $('sessionStart').textContent = session?.startedAt ? fmtDateTime(session.startedAt) : '—';
  $('sessionEnd').textContent = session?.endsAt ? fmtDateTime(session.endsAt) : '—';
  $('sessionViewer').textContent = session ? (session.viewerConnected ? 'sim' : 'não') : '—';
  $('sessionStream').textContent = session ? (session.streamReady ? 'sim' : 'não') : '—';
  $('sessionNext').textContent = session ? brl(session.nextHourCents) : '—';
  $('sessionStatus').textContent = session?.status ?? '—';

  const openPlay = $('btnOpenPlay');
  if (session?.playUrl) {
    openPlay.href = session.playUrl;
    openPlay.classList.remove('hidden');
  } else {
    openPlay.removeAttribute('href');
    openPlay.classList.add('hidden');
  }

  document.querySelectorAll('#sessionActions [data-action="extend"]').forEach((btn) => {
    btn.disabled = !active || (session?.hoursPurchased ?? 0) >= (config.maxHours ?? 4);
  });
  document.querySelectorAll('#sessionActions [data-action="end_session"], #sessionActions [data-action="forfeit"]')
    .forEach((btn) => { btn.disabled = !active; });

  // Fila
  $('queueCount').textContent = String(queue.length);
  $('queueList').innerHTML = queue.length
    ? queue.map((entry, index) => `
        <div class="list-item">
          <span class="idx">${index + 1}</span>
          <div class="main">
            <strong>${esc(entry.name)}</strong>
            <small>
              <a class="wa-link" href="https://wa.me/55${esc(entry.phone)}" target="_blank" rel="noreferrer">${esc(phoneMask(entry.phone))}</a>
              · ${entry.status === 'notified'
                ? `notificado · expira em <span class="timer" data-hold="${entry.holdUntil}">—</span>`
                : `entrou ${fmtTime(entry.joinedAt)}`}
            </small>
          </div>
          <button class="btn btn-ghost btn-sm" data-action="remove_queue" data-id="${esc(entry.id)}">remover</button>
        </div>`).join('')
    : '<p class="tiny muted" style="margin: 0;">Ninguém na fila.</p>';

  // Pedidos
  $('ordersBody').innerHTML = orders.length
    ? orders.map((order) => `
        <tr>
          <td class="mono muted">${fmtTime(order.createdAt)}</td>
          <td>${order.kind === 'new' ? 'pacote' : 'hora extra'}</td>
          <td>${order.hours}h</td>
          <td>${order.amountLabel}</td>
          <td>
            <span class="badge ${statusClass(order.status)}">${order.status}</span>
            ${order.needsAttention ? `<span class="badge danger" title="${esc(order.attentionReason ?? '')}">!</span>` : ''}
          </td>
          <td>
            ${esc(order.name)}
            <div class="tiny muted">${esc(phoneMask(order.phone))}</div>
          </td>
          <td>
            ${order.status === 'pending'
              ? `<button class="btn btn-ghost btn-sm" data-action="cancel_order" data-id="${esc(order.id)}">cancelar</button>`
              : ''}
            ${order.status === 'paid'
              ? `<button class="btn btn-ghost btn-sm" data-action="refund_order" data-id="${esc(order.id)}">estornar</button>` : ''}
            ${order.needsAttention && order.status === 'paid'
              ? `<button class="btn btn-ghost btn-sm" data-action="reprocess_order" data-id="${esc(order.id)}">reprocessar</button>` : ''}
          </td>
        </tr>`).join('')
    : '<tr><td colspan="7" class="muted">Nenhum pedido ainda.</td></tr>';

  // Eventos
  const newEvents = events.filter((entry) => entry.at > lastEventAt);
  if (newEvents.length && lastEventAt) {
    const latest = newEvents[0];
    if (['order.paid', 'session.created', 'session.ended', 'queue.notified', 'order.orphan'].includes(latest.type)) {
      toast(eventLabel(latest.type), latest.level === 'error' ? 'danger' : latest.level === 'warn' ? 'warn' : 'green');
    }
  }
  if (events.length) lastEventAt = Math.max(lastEventAt, events[0].at);

  $('eventsBadge').textContent = String(events.length);
  $('eventLog').innerHTML = events.map((entry) => `
    <div class="entry ${esc(entry.level)}">
      <time>${new Date(entry.at).toLocaleTimeString('pt-BR')}</time>
      <span class="type">${esc(entry.type)}</span>
      <span class="detail" title="${esc(JSON.stringify(entry.detail ?? {}))}">${esc(JSON.stringify(entry.detail ?? {}))}</span>
    </div>`).join('');

  // Config
  $('configLine').textContent = [
    `pagamento: ${overview.paymentMode}`,
    `máx ${config.maxHours}h`,
    `pix ${Math.round(config.paymentTtlSec / 60)} min`,
    `fila ${Math.round(config.queueHoldSec / 60)} min`,
    config.xboxPowerConfigured ? 'energia do Xbox ok' : 'energia do Xbox não configurada',
  ].join(' · ');

  updateClocks();
}

function statusClass(status) {
  if (status === 'paid') return 'green';
  if (status === 'pending') return 'purple';
  if (status === 'expired' || status === 'canceled') return 'warn';
  if (status === 'refunded') return 'danger';
  return '';
}

function eventLabel(type) {
  return {
    'order.paid': 'Novo pagamento confirmado.',
    'session.created': 'Nova sessão criada.',
    'session.ended': 'Sessão encerrada.',
    'queue.notified': 'Próximo da fila chamado.',
    'order.orphan': 'Pagamento precisa de atenção (sem slot).',
  }[type] ?? type;
}

function updateClocks() {
  if (!overview?.session?.endsAt) {
    $('sessionClock').textContent = overview?.session ? '—' : '—';
  } else {
    const left = remainingFrom(overview.session.endsAt);
    $('sessionClock').textContent = overview.session.status === 'active' ? fmtClock(left) : '—';
    $('sessionClock').classList.toggle('warn', left <= 5 * 60_000 && left > 60_000);
    $('sessionClock').classList.toggle('danger', left <= 60_000 && left > 0);
  }

  document.querySelectorAll('[data-hold]').forEach((node) => {
    const until = Number(node.getAttribute('data-hold'));
    node.textContent = fmtClock(remainingFrom(until));
  });
}

/* ------------------------------------------------------------------ */
/* Ações                                                              */
/* ------------------------------------------------------------------ */

const confirmations = {
  end_session: 'Encerrar a sessão agora? O cliente perde o tempo restante.',
  forfeit: 'Marcar como desistência? Sem devolução e o slot abre na hora.',
  clear_queue: 'Limpar toda a fila?',
  reset_session_state: 'Reset de emergência: encerra a sessão, cancela Pix abertos e libera a máquina. Continuar?',
  release_slot: 'Cancelar todos os Pix abertos e liberar o slot?',
  refund_run: 'Estornar este pagamento? Se for o pacote inicial, a sessão será encerrada.',
};

async function handleAction(btn) {
  const action = btn.dataset.action;

  if (action === 'reload') {
    await load();
    toast('Atualizado.', 'green', 1500);
    return;
  }

  if (action === 'refund_order') {
    if (!confirm(confirmations.refund_run)) return;
    btn.disabled = true;
    try {
      await api('/api/admin/action', {
        method: 'POST',
        body: { action: 'refund_order', orderID: btn.dataset.id },
      });
      toast('Estorno solicitado.', 'green');
      await load(true);
    } catch (err) {
      toast(err.message, 'danger');
    } finally {
      btn.disabled = false;
    }
    return;
  }

  if (action === 'cancel_order') {
    btn.disabled = true;
    try {
      await api(`/api/orders/${btn.dataset.id}/cancel`, { method: 'POST' });
      toast('Pedido cancelado.', 'green');
      await load(true);
    } catch (err) {
      toast(err.message, 'danger');
      btn.disabled = false;
    }
    return;
  }

  if (action === 'remove_queue') {
    btn.disabled = true;
    try {
      await api('/api/admin/action', {
        method: 'POST',
        body: { action: 'remove_queue', id: btn.dataset.id },
      });
      await load(true);
    } catch (err) {
      toast(err.message, 'danger');
    }
    return;
  }

  if (action === 'reprocess_order') {
    btn.disabled = true;
    try {
      await api('/api/admin/action', {
        method: 'POST',
        body: { action: 'reprocess_order', orderID: btn.dataset.id },
      });
      toast('Pedido reprocessado.', 'green');
      await load(true);
    } catch (err) {
      toast(err.message, 'danger');
      btn.disabled = false;
    }
    return;
  }

  if (action === 'extend') {
    const hours = Number(btn.dataset.hours);
    if (!confirm(`Adicionar ${hours}h de cortesia nesta sessão?`)) return;
    btn.disabled = true;
    try {
      await api('/api/admin/action', { method: 'POST', body: { action: 'extend', hours } });
      toast(`+${hours}h aplicado.`, 'green');
      await load(true);
    } catch (err) {
      toast(err.message, 'danger');
    } finally {
      btn.disabled = false;
    }
    return;
  }

  if (action === 'xbox_power') {
    btn.disabled = true;
    try {
      const result = await api('/api/admin/action', {
        method: 'POST',
        body: { action: 'xbox_power', mode: btn.dataset.mode },
      });
      toast(result.ok ? `Comando executado (${btn.dataset.mode}).` : 'Comando falhou. Veja o log.', result.ok ? 'green' : 'danger');
      await load(true);
    } catch (err) {
      toast(err.message, 'danger');
    } finally {
      btn.disabled = false;
    }
    return;
  }

  if (action === 'clear_queue' && !confirm(confirmations.clear_queue)) return;
  if (confirmations[action] && !confirm(confirmations[action])) return;

  btn.disabled = true;
  try {
    await api('/api/admin/action', { method: 'POST', body: { action } });
    toast('Feito.', 'green');
    await load(true);
  } catch (err) {
    toast(err.message, 'danger');
  } finally {
    btn.disabled = false;
  }
}

/* impressão de emergência no console para depuração */
window.__xpAdmin = () => overview;
