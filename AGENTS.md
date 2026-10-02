# FockyTV

## Deploy e release — SEMPRE por pedido explícito

Dois ambientes de deploy, só quando o usuário pedir explicitamente:

- **VPS (produção):** `ssh root@192.3.176.195`, repo em `/opt/fockytv`,
  branch `main` (o deploy segue esse branch + as alterações locais do
  servidor; a antiga `discordfy` foi mergeada e deletada do remote).
  `server/docker-compose.yml` tem
  alteração local no servidor: nunca sobrescrever. Deploy = `git pull` +
  `docker compose build live-api` (só quando `server/live-api/` mudar;
  mediamtx é imagem pinada, sem build) + `docker compose up -d`. Entrada
  pública direta em `:8180` (tcp HTTP no live-api + udp mídia no mediamtx),
  caddy na frente (aponta pra `host.docker.internal:8180` — não depende do
  nome de container).
- **LAN:** `ssh focky@192.168.1.129 /opt/docker/fockytv`: git pull +
  restart/rebuild dos containers.

Publicar release (bump de versão, tag `v*`, AppImage local + workflow
Actions do Windows) idem, só por pedido. Commits e push na branch corrente
não dependem disso.

### Armadilhas conhecidas

- A `ui/` é montada como DIRETÓRIO no live-api (`../ui:/srv/ui:ro`) — mudança
  de asset vale sem restart (era bind de arquivo único no broadcast-box, que
  exigia restart por causa do inode).
- CSS/JS de `ui/assets/` é cacheado 4h pela Cloudflare e pelo navegador
  (a origem não manda Cache-Control): todo commit que alterar um asset
  DEVE bumpar o `?v=` do `<link>` correspondente em `ui/index.html`,
  senão a produção segue servindo o arquivo velho na mesma URL.
- O fluxo de release assume os 5 assets (AppImage, Setup.exe, blockmap,
  latest-linux.yml, latest.yml); o Windows compila no GitHub Actions
  (`.github/workflows/release.yml`, dispara na tag).
- WS da sala de músicos passa por `/api/fixed/ws/jam` (proxy do live-api).
- O `overridePublisher` do mediamtx substitui publicador VIVO; a regra de
  takeover (400 se RTP < 10s) é do live-api — não mexer nos dois sem ler
  `server/live-api/main.go`.
- O id da sessão WHEP que o adapter entrega na `Location` NÃO é o id de
  reader do `/v3` do mediamtx (namespaces distintos): a poda de viewers
  fantasmas é por contagem de `readers` por path (mais antigo primeiro).

## Design

O tema vive em `ui/assets/theme.css` (tokens) e `ui/assets/app.css`
(componentes); `ui/index.html` não tem mais `<style>`. Regras e padrões:
`docs/design-system.md`. Cor/raio/tipo novos entram como token, não como
literal no componente.

## Client de share (client/)

Mini app Rust só de compartilhamento (tray + WHIP, 60fps nativo). Build:
`cargo build --release`; AppImage: `client/package-appimage.sh` (embute o
`config.json` da raiz; um config ao lado do AppImage tem prioridade). O
vídeo NÃO usa gstpipewiresrc: no PipeWire 1.6 ele dead-locka com encoder na
cadeia (pipewire#5459) — a captura é PipeWire nativo (`src/video_pw.rs`)
empurrando num appsrc. Diagnóstico: `examples/portal-min.rs` (matriz de
modos que isolou o bug) e `examples/publish-check.rs` (WHIP ponta a ponta).
Hotkey no Linux = bind do compositor chamando `fockytv-share --share`.

## Áudio sem o Discord

- **App (Electron):** automático. Windows = helper WASAPI (`--mix-except`),
  Linux = `pw-cat --record` com `node.autoconnect=false` e `pw-link` de cada
  app permitido (`electron/main.js`). Smoke test: `node electron/audio-linux-check.js`.
- **Navegador:** precisa do `node tools/fockytv-sink.js` rodando — cria o sink
  `FockyTV` com tudo menos o Discord e a UI publica o monitor dele
  (`fockySinkTrack` em `ui/index.html`). Smoke test: `node tools/sink-check.js`.
