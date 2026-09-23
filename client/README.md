# FockyTV Share

Mini client nativo só para compartilhar a tela no FockyTV. Rust puro, sem
GUI: vive no tray, o diálogo de seleção é o do próprio sistema (portal) e a
publicação sai por WHIP direto pro broadcast-box — 60 fps na resolução
nativa, sem re-escala.

## Como usa

- Inicie o app: aparece o ícone no tray (clique no ícone = mesmo botão de
  compartilhar).
- **Compartilhar/Parar**: item de menu do tray, clique no ícone, ou o atalho.
  Ao iniciar, escolha 15/30/60 fps e 2/6/12 Mbps; a escolha vale pela sessão.
- Escolha **Monitor** ou **Janela** no diálogo do portal. A escolha fica
  memorizada (restore token): na próxima vez o diálogo já abre com ela.
- Áudio:
  - **Janela** → só o som daquele app (exclusivo). O client casa a geometria
    do stream com as janelas do Hyprland (`hyprctl`) pra achar o processo;
    se der empate (ex.: duas janelas maximizadas iguais), prefere a que
    está tocando áudio e, se persistir, o tray lista os candidatos em
    "Som exclusivo de:".
  - **Monitor** → todo o áudio do sistema **menos Discord e FockyTV**
    (a conversa é privada e o canal de música local voltaria como eco).
- Ao vivo, o tray mostra a resolução/fps negociados.
- **Atalho**: no Linux, “Configurar tecla de atalho…” abre o portal do desktop;
  no Windows, escolha Ctrl+Shift+F10/F11/F12 no menu do tray.

### Atalho no Hyprland

Wayland não tem hotkey global; o idioma é o bind do compositor chamando o
subcomando de toggle (uma segunda invocação conversa com o daemon por
socket e sai):

```conf
bind = SUPER SHIFT, S, exec, fockytv-share --share
```

## config.json

Lido ao lado do AppImage/binário (ou `FOCKYTV_CONFIG`), mesmo formato do app
Electron:

```json
{
  "serverUrl": "https://fockytv.felipytv…",
  "displayName": "focky",
  "fps": 60,
  "maxBitrate": 0,
  "audioBitrate": 192000
}
```

`displayName` é a stream key (o nick). `maxBitrate` 0 = automático pela
resolução (1080p→10M, 1440p→16M, 4K→24M). Env `FOCKYTV_SERVER` /
`FOCKYTV_NAME` sobrescrevem (útil pra teste na LAN).

O menu de qualidade substitui `fps` e `maxBitrate` apenas durante o
compartilhamento atual.

## Build

```sh
cargo build --release              # binário (depende do gstreamer do host)
./package-appimage.sh              # AppImage autocontido (~38 MB)
```

O AppImage empacota os plugins GStreamer que o pipeline usa (incluindo o
stack webrtc do whipsink: webrtcbin/nice/dtls/srtp) e as libs por ldd
recursivo, sem glibc nem pilha gráfica.

## Testes

```sh
cargo test                                    # casamento de geometria, filtro de áudio
cargo run --example publish-check -- --server http://192.168.1.129:8180 --key smoke
                                              # publica fonte sintética e confer /api/status
cargo run --example audio-appsrc-check -- --src app
                                              # só o caminho appsrc→opus→whipsink
```

Diagnóstico: `FOCKYTV_TEST_VIDEO=1` troca a captura por `videotestsrc`
(sem portal); `FOCKYTV_DUMP_LAUNCH=1` imprime o launch do pipeline;
`FOCKYTV_DOT=1` + `GST_DEBUG_DUMP_DOT_DIR=/tmp` gera o grafo `.dot`.

## Windows

Mesmo fluxo (tray + hotkey global nativa, `d3d11screencapturesrc` para
monitor/janela via WGC, áudio WASAPI por processo com o helper
`electron/audio-helper/capture.cpp`). Build portátil via GitHub Actions
(`workflow_dispatch`), zip com os DLLs do GStreamer MSVC.
