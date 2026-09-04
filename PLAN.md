# FockyTV — plano de implementação

Screen sharing de baixa latência e alta qualidade, self-hosted.
Substitui o OBS por um client próprio. Servidor separado do client.

**Status:** Fase 0 **aprovada** (03/09/2026) — 1728x1080, `limitação none`, ~12 Mbps medido
com movimento real, H.264. 120fps ficou como opção no seletor, mas o teto é a captura do
Chromium, não o hardware: **v1 é 60fps.** Fase 1 escrita, aguardando credenciais do playit.

---

## Arquitetura

```
┌─ CLIENT (portátil, win + linux) ──────────┐      ┌─ SERVIDOR (docker-compose) ─────┐
│                                            │      │                                  │
│   [ Share Screen ]  ──── WHIP ────────────────────▶  broadcast-box                   │
│   [ Join Session ]  ──── WHEP ◀───────────────────   (Pion, WHIP in / WHEP out)      │
│                                            │      │            ▲                     │
│   Electron + ui/index.html                 │      │            │ tunnel              │
│   sem servidor embutido                    │      │       playit.gg agent            │
└────────────────────────────────────────────┘      └──────────────────────────────────┘
```

**Decisões já tomadas (não reabrir sem motivo novo):**

| Decisão | Motivo |
|---|---|
| Electron, não Tauri | webview do Tauri no Linux é o WebKitGTK **do sistema** — `getDisplayMedia` varia por distro. AppImage inteiro depende disso. |
| Sem fork do broadcast-box | remover código não justifica carregar rebase pra sempre. Forkar só se for **adicionar** algo. |
| Sem TURN | topologia é cliente-servidor, não P2P. Quem transmite/assiste atrás de NAT já funciona (conexão de saída). |
| Sem servidor embutido no client | playit.gg resolve NAT no servidor. Client fica só UI + WebRTC. |
| Fallback TCP sem toggle | ICE escolhe udp/tcp sozinho se o servidor anunciar os dois candidatos. |

---

## Fase 0 — Validar antes de construir  ⚠️ GATE

**Objetivo:** provar que WHIP direto bate a qualidade desejada. Se falhar aqui, o resto não importa.

Rode broadcast-box **local** (`localhost`, sem docker, sem playit) e uma página estática, e meça.

Por que localhost: mesma origem (sem CORS), secure context (`getDisplayMedia` exige), sem NAT. Isola a variável.

### Passos

1. Subir broadcast-box em `localhost:8080`
2. Página estática com `publish()` e `watch()` (código abaixo)
3. Publicar uma tela, assistir em outra aba
4. Abrir `chrome://webrtc-internals` e anotar, do `outbound-rtp` de vídeo:
   - `frameWidth` × `frameHeight`
   - `framesPerSecond`
   - `targetBitrate` / `bytesSent`
   - `qualityLimitationReason`

### Critério de aprovação

1080p, ~60fps, `targetBitrate` acima de ~6 Mbps, `qualityLimitationReason: none`.

- Deu `cpu` → encoder por software é o gargalo → testar `setCodecPreferences` pra H.264 (encode por hardware)
- Deu `bandwidth` em **localhost** → tem coisa errada no `setParameters`, revisar antes de seguir
- Bitrate travado em ~2.5 Mbps → `setParameters` não pegou; conferir o timing (ver gotcha #2)

### Código de referência

```js
// espera ICE completo — broadcast-box quer offer não-trickle
const ice = pc => new Promise(r =>
  pc.iceGatheringState === 'complete' ? r()
  : pc.addEventListener('icegatheringstatechange',
      () => pc.iceGatheringState === 'complete' && r()))

async function publish (url, key, stream) {
  stream.getVideoTracks()[0].contentHint = 'motion'

  const pc = new RTCPeerConnection()
  stream.getTracks().forEach(t => pc.addTrack(t, stream))

  const s = pc.getSenders().find(x => x.track?.kind === 'video')
  const p = s.getParameters()
  if (!p.encodings?.length) p.encodings = [{}]
  p.encodings[0].maxBitrate = 15_000_000
  p.encodings[0].maxFramerate = 60
  p.encodings[0].scaleResolutionDownBy = 1
  p.degradationPreference = 'maintain-resolution'
  await s.setParameters(p)

  await pc.setLocalDescription(await pc.createOffer())
  await ice(pc)

  const res = await fetch(`${url}/api/whip`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/sdp', Authorization: `Bearer ${key}` },
    body: pc.localDescription.sdp,
  })
  await pc.setRemoteDescription({ type: 'answer', sdp: await res.text() })
  return pc
}

async function watch (url, key, videoEl) {
  const pc = new RTCPeerConnection()
  pc.addTransceiver('video', { direction: 'recvonly' })
  pc.addTransceiver('audio', { direction: 'recvonly' })
  pc.ontrack = e => { videoEl.srcObject = e.streams[0] }

  await pc.setLocalDescription(await pc.createOffer())
  await ice(pc)

  const res = await fetch(`${url}/api/whep`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/sdp', Authorization: `Bearer ${key}` },
    body: pc.localDescription.sdp,
  })
  await pc.setRemoteDescription({ type: 'answer', sdp: await res.text() })
  return pc
}
```

> **Confirmar contra a versão instalada do broadcast-box:** caminhos `/api/whip`, `/api/whep`, `/api/status`,
> o formato do header `Authorization`, e os nomes das envs. Mudam entre releases.

---

## Fase 1 — Servidor (docker-compose + playit.gg)

```
server/
├── docker-compose.yml   # perfil default = Fase 0; --profile tunnel = Fase 1
├── .env.example
└── fase0.html           # bancada de medição, montada em web/build/
```

### Ordem de configuração (importa!)

1. Criar o túnel **UDP** no painel do playit.gg → ele atribui uma porta pública, ex. `45678`
2. Criar o túnel **TCP** pro HTTP (WHIP/WHEP/status)
3. **Setar `UDP_MUX_PORT` igual à porta pública UDP atribuída** (ver gotcha #1)
4. Setar `NAT_1_TO_1_IP` com o IP público do playit

### Envs do broadcast-box (confirmar nomes)

| Env | Valor | Por quê |
|---|---|---|
| `HTTP_ADDRESS` | `:8080` | signaling |
| `UDP_MUX_PORT` | = porta pública do playit | **crítico**, gotcha #1 |
| `NAT_1_TO_1_IP` | IP público do playit | senão anuncia o IP do container (172.x) |
| `NETWORK_TYPES` | `udp4\|tcp4` | fallback TCP automático via ICE |

### Verificação

- `curl http://<publico>:<porta>/api/status` responde de fora da rede
- Publicar de uma máquina em **outra rede** (4G do celular serve) e assistir
- Nos candidatos ICE do SDP, o IP tem que ser o público — não `172.x` nem `192.168.x`

⚠️ Medir bitrate de novo aqui. O playit relaya o tráfego pela rede deles: **compare com o número da Fase 0.** Se cair muito, o túnel é o teto e vale considerar VPS com IP público direto.

---

## Fase 2 — Client

```
fockytv/
├── package.json
├── config.json              # serverUrl, displayName
├── ui/
│   ├── index.html           # 2 botões + lista de sessões
│   └── app.js               # publish() / watch() / list()
└── electron/
    ├── main.js
    ├── preload.js
    └── picker.html          # COPIAR de sharkoid_client/electron/picker.html
```

**Reaproveitar de `sharkoid_client`** (não reescrever):
- `electron/picker.html` — grid de telas/janelas, thumbnails, cancelar: pronto
- `main.js:530` `setDisplayMediaRequestHandler` + `desktopCapturer` — padrão pronto
- `main.js:455-468` handlers IPC do picker
- `package.json` bloco `build` — base do electron-builder

### Duas telas

**Share Screen** → picker (já existe) → `getDisplayMedia` → `publish()` → indicador "no ar" + botão parar

**Join Session** → `GET /api/status` a cada ~5s → lista → clicar → `watch()` em fullscreen

### Thumbnails sem código novo

Reusa `watch()`: conecta num `<video>` escondido → `canvas.drawImage()` no primeiro frame → `pc.close()`.
Com 1–5 streams o custo é irrelevante. Não inventar endpoint pra isso.

### Todo HTTP passa pelo main process

`getDisplayMedia` fica no renderer; **todo `fetch` pro servidor vai por IPC → `net.fetch` no main.**
Elimina CORS de vez, sem depender do que o broadcast-box manda de header. ~15 linhas.

### Identidade

`displayName` do config vira a stream key. `/api/status` lista as keys ativas = "quem está ao vivo".

```js
// ponytail: stream key == nome de exibição == credencial de publicação.
// Quem sabe o nome pode publicar se passando por outro.
// Aceitável entre amigos; se abrir, separar key de nome e assinar no servidor.
```

---

## Fase 3 — Empacotamento portátil

```jsonc
"win":   { "target": [{ "target": "portable", "arch": ["x64"] }] },
"linux": { "target": [{ "target": "AppImage", "arch": ["x64"] }] }
```

Sem binário externo pra embutir (o servidor é docker agora) → sem `extraResources`, sem chmod, sem spawn.
`config.json` fica ao lado do executável, editável pelo usuário.

**Verificação:** copiar o `.exe` / `.AppImage` pra uma máquina limpa, sem Node, e rodar os dois fluxos.

---

## Gotchas (leia antes de debugar)

1. **Porta do playit ≠ porta local.** `NAT_1_TO_1_IP` reescreve só o **IP** dos candidatos ICE, nunca a porta. Se o público for 45678 e o local 8081, o SDP anuncia `ip:8081` e a mídia nunca conecta. **`UDP_MUX_PORT` tem que ser igual à porta pública.** Sintoma: signaling OK, ICE em `checking` pra sempre, vídeo preto.

2. **`setParameters` depois de `addTrack`.** Antes disso `getParameters().encodings` vem vazio e a config é descartada em silêncio. Sintoma: bitrate preso em ~2.5 Mbps.

3. **ICE não-trickle.** Mandar o SDP antes do gathering terminar → offer sem candidatos. Sempre `await ice(pc)`.

4. **Secure context.** `getDisplayMedia` só roda em `https://`, `localhost` ou `file://`. `http://192.168.x` **não** funciona.

5. **Áudio do sistema.** No Electron/Windows: `callback({ video: src, audio: 'loopback' })`. No Linux depende de PipeWire e é bem mais chato — **deixar pra depois, não bloquear o v1.**

6. **`degradationPreference`.** Sem `maintain-resolution`, o Chromium derruba resolução sozinho na primeira pressão de CPU. É o que mais causa "ficou borrado do nada".

---

## Fora de escopo (v1)

Gravação · chat · auth além do bearer · troca de camada simulcast · transcoding · mobile · múltiplas telas simultâneas · servidor embutido no client

---

## Ordem de execução

```
Fase 0 (gate: bitrate ok?) → Fase 1 (servidor externo ok?) → Fase 2 (client) → Fase 3 (pacote)
```

Não pular a Fase 0. Ela custa uma tarde e responde se o projeto inteiro faz sentido.
