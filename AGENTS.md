# FockyTV

## Deploy e release — SEMPRE por pedido explícito

Só executar deploy no servidor (`ssh focky@192.168.1.129 /opt/docker/fockytv`:
git pull + restart/rebuild dos containers) e publicar release (bump de versão,
tag `v*`, AppImage local + workflow Actions do Windows) quando o usuário pedir
explicitamente. Commits e push na branch corrente não dependem disso.

### Armadilhas conhecidas

- Os arquivos de `ui/` são bind-mounts de arquivo único no container
  broadcast-box: depois de um `git pull` que os altere, é preciso
  `docker compose restart broadcast-box` (mount segue o inode antigo).
- O fluxo de release assume os 5 assets (AppImage, Setup.exe, blockmap,
  latest-linux.yml, latest.yml); o Windows compila no GitHub Actions
  (`.github/workflows/release.yml`, dispara na tag).
- WS da sala de músicos passa por `/api/fixed/ws/jam` (proxy do broadcast-box).
