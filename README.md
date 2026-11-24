# Xbox Play / Cloud Lan House

Aluguel de Xbox (ou de um jogo rodando no próprio PC) por tempo, direto no navegador. O cliente paga via Pix, abre um link e joga com o controle que já tem — sem instalar nada.

> **Status:** projeto funcional em modo de teste (pagamento mock). A injeção real de controle no console ainda não está implementada; veja [Limitações](#limitações).

## Como funciona

```
Xbox ──HDMI──> placa de captura ─┐
                                 ├─> PC host (navegador) ──WebRTC──> navegador do cliente
Jogo no PC (janela) ─────────────┘
```

- **Servidor** (`Node.js`, sem dependências): páginas, API, WebSocket de sinalização, fila, pedidos, pagamento Pix e o **relógio autoritativo**.
- **Host** (`/host`): captura o vídeo do Xbox pela placa HDMI **ou** uma janela do PC (Steam, emulador, qualquer app) e publica via WebRTC.
- **Player** (`/play.html?s=...`): recebe o vídeo/áudio por WebRTC, mostra o tempo restante e permite estender ou desistir.
- **Painel** (`/admin`): sessão atual, fila, pedidos, eventos, presença de host/player e ações administrativas.

O vídeo **não passa pelo servidor**: ele vai direto do PC host para o navegador do cliente (P2P). O servidor só troca SDP/ICE e controla o tempo. Se a rede impedir o P2P, configure um **TURN**.

## Regras de negócio

- 1ª hora: **R$ 7,00**
- Cada hora adicional comprada antes do fim: **R$ 1,00 a menos** (R$ 6, R$ 5, R$ 4)
- Máximo por sessão: **4 horas** (R$ 22,00 no total)
- O relógio **não pausa** se o cliente sair; ele volta pelo mesmo link enquanto houver tempo.
- **Desistir** encerra na hora, sem reembolso, e libera a máquina para outra pessoa.
- Uma sessão por vez, com **fila de espera**.
- O Pix reserva a máquina por **15 minutos**; sem pagamento, a reserva expira sozinha.
- Extensão só é aceita com mais de **120 segundos** restantes.

## Requisitos

- **Node.js 22+** (testado no Node 24)
- PC host com Chrome/Edge atualizado
- Para Xbox: placa de captura HDMI reconhecida como dispositivo de vídeo/áudio
- Para PC: o jogo/emulador rodando em uma janela
- HTTPS (ou `localhost`) — obrigatório para captura de tela, gamepad e WebSocket seguro em produção

## Rodar localmente

```bash
# na pasta do projeto
node --env-file-if-exists=.env src/server.js
```

Ou no Windows: dê dois cliques em `start.bat`.

Sem `.env`, o servidor sobe com:

- `http://localhost:8080`
- pagamento em **modo mock** (botão “Simular pagamento aprovado”)
- senha do painel e chave do host **geradas e impressas no terminal** (também ficam em `data/`)

Acesse:

- Site: `http://localhost:8080/`
- Host: `http://localhost:8080/host`
- Painel: `http://localhost:8080/admin`

## Configuração (`.env`)

Copie `.env.example` para `.env` e ajuste.

| Variável | Para que serve |
| --- | --- |
| `PORT` | Porta HTTP (padrão 8080) |
| `BASE_URL` | URL pública usada nos links e no Pix |
| `DATA_DIR` | Pasta de estado (sessão, pedidos, fila, segredos) |
| `HOST_KEY` | Chave do PC que transmite |
| `ADMIN_PASSWORD` | Senha do `/admin` |
| `PAYMENT_MODE` | `mock` ou `mercadopago` |
| `MP_ACCESS_TOKEN` | Token do Mercado Pago (Pix real) |
| `MP_WEBHOOK_SECRET` | Segredo para validar o webhook |
| `MP_NOTIFICATION_URL` | `https://SEU-DOMINIO/api/webhooks/mercadopago` |
| `STUN_URL` / `TURN_URL` | Rede do WebRTC |
| `TURN_USERNAME` / `TURN_CREDENTIAL` | Credenciais do TURN |
| `TRUST_PROXY` | `1` atrás de Caddy/Nginx/Cloudflare |
| `XBOX_POWER_ON_CMD` / `XBOX_POWER_OFF_CMD` | Comandos opcionais de energia |

> **Segurança:** nunca comite `.env` nem a pasta `data/`. O `.gitignore` já cobre os dois.

## Pagamento com Mercado Pago

1. Crie uma aplicação no Mercado Pago e obtenha o **Access Token**.
2. Defina `PAYMENT_MODE=mercadopago` e `MP_ACCESS_TOKEN=...`.
3. Configure o webhook para `https://SEU-DOMINIO/api/webhooks/mercadopago` (e `MP_WEBHOOK_SECRET`).
4. Use uma `BASE_URL` pública em **HTTPS**.

Sem token, o sistema cai automaticamente em **mock** — útil para testar o fluxo inteiro sem cobrar nada.

## Captura: Xbox ou PC

No `/host`, escolha a **Fonte do jogo**:

### Placa de captura (Xbox)
1. Ligue o Xbox e deixe no jogo.
2. HDMI do console na placa.
3. Selecione a placa e o áudio do HDMI.
4. Clique em **Iniciar captura da placa**.

Se “Iniciar captura sozinho” estiver marcado, o host abre a placa automaticamente quando uma sessão é paga.

### Janela do PC (jogo/emulador)
1. Abra o jogo/emulador em uma janela.
2. Selecione **Janela do PC**.
3. Clique em **Escolher janela do jogo**.
4. Escolha a janela e marque **compartilhar áudio**.

A captura de janela exige um clique manual (o navegador não permite iniciar sozinha) e a janela precisa continuar visível durante a sessão.

## Hospedagem

O servidor é um processo Node único. Em produção:

1. Aponte um domínio para a VPS.
2. Coloque **Caddy** ou **Nginx** na frente, com HTTPS e upgrade de WebSocket para `/ws`.
3. Rode `node --env-file-if-exists=.env src/server.js` atrás do proxy.
4. Libere as portas do TURN, se usar (`3478/tcp`, `3478/udp`, `5349/tcp`, `5349/udp` e a faixa de relay).

Exemplo de `Caddyfile`:

```caddy
seu-dominio.com {
    reverse_proxy 127.0.0.1:8080
}
```

O Caddy já faz TLS e encaminha o upgrade do WebSocket.

### Rede / TURN

Para a maioria das redes domésticas, STUN público resolve. Se o host estiver atrás de CGNAT ou firewall rígido, configure um TURN (ex.: coturn) e preencha `TURN_URL`, `TURN_USERNAME` e `TURN_CREDENTIAL`.

## Testes

```bash
node --test
```

Cobrem preços, fluxo completo (pagamento, expiração, fila, desistência) e integração HTTP + WebSocket (páginas, compra, handshake WebRTC, extensão, admin).

## Limitações

- **Controle:** o player já envia eventos de gamepad por WebSocket para o papel `bridge`, mas a injeção real no Xbox/PC (ViGEmBus, Xbox app etc.) **não está implementada**. Sem isso, o cliente vê e ouve, mas não joga de verdade.
- **Captura de janela:** não pode ser iniciada automaticamente; depende de um clique no PC host.
- **Uma máquina por instalação:** o estado tem um único slot. Para vender Xbox + vários PCs ao mesmo tempo, é necessário evoluir para múltiplas estações.
- **Pagamento:** o modo mock não cobra nada; o modo real depende do Mercado Pago e de um webhook público em HTTPS.
