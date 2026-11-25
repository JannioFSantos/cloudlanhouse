# Xbox Play / Cloud Lan House

Aluguel de Xbox (ou de um jogo rodando no próprio PC) por tempo, direto no navegador. O cliente paga via Pix, abre um link e joga com o controle que já tem — sem instalar nada.

> **Status:** projeto funcional em modo de teste (pagamento mock). Jogos **no PC** já têm controle via a [ponte de controle](#controle-no-pc-ponte). A injeção de controle no **Xbox físico** ainda não está implementada; veja [Limitações](#limitações).

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
- **Vendas pausadas com o PC offline:** o site só vende quando o **host** (aba `/host`) e a **ponte de controle** estão conectados. Sem isso, o botão de pagar fica desabilitado e a API responde `503 machine_offline`.
- **Transmissão que não sobe:** se o host não publicar o vídeo em `PROVISION_TIMEOUT_SEC` (180 s), a sessão é encerrada **sem iniciar o relógio**, a máquina volta a ficar livre e o Pix é **estornado automaticamente**. Se o estorno falhar, o pedido fica marcado para atenção no `/admin`, e o estorno pode ser feito pelo botão de reembolso.

## Requisitos

- **Node.js 22+** (testado no Node 24)
- PC host com Chrome/Edge atualizado
- Para Xbox: placa de captura HDMI reconhecida como dispositivo de vídeo/áudio
- Para PC: o jogo/emulador rodando em uma janela
- Para PC (controle): Windows 10/11, **Python 3** e o driver **ViGEmBus**. O `start-bridge.bat` instala a dependência Python `vgamepad`; o driver pode precisar ser instalado separadamente.
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

Na página inicial, a navegação mostra apenas **Preços** e **Regras**. O Host e o Painel não aparecem como links e devem ser acessados diretamente pelos endereços acima.

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
| `REQUIRE_ONLINE` | `1` (padrão): só vende com o PC do jogo online; `0` desliga a trava (desenvolvimento) |
| `REQUIRE_BRIDGE` | `1` (padrão): exige também a ponte de controle; `0` exige só o host (Xbox com placa de captura) |
| `PROVISION_TIMEOUT_SEC` | Segundos até estornar uma sessão cuja transmissão não subiu (padrão 180) |
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

## Controle no PC (ponte)

Para o cliente **jogar** (e não só assistir) um jogo no PC, rode a ponte no mesmo PC que roda o jogo:

```
Controle do cliente ──> navegador (play) ──WebSocket──> servidor ──> ponte ──> controle Xbox 360 virtual ──> jogo
```

1. Confirme que o servidor está rodando. Se ele estiver no próprio PC, inicie-o com `start.bat`; se estiver na VPS, não precisa iniciar outro servidor no PC do jogo.
2. Se o servidor estiver na VPS, crie ou atualize o `.env` na pasta do projeto no PC do jogo:

   ```env
   BRIDGE_URL=wss://cloudlanhouse.v6.rocks/ws
   HOST_KEY=<a mesma chave configurada no servidor>
   ```

   A chave pode ser consultada no painel administrativo ou nas configurações do servidor. O `.env` é ignorado pelo Git; nunca coloque a chave no README ou em outro arquivo versionado.
3. Inicie `start-bridge.bat` (ou `npm run bridge`) no PC do jogo. Na primeira execução, o script instala `vgamepad` se necessário. O driver **ViGEmBus** também precisa estar instalado; se estiver faltando, a ponte informa o erro e o link para instalá-lo. Reinicie o Windows se solicitado.
4. Inicie o jogo depois da ponte, abra `https://cloudlanhouse.v6.rocks/host` e escolha **Janela do PC** para publicar a captura.
5. O painel (`/admin`) mostra **Ponte de controle: online**.

Detalhes:

- A ponte lê a chave de `HOST_KEY` (no `.env`) ou de `data/host-key.txt`. Para a VPS atual, use `BRIDGE_URL=wss://cloudlanhouse.v6.rocks/ws` e configure no `.env` do PC do jogo a mesma `HOST_KEY` usada pelo servidor.
- Os comandos só são aplicados **enquanto há sessão ativa**. Ao terminar a sessão, perder a conexão ou ficar 3 s sem sinal do cliente, todos os botões são soltos.
- Funciona com controles em layout *standard* (Xbox, PS4/PS5 e a maioria dos controles no Chrome/Edge).
- Para testar sem driver (ou fora do Windows): `npm run bridge:dry` mostra no terminal o que seria apertado.
- Se o jogo não reconhecer o controle, feche e reabra o jogo **depois** de iniciar a ponte.

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

### Docker Compose (servidor + HTTPS)

Sobe o servidor e o Caddy (certificado HTTPS automático) em uma VPS:

```bash
cp .env.example .env
# edite o .env: DOMAIN=jogo.seudominio.com, ADMIN_PASSWORD, HOST_KEY e o pagamento
docker compose up -d --build
docker compose logs -f app      # mostra a senha do painel e a chave do host, se você não definiu
```

- O domínio precisa apontar para a VPS, com as portas **80** e **443** liberadas.
- `BASE_URL` e `TRUST_PROXY` são definidos pelo próprio compose; o estado fica no volume `app-data`.
- O **PC host continua no Windows**: abra `https://SEU-DOMINIO/host` no navegador dele e, para o controle, configure `BRIDGE_URL=wss://SEU-DOMINIO/ws` e a mesma `HOST_KEY` no `.env` desse PC.
- Atualizar: `git pull && docker compose up -d --build`.
- Mercado Pago: use `MP_NOTIFICATION_URL=https://SEU-DOMINIO/api/webhooks/mercadopago`.

Com TURN (clientes atrás de CGNAT/firewall rígido):

```bash
# no .env: TURN_URL=turn:SEU-DOMINIO:3478, TURN_USERNAME=..., TURN_CREDENTIAL=...
docker compose --profile turn up -d --build
```

Libere também `3478/tcp`, `3478/udp` e `49160–49200/udp` no firewall da VPS.

### Coolify

O arquivo `docker-compose.coolify.yml` sobe só o servidor; o domínio, o HTTPS e o WebSocket ficam por conta do proxy do Coolify.

1. No Coolify: **New Resource → Public/Private Repository** → escolha este repositório.
2. **Build Pack: Docker Compose** e **Docker Compose Location: `/docker-compose.coolify.yml`**.
3. O serviço `app` está configurado com o domínio `cloudlanhouse.v6.rocks` (porta interna `8080`). Aponte o DNS do domínio para a VPS e confirme o domínio na aba do serviço; o Coolify gera o HTTPS.
4. Em **Environment Variables**, preencha o que for usar: `ADMIN_PASSWORD`, `HOST_KEY`, `PAYMENT_MODE`, `MP_ACCESS_TOKEN`, `MP_WEBHOOK_SECRET`, `MP_NOTIFICATION_URL` etc. Vazio = o servidor gera e guarda os segredos no volume.
5. **Deploy**. Se não definiu senha e chave, veja-as em **Logs**.

Observações:

- `BASE_URL` e o domínio público estão definidos como `https://cloudlanhouse.v6.rocks` no Compose para manter os links, cookies seguros e URLs do WebSocket alinhados.
- Mantenha o volume `app-data`: nele ficam sessão, pedidos, fila e segredos. Sem ele, cada deploy zera tudo.
- A página inicial mostra apenas **Preços** e **Regras**; acesse o [Host](https://cloudlanhouse.v6.rocks/host) e o [Painel](https://cloudlanhouse.v6.rocks/admin) diretamente.
- O **PC host continua no Windows**: abra `https://cloudlanhouse.v6.rocks/host` e, para o controle, configure `BRIDGE_URL=wss://cloudlanhouse.v6.rocks/ws` e a mesma `HOST_KEY`.
- TURN: o `coturn` precisa de rede `host` e de uma faixa de portas UDP, o que não combina com o proxy do Coolify. Para quem está atrás de CGNAT, rode o TURN em outro serviço/VPS e preencha `TURN_URL`, `TURN_USERNAME` e `TURN_CREDENTIAL`.
- Mercado Pago: `MP_NOTIFICATION_URL=https://cloudlanhouse.v6.rocks/api/webhooks/mercadopago`.

### Rede / TURN

Para a maioria das redes domésticas, STUN público resolve. Se o host estiver atrás de CGNAT ou firewall rígido, configure um TURN (ex.: coturn) e preencha `TURN_URL`, `TURN_USERNAME` e `TURN_CREDENTIAL`.

## Testes

```bash
node --test
```

Cobrem preços, fluxo completo (pagamento, expiração, fila, desistência), integração HTTP + WebSocket (páginas, compra, handshake WebRTC, extensão, admin), a ponte de controle (mapeamento, bloqueio fora de sessão, liberação de botões), a trava de venda com host/ponte offline e o estorno automático quando a transmissão não sobe.

## Limitações

- **Controle no Xbox físico:** a ponte cobre jogos **no PC** (controle virtual via ViGEmBus). O console Xbox não aceita um controle virtual; para ele é preciso um adaptador de hardware ou transmitir o jogo para o PC (app do Xbox) e jogar por lá.
- **Controle:** vale o layout *standard* do navegador. Controles fora do padrão podem ter botões trocados; o teste real com ViGEmBus só pode ser feito no Windows.
- **Captura de janela:** não pode ser iniciada automaticamente; depende de um clique no PC host.
- **Uma máquina por instalação:** o estado tem um único slot. Para vender Xbox + vários PCs ao mesmo tempo, é necessário evoluir para múltiplas estações.
- **Pagamento:** o modo mock não cobra nada; o modo real depende do Mercado Pago e de um webhook público em HTTPS.
