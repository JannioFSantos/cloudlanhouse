import {
  api,
  brl,
  fmtClock,
  fmtTime,
  esc,
  toast,
  copyText,
  phoneMask,
  remainingFrom,
  setServerNow,
  serverNow,
  show,
} from './common.js';

const HOURLY = [700, 600, 500, 400];

const state = {
  config: null,
  status: null,
  hours: 1,
  customer: { name: '', phone: '' },
  queueEntry: null,
  order: null,
  busy: false,
  lastStatusSig: '',
  lastQueueSig: '',
  lastOrderSig: '',
};

const app = () => document.getElementById('app');
const sum = (n) => HOURLY.slice(0, n).reduce((a, b) => a + b, 0);

/* ------------------------------------------------------------------ */
/* Boot                                                               */
/* ------------------------------------------------------------------ */

async function boot() {
  document.getElementById('priceTable').innerHTML = HOURLY.map((cents, i) => {
    const acumulado = HOURLY.slice(0, i + 1).reduce((a, b) => a + b, 0);
    return `
      <div class="card tight price-line">
        <div>
          <div class="hour">${i + 1}ª hora</div>
          <div class="muted tiny">pacote de ${i + 1}h: ${brl(acumulado)}</div>
        </div>
        <div class="value">${brl(cents)}</div>
      </div>`;
  }).join('');

  try {
    const [config, status] = await Promise.all([api('/api/config'), api('/api/status')]);
    state.config = config;
    setServerNow(status.serverNow);
    state.status = status;
    document.getElementById('footerMode').textContent = config.paymentMode === 'mock'
      ? 'Pagamento em modo de teste (simulador)'
      : 'Pagamento: Pix via Mercado Pago';

    restoreCustomer();
    await resumeQueue();
    await resumeOrder();
  } catch (err) {
    toast(err.message || 'Falha ao carregar o site.', 'danger');
  }

  render();
  setInterval(tick, 1000);
  setInterval(poll, 3000);
}

function restoreCustomer() {
  try {
    const saved = JSON.parse(localStorage.getItem('xp_customer') || '{}');
    state.customer.name = saved.name || '';
    state.customer.phone = saved.phone || '';
  } catch {
    /* ignore */
  }
}

function saveCustomer() {
  localStorage.setItem('xp_customer', JSON.stringify(state.customer));
}

async function resumeQueue() {
  const id = localStorage.getItem('xp_queue');
  if (!id) return;
  try {
    const entry = await api(`/api/queue/${encodeURIComponent(id)}`);
    if (['waiting', 'notified'].includes(entry.status)) {
      state.queueEntry = entry;
    } else {
      localStorage.removeItem('xp_queue');
    }
  } catch {
    localStorage.removeItem('xp_queue');
  }
}

async function resumeOrder() {
  const id = localStorage.getItem('xp_order');
  if (!id) return;
  try {
    const order = await api(`/api/orders/${encodeURIComponent(id)}`);
    const refundedAtStart = order.status === 'refunded' && order.refundReason === 'provision_timeout';
    if (order.status === 'pending' || refundedAtStart) {
      state.order = order;
    } else if (order.status === 'paid' && isSessionLive(order.session)) {
      state.order = order;
    } else {
      localStorage.removeItem('xp_order');
    }
  } catch {
    localStorage.removeItem('xp_order');
  }
}

/* ------------------------------------------------------------------ */
/* Fase + render                                                      */
/* ------------------------------------------------------------------ */

function phase() {
  // O host não subiu a transmissão a tempo: o pagamento é estornado sozinho.
  if (state.order && (state.order.status === 'refunded' || state.order.refundPending)) return 'refunded';
  if (state.order?.status === 'paid' && isSessionLive(state.order.session)) return 'done';
  if (state.order && state.order.status === 'pending') return 'checkout';
  if (state.order && state.order.status === 'expired') return 'checkout';

  const entry = state.queueEntry;
  if (entry?.canBuyNow) return 'buy';
  if (entry && entry.status === 'waiting') return 'queue';

  const slot = state.status?.slot?.status ?? 'free';
  if (slot === 'free') return 'buy';
  if (slot === 'held') return entry ? 'buy' : 'blocked';
  return 'blocked';
}

function isSessionLive(session) {
  return ['provisioning', 'active'].includes(session?.status);
}

function render() {
  const current = phase();
  updateTopBadge();

  if (current === 'buy') app().innerHTML = renderBuy();
  else if (current === 'queue') app().innerHTML = renderQueue();
  else if (current === 'checkout') app().innerHTML = renderCheckout();
  else if (current === 'done') app().innerHTML = renderDone();
  else if (current === 'refunded') app().innerHTML = renderRefunded();
  else app().innerHTML = renderBlocked();

  bind(current);
  updateClocks();
}

function renderTopBadge() {
  const slot = state.status?.slot;
  const session = state.status?.session;
  if (!slot) return { cls: '', text: 'carregando…' };
  if (slot.status === 'busy') {
    const until = session?.endsAt ? ` até ${fmtTime(session.endsAt)}` : '';
    return { cls: 'busy', text: `Em uso${until}` };
  }
  if (slot.status === 'reserved') return { cls: 'purple', text: 'Pagamento em andamento' };
  if (slot.status === 'held') return { cls: 'purple', text: 'Fila liberada' };
  if (isOffline()) return { cls: 'busy', text: 'offline no momento' };
  return { cls: 'live', text: 'livre agora' };
}

/** O PC do jogo (host/ponte) não está pronto: o servidor recusa novas compras. */
function isOffline() {
  const a = state.status?.availability;
  return Boolean(a) && !a.ready;
}

function offlineMessage() {
  const reason = state.status?.availability?.reason;
  return reason === 'bridge_offline'
    ? 'O controle remoto da máquina está offline.'
    : 'O computador do jogo está offline.';
}

function updateTopBadge() {
  const info = renderTopBadge();
  const badge = document.getElementById('topBadge');
  const dot = badge?.querySelector('.dot');
  if (!badge) return;
  dot.className = `dot ${info.cls}`;
  document.getElementById('topBadgeText').textContent = info.text;
}

/* ------------------------------- buy -------------------------------- */

function renderBuy() {
  const entry = state.queueEntry;
  const heldByMe = Boolean(entry?.canBuyNow);
  const total = sum(state.hours);
  const name = esc(state.customer.name);
  const phone = esc(phoneMask(state.customer.phone));
  const offline = isOffline();

  return `
    <div class="hero">
      <div>
        <div class="eyebrow"><span class="dot ${offline ? 'busy' : heldByMe ? 'reserved' : 'live'}"></span>
          ${offline ? 'indisponível no momento' : heldByMe ? 'sua vez na fila' : 'disponível agora'}
        </div>
        <h1>Jogue <em>Xbox Series S ou PC</em><br />direto no navegador.</h1>
        <p class="lede">
          Sem instalar nada, sem criar conta. Pague no Pix, abra o link e jogue no console ou no PC com
          seu controle. A primeira hora custa R$ 7 e cada hora seguinte sai R$ 1 mais barata.
        </p>

        <div class="grid-3">
          <div class="stat"><div class="k">1ª hora</div><div class="v">R$ 7</div></div>
          <div class="stat"><div class="k">Hora extra</div><div class="v">−R$ 1</div></div>
          <div class="stat"><div class="k">Limite</div><div class="v">4 horas</div></div>
        </div>

        ${offline ? `
          <div class="alert warn mt-4">
            <strong>${offlineMessage()}</strong>
            As vendas estão pausadas para você não pagar sem conseguir jogar.
            Esta página atualiza sozinha quando voltar.
          </div>` : ''}

        ${heldByMe ? `
          <div class="alert green mt-4">
            <strong>É a sua vez.</strong> Finalize o pagamento em
            <span class="countdown-inline" data-ends="${entry.holdUntil}">—</span>
            ou a vez passa para o próximo da fila.
          </div>` : `
          <div class="alert purple mt-4">
            <strong>Como o relógio funciona:</strong> ele começa quando a transmissão fica pronta
            e <strong>não pausa</strong> se você sair. Pode voltar pelo mesmo link até o tempo acabar.
            Desistir encerra a sessão na hora, sem devolução, e libera o Xbox para outra pessoa.
          </div>`}
      </div>

      <div class="card">
        <div class="card-head">
          <h2>Reservar agora</h2>
          ${offline
            ? '<span class="badge warn"><span class="dot busy"></span> offline</span>'
            : '<span class="badge green"><span class="dot live"></span> livre</span>'}
        </div>

        <form id="buyForm" class="stack">
          <div class="field">
            <label>Quanto tempo?</label>
            <div class="hours-grid" id="hoursGrid">
              ${HOURLY.map((_, i) => `
                <button type="button" class="hour-opt ${state.hours === i + 1 ? 'selected' : ''}" data-hours="${i + 1}">
                  <strong>${i + 1}h</strong>
                  <span>${brl(sum(i + 1))}</span>
                </button>`).join('')}
            </div>
          </div>

          <div class="price-table" id="breakdown">${breakdownHtml()}</div>

          <div class="total-line">
            <div>
              <div class="big" id="totalValue">${brl(total)}</div>
              <div class="sub" id="totalSub">${state.hours}h de jogo · Pix</div>
            </div>
            <span class="badge">${state.config?.paymentMode === 'mock' ? 'modo teste' : 'pix'}</span>
          </div>

          <div class="field">
            <label for="buyName">Seu nome</label>
            <input id="buyName" name="name" autocomplete="name" maxlength="60"
                   placeholder="Como podemos te chamar" value="${name}" required />
          </div>

          <div class="field">
            <label for="buyPhone">WhatsApp</label>
            <input id="buyPhone" name="phone" autocomplete="tel" inputmode="tel" maxlength="16"
                   placeholder="(11) 99999-9999" value="${phone}" required />
          </div>

          <button class="btn btn-primary btn-lg btn-block" type="submit" id="buyBtn" ${state.busy || offline ? 'disabled' : ''}>
            ${state.busy ? 'Gerando Pix…' : offline ? 'Indisponível no momento' : `Pagar ${brl(total)} com Pix`}
          </button>
          <p class="tiny muted center mb-0">
            O Pix reserva o Xbox por 15 minutos. Se não for pago, a reserva expira sozinha.
          </p>
        </form>
      </div>
    </div>`;
}

function breakdownHtml() {
  return HOURLY.map((cents, i) => {
    const active = i < state.hours;
    return `
      <div class="price-line ${active ? 'active' : ''}">
        <span class="hour">${i + 1}ª hora ${active ? '' : '<span class="tiny">(não incluída)</span>'}</span>
        <span class="value">${brl(cents)}</span>
      </div>`;
  }).join('');
}

/* ------------------------------ blocked ----------------------------- */

function renderBlocked() {
  const slot = state.status?.slot;
  const session = state.status?.session;
  const entry = state.queueEntry;

  const endsAt = session?.endsAt ?? slot?.until ?? null;
  const freeAt = endsAt ? fmtTime(endsAt) : '—';
  const inUse = slot?.status === 'busy';

  return `
    <div class="hero">
      <div>
        <div class="eyebrow"><span class="dot ${inUse ? 'busy' : 'reserved'}"></span>
          ${inUse ? 'xbox em uso' : slot?.status === 'held' ? 'fila em andamento' : 'pagamento em andamento'}
        </div>
        <h1>${inUse ? 'O Xbox está <em>em uso</em> agora.' : 'Quase livre.'}</h1>
        <p class="lede">
          ${inUse
            ? `A sessão atual termina às <strong>${freeAt}</strong>. Entre na fila e a
               gente te chama aqui quando liberar.`
            : slot?.status === 'held'
              ? 'Alguém da fila foi chamado e está finalizando o pagamento. Se não pagar no prazo, a vez passa para o próximo.'
              : 'Alguém está finalizando um Pix. A reserva expira em poucos minutos.'}
        </p>

        <div class="card tight">
          <div class="card-head" style="margin-bottom: 10px;">
            <h3>${inUse ? 'Sessão atual' : 'Reserva atual'}</h3>
            <span class="badge ${inUse ? 'warn' : 'purple'}">
              ${inUse ? 'em jogo' : 'aguardando pagamento'}
            </span>
          </div>
          <div class="kv">
            <span class="k">${inUse ? 'Termina às' : 'Expira às'}</span>
            <span class="v">${freeAt}</span>
          </div>
          <div class="kv">
            <span class="k">Tempo restante</span>
            <span class="v timer" data-ends="${endsAt ?? 0}">—</span>
          </div>
          ${inUse && session ? `
          <div class="kv">
            <span class="k">Pacote</span>
            <span class="v">${session.hoursPurchased}h${session.hoursPurchased >= 4 ? ' (máximo)' : ''}</span>
          </div>` : ''}
          <div class="kv">
            <span class="k">Na fila</span>
            <span class="v">${state.status?.queue?.waiting ?? 0} pessoa(s)</span>
          </div>
        </div>
      </div>

      <div class="card">
        ${entry ? `
          <div class="card-head">
            <h2>Você está na fila</h2>
            <span class="badge purple">${entry.status === 'notified' ? 'sua vez' : 'aguardando'}</span>
          </div>
          <div class="center" style="padding: 10px 0 18px;">
            <div class="timer xl">${entry.position ? `${entry.position}º` : '—'}</div>
            <p class="muted tiny mb-0">
              ${entry.waitAhead > 0 ? `${entry.waitAhead} pessoa(s) na sua frente` : 'Você é o próximo'}
            </p>
          </div>
          <div class="alert">
            Mantenha esta página aberta. Quando o Xbox liberar, você tem
            <strong>${Math.round((state.config?.rules?.queueHoldSec ?? 300) / 60)} minutos</strong>
            para pagar antes de a vez passar para o próximo.
          </div>
          <button class="btn btn-ghost btn-block mt-4" id="leaveQueue">Sair da fila</button>
        ` : `
          <div class="card-head"><h2>Entrar na fila</h2><span class="badge">grátis</span></div>
          <p class="tiny muted" style="margin-top: 0;">
            Avisamos aqui nesta tela. Não precisa pagar nada para entrar na fila.
          </p>
          <form id="queueForm" class="stack">
            <div class="field">
              <label for="qName">Seu nome</label>
              <input id="qName" name="name" maxlength="60" autocomplete="name"
                     placeholder="Como podemos te chamar" value="${esc(state.customer.name)}" required />
            </div>
            <div class="field">
              <label for="qPhone">WhatsApp</label>
              <input id="qPhone" name="phone" inputmode="tel" maxlength="16" autocomplete="tel"
                     placeholder="(11) 99999-9999" value="${esc(phoneMask(state.customer.phone))}" required />
            </div>
            <button class="btn btn-primary btn-block" type="submit" ${state.busy ? 'disabled' : ''}>
              ${state.busy ? 'Entrando…' : 'Entrar na fila'}
            </button>
          </form>
        `}
      </div>
    </div>`;
}

/* ------------------------------- queue ------------------------------ */

function renderQueue() {
  const entry = state.queueEntry;
  const endsAt = state.status?.session?.endsAt ?? null;
  return `
    <div class="hero">
      <div>
        <div class="eyebrow"><span class="dot busy"></span> na fila</div>
        <h1>Você é o <em>${entry.position ?? '—'}º</em> da fila.</h1>
        <p class="lede">
          Assim que o Xbox liberar, esta tela muda sozinha e você ganha alguns minutos
          para pagar o Pix antes de a vez passar para o próximo.
        </p>
        <div class="grid-3">
          <div class="stat"><div class="k">Sua posição</div><div class="v">${entry.position ?? '—'}º</div></div>
          <div class="stat"><div class="k">Na sua frente</div><div class="v">${entry.waitAhead ?? 0}</div></div>
          <div class="stat"><div class="k">Fila total</div><div class="v">${state.status?.queue?.waiting ?? 0}</div></div>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h2>Aguardando o Xbox</h2><span class="badge purple">fila</span></div>
        <p class="tiny muted">
          ${endsAt
            ? `Sessão atual termina às <strong>${fmtTime(endsAt)}</strong> — faltam
               <span class="timer" data-ends="${endsAt}">—</span>.`
            : 'Aguardando liberação.'}
        </p>
        <div class="alert">Não feche esta aba. Se sair da fila, perde a posição.</div>
        <button class="btn btn-ghost btn-block mt-4" id="leaveQueue">Sair da fila</button>
      </div>
    </div>`;
}

/* ----------------------------- checkout ----------------------------- */

function renderCheckout() {
  const order = state.order;
  if (!order) return renderBlocked();
  const expired = order.status === 'expired' || order.status === 'canceled' || order.expiresInMs <= 0;

  return `
    <div class="grid-2" style="align-items: start;">
      <div class="card">
        <div class="card-head">
          <h2>${expired ? 'Pix expirado' : 'Pague com Pix'}</h2>
          <span class="badge ${expired ? 'danger' : 'purple'}">${expired ? 'expirado' : 'aguardando'}</span>
        </div>

        ${expired ? `
          <div class="alert danger">
            O prazo deste Pix terminou. Nenhum valor foi cobrado. Se o Xbox ainda estiver livre,
            gere um novo pagamento.
          </div>
          <button class="btn btn-primary btn-block mt-4" id="retryOrder">Gerar novo Pix</button>
        ` : `
          ${order.qrCodeBase64
            ? `<div class="qr-box"><img alt="QR Code Pix" src="data:image/png;base64,${order.qrCodeBase64}" /></div>`
            : `<div class="qr-box" style="background: #101018; border: 1px dashed var(--line-strong);">
                 <div class="center tiny muted">Modo teste<br/>sem QR real</div>
               </div>`}

          <p class="tiny muted center" style="margin: 14px 0 8px;">
            Escaneie o QR ou use o Pix copia e cola
          </p>
          <div class="pix-code" id="pixCode">${esc(order.qrCode ?? '')}</div>
          <button class="btn btn-ghost btn-block mt-4" id="copyPix">Copiar código Pix</button>

          <div class="alert warn mt-4 center">
            Expira em <span class="countdown-inline timer" data-ends="${order.expiresAt}">—</span>
          </div>

          ${order.paymentMode === 'mock' ? `
            <button class="btn btn-primary btn-block mt-4" id="mockPay">Simular pagamento aprovado</button>
            <p class="tiny muted center mb-0" style="margin-top: 10px;">
              Modo de teste: nenhum dinheiro é cobrado.
            </p>` : `
            <p class="tiny muted center" style="margin-top: 14px;">
              A tela muda sozinha quando o Pix for confirmado.
            </p>`}

          <button class="btn btn-ghost btn-block mt-4" id="cancelOrder">Cancelar e liberar o Xbox</button>
        `}
      </div>

      <div class="card">
        <div class="card-head"><h2>Resumo</h2><span class="badge">pedido ${esc(order.id.slice(-6))}</span></div>
        <div class="price-table">
          ${(order.breakdown ?? []).map((b) => `
            <div class="price-line active">
              <span class="hour">${b.hourNumber}ª hora</span>
              <span class="value">${brl(b.cents)}</span>
            </div>`).join('')}
        </div>
        <div class="total-line">
          <div>
            <div class="big">${brl(order.amountCents)}</div>
            <div class="sub">${order.hours}h de jogo</div>
          </div>
          <span class="badge green">Pix</span>
        </div>

        <div class="divider"></div>
        <div class="kv"><span class="k">Nome</span><span class="v">${esc(state.customer.name)}</span></div>
        <div class="kv"><span class="k">WhatsApp</span><span class="v">${esc(phoneMask(state.customer.phone))}</span></div>
        <div class="kv"><span class="k">Regra de tempo</span><span class="v">não pausa</span></div>
        <div class="kv"><span class="k">Máximo por sessão</span><span class="v">4 horas</span></div>

        <div class="alert mt-4">
          O relógio só começa quando a transmissão fica pronta. Depois disso, ele conta
          mesmo que você feche a aba.
        </div>
      </div>
    </div>`;
}

/* ------------------------------- refunded --------------------------- */

function renderRefunded() {
  const order = state.order;
  const done = order?.status === 'refunded';
  const failed = !done && order?.needsAttention;

  return `
    <div style="max-width: 680px; margin: 10px auto 0;">
      <div class="card center">
        <span class="badge ${done ? 'green' : 'warn'}">
          ${done ? 'pagamento estornado' : 'estornando pagamento'}
        </span>
        <h1 style="font-size: clamp(28px, 5vw, 40px); margin: 18px 0 10px;">
          Não conseguimos iniciar sua <em>sessão</em>.
        </h1>
        <p class="lede" style="margin: 0 auto 22px; text-align: center;">
          A transmissão não ficou pronta a tempo, então o seu relógio nem chegou a começar.
          ${done
            ? `Devolvemos os <strong>${brl(order.amountCents)}</strong> para a conta que pagou o Pix.`
            : failed
              ? `O estorno automático falhou. Guarde o número do pedido <strong>${esc(order.id)}</strong> e chame o operador: ele devolve o valor manualmente.`
              : 'Estamos devolvendo o valor automaticamente. Isso leva alguns instantes.'}
        </p>
        ${done ? '<button class="btn btn-primary btn-lg" id="backHome">Voltar ao início</button>' : ''}
      </div>
    </div>`;
}

/* -------------------------------- done ------------------------------ */

function renderDone() {
  const order = state.order;
  const session = order?.session;
  const playUrl = session?.playUrl;
  const endsAt = session?.endsAt ?? null;
  const preparing = session && session.status === 'provisioning';

  return `
    <div style="max-width: 680px; margin: 10px auto 0;">
      <div class="card center">
        <span class="badge green"><span class="dot live"></span> pagamento aprovado</span>
        <h1 style="font-size: clamp(30px, 5vw, 44px); margin: 18px 0 10px;">
          ${preparing ? 'Preparando seu <em>Xbox</em>.' : 'Seu <em>Xbox</em> está pronto.'}
        </h1>
        <p class="lede" style="margin: 0 auto 22px; text-align: center;">
          ${preparing
            ? 'A transmissão está subindo. Isso costuma levar de 20 a 90 segundos. O relógio começa assim que a tela aparecer.'
            : 'Abra o player, conecte seu controle e bom jogo. O tempo já está correndo.'}
        </p>

        ${playUrl
          ? `<a class="btn btn-primary btn-lg" href="${esc(playUrl)}" id="playLink">Entrar no jogo</a>`
          : `<div class="alert warn">Aguardando a transmissão subir. Atualize esta página em alguns segundos.</div>`}

        <div class="divider"></div>

        <div class="grid-2" style="text-align: left;">
          <div class="kv"><span class="k">Pacote</span><span class="v">${order.hours} hora(s)</span></div>
          <div class="kv"><span class="k">Valor pago</span><span class="v">${brl(order.amountCents)}</span></div>
          <div class="kv"><span class="k">Termina às</span><span class="v">${endsAt ? fmtTime(endsAt) : '—'}</span></div>
          <div class="kv"><span class="k">Tempo restante</span>
            <span class="v timer" data-ends="${endsAt ?? 0}">—</span></div>
        </div>

        <p class="tiny muted mt-4 mb-0">
          Guarde este link: se você fechar a aba, é por ele que você volta.
          Se perder, use o botão abaixo para abrir de novo com o mesmo pedido.
        </p>
        <button class="btn btn-ghost btn-sm mt-4" id="refreshDone">Atualizar status</button>
      </div>
    </div>`;
}

/* ------------------------------------------------------------------ */
/* Bind                                                               */
/* ------------------------------------------------------------------ */

function bind(current) {
  if (current === 'buy') {
    document.querySelectorAll('.hour-opt').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.hours = Number(btn.dataset.hours);
        document.querySelectorAll('.hour-opt').forEach((b) => {
          b.classList.toggle('selected', Number(b.dataset.hours) === state.hours);
        });
        const bd = document.getElementById('breakdown');
        if (bd) bd.innerHTML = breakdownHtml();
        const tv = document.getElementById('totalValue');
        if (tv) tv.textContent = brl(sum(state.hours));
        const ts = document.getElementById('totalSub');
        if (ts) ts.textContent = `${state.hours}h de jogo · Pix`;
        const bb = document.getElementById('buyBtn');
        if (bb && !isOffline()) bb.textContent = state.busy ? 'Gerando Pix…' : `Pagar ${brl(sum(state.hours))} com Pix`;
      });
    });

    const nameInput = document.getElementById('buyName');
    const phoneInput = document.getElementById('buyPhone');
    nameInput?.addEventListener('input', () => {
      state.customer.name = nameInput.value;
      saveCustomer();
    });
    phoneInput?.addEventListener('input', () => {
      const masked = phoneMask(phoneInput.value);
      phoneInput.value = masked;
      state.customer.phone = masked.replace(/\D+/g, '');
      saveCustomer();
    });

    document.getElementById('buyForm')?.addEventListener('submit', submitBuy);
  }

  if (current === 'blocked' && !state.queueEntry) {
    const nameInput = document.getElementById('qName');
    const phoneInput = document.getElementById('qPhone');
    nameInput?.addEventListener('input', () => {
      state.customer.name = nameInput.value;
      saveCustomer();
    });
    phoneInput?.addEventListener('input', () => {
      const masked = phoneMask(phoneInput.value);
      phoneInput.value = masked;
      state.customer.phone = masked.replace(/\D+/g, '');
      saveCustomer();
    });
    document.getElementById('queueForm')?.addEventListener('submit', submitQueue);
  }

  document.getElementById('leaveQueue')?.addEventListener('click', leaveQueue);

  if (current === 'checkout') {
    document.getElementById('copyPix')?.addEventListener('click', async () => {
      const code = state.order?.qrCode ?? '';
      if (!code) return;
      const ok = await copyText(code);
      toast(ok ? 'Código Pix copiado.' : 'Não foi possível copiar. Selecione o texto manualmente.', ok ? 'green' : 'warn');
    });

    document.getElementById('mockPay')?.addEventListener('click', async (e) => {
      e.currentTarget.disabled = true;
      try {
        await api(`/api/orders/${state.order.id}/mock-pay`, { method: 'POST' });
        await pollOrder();
      } catch (err) {
        toast(err.message, 'danger');
        e.currentTarget.disabled = false;
      }
    });

    document.getElementById('cancelOrder')?.addEventListener('click', async () => {
      try {
        await api(`/api/orders/${state.order.id}/cancel`, { method: 'POST' });
      } catch {
        /* segue */
      }
      clearOrder();
      toast('Reserva cancelada. O Xbox está livre.', 'green');
      await refreshStatus();
      render();
    });

    document.getElementById('retryOrder')?.addEventListener('click', () => {
      clearOrder();
      render();
    });
  }

  if (current === 'refunded') {
    document.getElementById('backHome')?.addEventListener('click', async () => {
      clearOrder();
      await refreshStatus();
      render();
    });
  }

  if (current === 'done') {
    document.getElementById('refreshDone')?.addEventListener('click', async () => {
      await pollOrder();
      toast('Status atualizado.');
    });
    const link = document.getElementById('playLink');
    if (link) localStorage.setItem('xp_play', link.getAttribute('href'));
  }
}

/* ------------------------------------------------------------------ */
/* Ações                                                              */
/* ------------------------------------------------------------------ */

async function submitBuy(event) {
  event.preventDefault();
  if (state.busy) return;
  if (isOffline()) return toast(`${offlineMessage()} Tente de novo em alguns minutos.`, 'warn');

  const name = document.getElementById('buyName')?.value ?? '';
  const phone = document.getElementById('buyPhone')?.value ?? '';
  if (name.trim().length < 2) return toast('Informe seu nome.', 'warn');
  if (phone.replace(/\D+/g, '').length < 10) return toast('Informe um WhatsApp com DDD.', 'warn');

  state.customer.name = name.trim();
  state.customer.phone = phone.replace(/\D+/g, '');
  saveCustomer();

  state.busy = true;
  render();

  try {
    const order = await api('/api/orders', {
      method: 'POST',
      body: {
        hours: state.hours,
        name: state.customer.name,
        phone: state.customer.phone,
        queueID: state.queueEntry?.canBuyNow ? state.queueEntry.id : undefined,
      },
    });
    state.order = order;
    state.queueEntry = null;
    localStorage.removeItem('xp_queue');
    localStorage.setItem('xp_order', order.id);
    setServerNow(order.serverNow ?? serverNow());
    toast('Pix gerado. Finalize o pagamento.', 'green');
  } catch (err) {
    const soft = ['slot_busy', 'slot_reserved', 'machine_offline'].includes(err.code);
    toast(err.message, soft ? 'warn' : 'danger');
    await refreshStatus();
  } finally {
    state.busy = false;
    render();
  }
}

async function submitQueue(event) {
  event.preventDefault();
  if (state.busy) return;

  const name = document.getElementById('qName')?.value ?? '';
  const phone = document.getElementById('qPhone')?.value ?? '';
  if (name.trim().length < 2) return toast('Informe seu nome.', 'warn');
  if (phone.replace(/\D+/g, '').length < 10) return toast('Informe um WhatsApp com DDD.', 'warn');

  state.customer.name = name.trim();
  state.customer.phone = phone.replace(/\D+/g, '');
  saveCustomer();
  state.busy = true;
  render();

  try {
    const result = await api('/api/queue', {
      method: 'POST',
      body: { name: state.customer.name, phone: state.customer.phone },
    });
    state.queueEntry = result.entry;
    localStorage.setItem('xp_queue', result.entry.id);
    toast('Você entrou na fila. Avisamos aqui quando liberar.', 'green');
  } catch (err) {
    if (err.code === 'slot_free') {
      toast('O Xbox acabou de liberar. Compre direto!', 'green');
    } else {
      toast(err.message, 'danger');
    }
    await refreshStatus();
  } finally {
    state.busy = false;
    render();
  }
}

async function leaveQueue() {
  const id = state.queueEntry?.id ?? localStorage.getItem('xp_queue');
  if (!id) return;
  try {
    await api(`/api/queue/${encodeURIComponent(id)}`, { method: 'DELETE' });
  } catch {
    /* segue */
  }
  state.queueEntry = null;
  localStorage.removeItem('xp_queue');
  await refreshStatus();
  render();
}

function clearOrder() {
  state.order = null;
  localStorage.removeItem('xp_order');
}

/* ------------------------------------------------------------------ */
/* Polling                                                            */
/* ------------------------------------------------------------------ */

let polling = false;

async function poll() {
  if (polling) return;
  polling = true;
  try {
    const current = phase();
    if (current === 'checkout') await pollOrder();
    else if (current === 'queue') await pollQueue();
    else if (current === 'buy' || current === 'blocked') await refreshStatus();
    else if (current === 'done') await pollOrder();
    else if (current === 'refunded' && state.order?.status !== 'refunded') await pollOrder();
  } catch {
    /* rede instável: tenta no próximo ciclo */
  } finally {
    polling = false;
  }
}

async function refreshStatus() {
  const status = await api('/api/status');
  setServerNow(status.serverNow);
  state.status = status;

  const sig = JSON.stringify({
    slot: status.slot,
    sessionStatus: status.session?.status,
    endsAt: status.session?.endsAt,
    waiting: status.queue?.waiting,
    ready: status.availability?.ready,
    reason: status.availability?.reason,
  });

  if (sig !== state.lastStatusSig) {
    state.lastStatusSig = sig;
    if (!['checkout', 'done', 'refunded'].includes(phase())) render();
    else updateTopBadge();
    updateClocks();
  }
}

async function pollQueue() {
  const id = state.queueEntry?.id;
  if (!id) return;
  try {
    const entry = await api(`/api/queue/${encodeURIComponent(id)}`);
    state.queueEntry = entry;

    if (entry.status === 'notified' && entry.canBuyNow) {
      await refreshStatus();
      toast('Sua vez! Pague em alguns minutos para garantir o Xbox.', 'green', 7000);
      render();
      return;
    }
    if (!['waiting', 'notified'].includes(entry.status)) {
      state.queueEntry = null;
      localStorage.removeItem('xp_queue');
      toast(entry.status === 'expired'
        ? 'Sua vez passou sem pagamento. Você pode entrar na fila de novo.'
        : 'Você saiu da fila.', 'warn');
      await refreshStatus();
      render();
      return;
    }

    const sig = `${entry.status}:${entry.position}:${entry.waitAhead}`;
    if (sig !== state.lastQueueSig) {
      state.lastQueueSig = sig;
      render();
    }
    updateClocks();
  } catch {
    /* 404 → volta ao estado normal no próximo refresh */
  }
}

async function pollOrder() {
  const id = state.order?.id ?? localStorage.getItem('xp_order');
  if (!id) return;
  try {
    const order = await api(`/api/orders/${encodeURIComponent(id)}`);
    setServerNow(order.serverNow ?? serverNow());
    const before = state.order?.status;
    state.order = order;

    if (order.status === 'paid' && !isSessionLive(order.session)) {
      clearOrder();
      await refreshStatus();
      render();
      return;
    }

    if (order.status === 'refunded' || order.refundPending) {
      localStorage.setItem('xp_order', order.id);
      const sig = `refund:${order.status}:${order.refundPending}:${order.needsAttention}`;
      if (sig !== state.lastOrderSig) {
        state.lastOrderSig = sig;
        render();
      }
      return;
    }

    if (order.status === 'paid') {
      localStorage.setItem('xp_order', order.id);
      const sig = `paid:${order.session?.status}:${order.session?.endsAt}`;
      if (order.session?.status === 'active' && before !== 'paid') {
        toast('Pagamento confirmado! Bom jogo.', 'green', 6000);
      }
      if (sig !== state.lastOrderSig) {
        state.lastOrderSig = sig;
        render();
      }
      updateClocks();
      return;
    }

    if (order.status === 'expired' || order.status === 'canceled') {
      if (before !== order.status) render();
      return;
    }

    updateClocks();
  } catch (err) {
    if (err.status === 404) {
      clearOrder();
      await refreshStatus();
      render();
    }
  }
}

/* ------------------------------------------------------------------ */
/* Relógios                                                           */
/* ------------------------------------------------------------------ */

function updateClocks() {
  document.querySelectorAll('[data-ends]').forEach((node) => {
    const endsAt = Number(node.getAttribute('data-ends'));
    if (!endsAt) {
      node.textContent = '—';
      return;
    }
    const left = remainingFrom(endsAt);
    node.textContent = fmtClock(left);
    if (node.classList.contains('timer')) {
      node.classList.toggle('warn', left > 0 && left <= 5 * 60_000);
      node.classList.toggle('danger', left > 0 && left <= 60_000);
    }
  });
}

function tick() {
  updateClocks();
  updateTopBadge();
}

boot();
