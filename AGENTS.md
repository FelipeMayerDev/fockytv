# FockyTV

## Deploy e release — SEMPRE por pedido explícito

Dois ambientes de deploy, só quando o usuário pedir explicitamente:

- **VPS (produção):** `ssh root@192.3.176.195`, repo em `/opt/fockytv`,
  branch `discordfy` (o deploy segue esse branch, não o `main` — atualizar
  os dois no push). `server/docker-compose.yml` e `config.json` têm
  alterações locais no servidor: nunca sobrescrever. Deploy = `git pull` +
  `docker compose build broadcast-box` (só quando `server/broadcast-box/`
  mudar) + `docker compose up -d broadcast-box`. Entrada pública direta em
  `:8180` (tcp+udp), caddy na frente do resto.
- **LAN:** `ssh focky@192.168.1.129 /opt/docker/fockytv`: git pull +
  restart/rebuild dos containers.

Publicar release (bump de versão, tag `v*`, AppImage local + workflow
Actions do Windows) idem, só por pedido. Commits e push na branch corrente
não dependem disso.

### Armadilhas conhecidas

- Os arquivos de `ui/` são bind-mounts de arquivo único no container
  broadcast-box: depois de um `git pull` que os altere, é preciso
  `docker compose restart broadcast-box` (mount segue o inode antigo).
- O fluxo de release assume os 5 assets (AppImage, Setup.exe, blockmap,
  latest-linux.yml, latest.yml); o Windows compila no GitHub Actions
  (`.github/workflows/release.yml`, dispara na tag).
- WS da sala de músicos passa por `/api/fixed/ws/jam` (proxy do broadcast-box).

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
