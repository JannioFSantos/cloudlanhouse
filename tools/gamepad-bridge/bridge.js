/**
 * Ponte de controle (bridge) — roda no PC host.
 *
 * Conecta no servidor como `bridge`, recebe os eventos de gamepad do cliente
 * e aplica em um controle Xbox 360 virtual (ViGEmBus) para o jogo no PC.
 *
 * Uso (na raiz do projeto):
 *   npm run bridge                 # controle virtual real (Windows + ViGEmBus)
 *   npm run bridge -- --dry-run    # só mostra o que seria aplicado
 *
 * Opções / variáveis de ambiente:
 *   --url / BRIDGE_URL      ws://localhost:8080/ws  (ou wss://seu-dominio.com/ws)
 *   --key / HOST_KEY        chave do host (padrão: lê data/host-key.txt)
 *   --python / BRIDGE_PYTHON  executável do Python (padrão: python no Windows)
 *   --dry-run / BRIDGE_DRY_RUN=1
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ALL_BUTTONS, isNeutral, mapPayload, neutralState, sameState } from './mapping.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

const WATCHDOG_MS = 3000; // o player reenvia ao menos 1x/s; sem sinal → solta tudo
const PING_MS = 20_000;
const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 10_000;

/* ------------------------------------------------------------------ */
/* Sinks: onde o estado do controle é aplicado                         */
/* ------------------------------------------------------------------ */

export function summarize(state) {
  const parts = [];
  if (state.buttons.length) parts.push(state.buttons.join('+'));
  if (state.lt) parts.push(`LT=${state.lt}`);
  if (state.rt) parts.push(`RT=${state.rt}`);
  if (state.lx || state.ly) parts.push(`L=(${state.lx},${state.ly})`);
  if (state.rx || state.ry) parts.push(`R=(${state.rx},${state.ry})`);
  return parts.length ? parts.join(' ') : 'neutro';
}

export function dryRunSink(log = console.log) {
  return {
    name: 'dry-run',
    async start() {},
    apply(state) {
      log(`[dry-run] ${summarize(state)}`);
    },
    async close() {},
  };
}

/** Controle Xbox 360 virtual via tools/gamepad-bridge/vpad.py (vgamepad/ViGEmBus). */
export function vigemSink({ python, log = console.log, onExit = () => {} }) {
  const script = path.join(here, 'vpad.py');
  let child = null;
  let closing = false;

  return {
    name: 'ViGEmBus',

    start() {
      return new Promise((resolve, reject) => {
        child = spawn(python, [script], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        let buffer = '';
        let settled = false;

        const settle = (fn, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          fn(value);
        };

        const timer = setTimeout(
          () => settle(reject, new Error('O controle virtual não respondeu em 15 s.')),
          15_000,
        );

        child.on('error', (err) => {
          const hint = err.code === 'ENOENT'
            ? ` Python não encontrado ("${python}"). Instale o Python 3 e marque "Add to PATH", ou use --python.`
            : '';
          settle(reject, new Error(`Não foi possível iniciar o Python.${hint}`));
        });

        child.stdout.on('data', (chunk) => {
          buffer += chunk.toString();
          let index;
          while ((index = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, index).trim();
            buffer = buffer.slice(index + 1);
            if (!line) continue;
            let msg;
            try {
              msg = JSON.parse(line);
            } catch {
              continue;
            }
            if (msg.ready) settle(resolve);
            if (msg.error) settle(reject, new Error(msg.error));
          }
        });

        child.stderr.on('data', (chunk) => {
          const text = chunk.toString().trim();
          if (text) log(`[vpad] ${text}`);
        });

        child.on('exit', (code) => {
          if (!settled) {
            settle(reject, new Error(`O controle virtual terminou (código ${code}).`));
          } else if (!closing) {
            onExit(code);
          }
        });
      });
    },

    apply(state) {
      if (!child || child.killed || !child.stdin.writable) {
        throw new Error('controle virtual indisponível');
      }
      child.stdin.write(`${JSON.stringify(state)}\n`);
    },

    async close() {
      closing = true;
      if (!child) return;
      try {
        child.stdin.write(`${JSON.stringify(neutralState())}\n`);
        child.stdin.end();
      } catch {
        /* já fechou */
      }
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          child.kill();
          resolve();
        }, 1500);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

/* ------------------------------------------------------------------ */
/* Cliente WebSocket                                                   */
/* ------------------------------------------------------------------ */

/**
 * @param {object} options
 * @param {string} options.url      endpoint ws(s)://.../ws
 * @param {string} options.key      chave do host
 * @param {object} options.sink     { apply(state), close() }
 * @param {Function} [options.log]
 * @param {Function} [options.onFatal] erro sem retry (ex.: chave inválida)
 * @param {number} [options.watchdogMs]
 */
export function createBridge({
  url,
  key,
  sink,
  log = console.log,
  onFatal = () => {},
  watchdogMs = WATCHDOG_MS,
  WebSocketImpl = globalThis.WebSocket,
}) {
  let ws = null;
  let stopped = false;
  let backoff = BACKOFF_MIN_MS;
  let reconnectTimer = null;
  let pingTimer = null;
  let watchdogTimer = null;

  let sessionActive = false;
  let applied = neutralState();
  let lastInputAt = 0;
  const stats = { inputs: 0, applied: 0, ignored: 0, releases: 0 };

  function safeApply(state) {
    try {
      sink.apply(state);
      applied = state;
      stats.applied++;
    } catch (err) {
      log(`Erro ao aplicar o controle: ${err.message}`);
    }
  }

  function release(reason) {
    if (isNeutral(applied)) return;
    stats.releases++;
    log(`Soltando todos os botões (${reason}).`);
    safeApply(neutralState());
  }

  function updateSession(state) {
    const active = state?.session?.status === 'active';
    if (active !== sessionActive) {
      sessionActive = active;
      log(active ? 'Sessão ativa: controle liberado.' : 'Sem sessão ativa: controle bloqueado.');
      if (!active) release('sessão encerrada');
    }
  }

  function handleInput(payload) {
    stats.inputs++;
    if (!sessionActive) {
      stats.ignored++;
      return;
    }
    const mapped = mapPayload(payload);
    if (!mapped) {
      stats.ignored++;
      return;
    }
    lastInputAt = Date.now();
    if (!sameState(mapped, applied)) safeApply(mapped);
  }

  function handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
    } catch {
      return;
    }

    switch (msg.type) {
      case 'hello':
        if (msg.ok) {
          backoff = BACKOFF_MIN_MS;
          log('Conectado ao servidor como bridge.');
          updateSession(msg.state);
        }
        break;
      case 'state':
        updateSession(msg.state);
        break;
      case 'input':
        handleInput(msg.payload);
        break;
      case 'error':
        if (msg.code === 'invalid_host_key') {
          stopped = true;
          log('Chave do host inválida. Confira HOST_KEY (ou data/host-key.txt do servidor).');
          onFatal(new Error('invalid_host_key'));
        } else {
          log(`Servidor: ${msg.message ?? msg.code}`);
        }
        break;
      default:
        break;
    }
  }

  function scheduleReconnect() {
    if (stopped) return;
    log(`Reconectando em ${Math.round(backoff / 1000)} s...`);
    reconnectTimer = setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
  }

  function connect() {
    if (stopped) return;
    let socket;
    try {
      socket = new WebSocketImpl(url);
    } catch (err) {
      log(`URL inválida (${url}): ${err.message}`);
      onFatal(err);
      return;
    }
    ws = socket;

    // Conexão recusada dispara só `error` em alguns runtimes; queda normal
    // dispara `close`. Trata os dois, uma única vez por conexão.
    let down = false;
    const onDown = () => {
      if (down) return;
      down = true;
      sessionActive = false;
      release('conexão perdida');
      if (!stopped) {
        log('Sem conexão com o servidor.');
        scheduleReconnect();
      }
    };

    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ type: 'hello', role: 'bridge', key }));
    });
    socket.addEventListener('message', (event) => handleMessage(event.data));
    socket.addEventListener('error', onDown);
    socket.addEventListener('close', onDown);
  }

  return {
    stats,

    start() {
      stopped = false;
      log(`Conectando em ${url} ...`);
      connect();

      pingTimer = setInterval(() => {
        if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'ping' }));
      }, PING_MS);

      watchdogTimer = setInterval(() => {
        if (!isNeutral(applied) && Date.now() - lastInputAt > watchdogMs) {
          release('sem sinal do cliente');
        }
      }, 500);
    },

    async stop() {
      stopped = true;
      clearTimeout(reconnectTimer);
      clearInterval(pingTimer);
      clearInterval(watchdogTimer);
      release('encerrando');
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      await sink.close();
    },
  };
}

/* ------------------------------------------------------------------ */
/* Linha de comando                                                    */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const args = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--url') args.url = argv[++i];
    else if (a === '--key') args.key = argv[++i];
    else if (a === '--python') args.python = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function resolveUrl(raw) {
  const value = raw || `ws://localhost:${process.env.PORT || 8080}/ws`;
  return value.replace(/^http/i, 'ws');
}

function resolveKey(explicit) {
  if (explicit) return explicit;
  if (process.env.HOST_KEY) return process.env.HOST_KEY;
  const dataDir = path.resolve(root, process.env.DATA_DIR || './data');
  const file = path.join(dataDir, 'host-key.txt');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  return '';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log('Uso: npm run bridge [-- --dry-run] [--url ws://host/ws] [--key CHAVE] [--python python]');
    return;
  }

  const stamp = () => new Date().toLocaleTimeString('pt-BR');
  const log = (text) => console.log(`[${stamp()}] ${text}`);

  const url = resolveUrl(args.url || process.env.BRIDGE_URL);
  const key = resolveKey(args.key);
  const dryRun = args.dryRun || process.env.BRIDGE_DRY_RUN === '1';

  if (!key) {
    console.error(
      'Chave do host não encontrada. Defina HOST_KEY no .env, passe --key, ' +
      'ou rode na mesma máquina do servidor (usa data/host-key.txt).',
    );
    process.exit(1);
  }

  if (!dryRun && process.platform !== 'win32') {
    console.error(
      'O controle virtual (ViGEmBus) só existe no Windows. ' +
      'Use --dry-run para testar o fluxo em outro sistema.',
    );
    process.exit(1);
  }

  let bridge;
  const shutdown = async (code = 0) => {
    try {
      await bridge?.stop();
    } finally {
      process.exit(code);
    }
  };

  const python = args.python || process.env.BRIDGE_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const sink = dryRun
    ? dryRunSink(log)
    : vigemSink({
        python,
        log,
        onExit: (code) => {
          log(`O controle virtual parou inesperadamente (código ${code}).`);
          shutdown(1);
        },
      });

  try {
    await sink.start();
  } catch (err) {
    console.error(`\nFalha ao iniciar o controle virtual: ${err.message}\n`);
    process.exit(1);
  }

  log(`Controle: ${sink.name}. Botões suportados: ${ALL_BUTTONS.length} + 2 gatilhos + 2 analógicos.`);

  bridge = createBridge({ url, key, sink, log, onFatal: () => shutdown(1) });
  bridge.start();

  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
