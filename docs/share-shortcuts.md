# Atalhos dos apps desktop

Em Configurações → Atalhos de compartilhamento, clique no campo, pressione
a combinação e salve. Os padrões são:

- **Ctrl+Shift+F11 — Compartilhar tela atual:** janela em foco.
- **Ctrl+Shift+F12 — Compartilhar tela toda:** monitor da janela em foco no
  Windows; monitor do cursor no X11.

Qualquer um dos dois encerra a transmissão quando já estiver no ar. Funcionam
com a janela aberta, minimizada ou escondida na bandeja. O alvo de captura e
publicação é sempre **60 fps**; a resolução segue a qualidade do diálogo
(720p no fallback de H264 por software). O FPS efetivo depende da fonte e do
encoder.

O áudio usa os mesmos filtros do compartilhamento manual: só o processo da
janela quando disponível, ou sistema excluindo Discord, Vesktop, Vencord,
Equibop e FockyTV. Sem filtro funcional, o atalho aborta e mostra erro.

Um aviso na tela e os tons existentes de início/fim acompanham a mudança real
de estado. Cancelar a seleção ou falhar ao publicar não anuncia início.

## Linux / Wayland

O [desktopCapturer do Electron](https://www.electronjs.org/docs/latest/api/desktop-capturer/)
devolve a fonte autorizada pelo portal. Por isso o atalho abre o seletor
do sistema para confirmar a janela ou monitor; não é possível escolher
silenciosamente uma janela Wayland em foco por essa API. Windows e X11
selecionam diretamente a fonte exata, sem cair na primeira fonte disponível.

Em Hyprland com configuração Lua (Omarchy), use **Ativar no Hyprland** uma
vez. O app verifica conflitos, faz backup de `bindings.lua`, adiciona um
`dofile` para `share-shortcuts.lua` no diretório de dados do app e valida
`hyprctl reload` / `configerrors`. Salvar outra combinação atualiza esse
arquivo. Os comandos `--share-active` / `--share-screen` encaminham à
instância já aberta sem trazer o app para o foco.

Nos outros desktops, os atalhos são registrados pelo
[globalShortcut do Electron](https://www.electronjs.org/docs/latest/api/global-shortcut/).
Wayland pode pedir autorização e a combinação final também pode ser ajustada
nas configurações do desktop. As preferências do app ficam em
`share-shortcuts.json` no diretório de dados do Electron.

## Verificação

`npm test` cobre seleção exata, conflitos e rollback, geração dos binds Lua,
60 fps, áudio filtrado, falha fechada, acionamentos simultâneos e transições
dos avisos. O helper Windows expõe `--foreground-window` para obter o HWND
sem abrir ou focar uma janela.
