# Compartilhamento via LiveKit

A interface web e o Electron publicam tela/câmera/vídeo pelo SDK LiveKit,
com sinalização WebSocket e mídia WebRTC UDP (TCP como fallback). A referência
é o [Fluxer](https://github.com/fluxerapp/fluxer), especialmente
[ScreenShareOptions](https://github.com/fluxerapp/fluxer/blob/main/fluxer_app/src/features/voice/utils/ScreenShareOptions.ts)
e [ScreenShareCodecSelection](https://github.com/fluxerapp/fluxer/blob/main/fluxer_app/src/features/voice/utils/ScreenShareCodecSelection.ts).

Perfil: hardware primeiro entre codecs suportados; sem simulcast; AV1/VP9
com L1T3. Bitrate e hint NÃO seguem o Fluxer: teto fixo de 32 Mbps e
contentHint motion (com 6 Mbps em 1080p60 a imagem ficava borrada); fonte 4K e 15/30 fps preservam resolução, 60 fps preserva fluidez.
O projeto mantém seus seletores, sem planos pagos ou limites de assinatura.
H.265 não é oferecido devido à compatibilidade dos espectadores.

Durante o compartilhamento de tela no web/Electron, o botão **Alterar qualidade**
permite alterar resolução e FPS sem abrir outra captura, desconectar espectadores
ou reiniciar o áudio. A captura e o encoder recebem os novos alvos; a composição
com webcam acompanha as dimensões e a cadência. Falhas restauram a configuração
anterior e são exibidas no diálogo. O codec automático não reduz a escolha para
720p30 silenciosamente. A resolução mantém a proporção da fonte dentro do teto
escolhido; FPS real depende da fonte, encoder e rede.
Esse controle não se aplica a YouTube, câmera sozinha ou ao cliente Rust.
Mudanças reais com espectadores em Windows/Wayland ainda precisam de validação.

Áudio entra antes do SDK: PipeWire no Linux e WASAPI no Windows.
Discord, Vesktop, Vencord, Equibop e FockyTV são excluídos. Falha do filtro
resulta em vídeo sem áudio. No navegador, som de tela exige o sink filtrado
`node tools/fockytv-sink.js`; não há fallback para loopback do sistema inteiro.
Não é possível excluir Discord aberto como uma aba de um navegador que
esteja sendo incluído como aplicativo; use o cliente Discord/Vesktop/Vencord
separado da fonte de áudio.

## Servidor

Não substitua o compose existente da VPS. Use o arquivo adicional:

```sh
npm ci
npm run build:benchmark
cd server
docker compose -f docker-compose.yml -f docker-compose.livekit.yml build live-api fixed-live
docker compose -f docker-compose.yml -f docker-compose.livekit.yml up -d
```

`server/.env` (fora do Git, permissão 0600) precisa de LIVEKIT_NODE_IP,
LIVEKIT_API_KEY e LIVEKIT_API_SECRET (ao menos 32 caracteres aleatórios).
WebSocket `/livekit/` usa o domínio HTTPS existente através do live-api.
Portas públicas adicionais: 7882/UDP, 7885/UDP e 7881/TCP. HTTP/API LiveKit 7880
fica somente na rede Docker. Os tokens têm sala e função limitadas e expiram
em duas horas; o segredo nunca vai para o navegador. A política pública de
nicks/salas do projeto permanece; não foi introduzido login.

O SDK é copiado localmente para `ui/vendor`, com sua licença, pelo build já
existente. Execute esse build também antes de empacotar o Electron.
Apps Electron já instalados usam UI local e precisam ser recompilados para
receber o transporte novo; deploy de servidor não atualiza esses binários.

## Compatibilidade e limites

TV, música e publicação só-áudio continuam com WHIP/WHEP e MediaMTX.
O cliente Rust usa `/api/livekit/whip`: ingresso H264/Opus sem transcodificação
no LiveKit, preservando a captura nativa e os encoders de hardware. A sinalização
do Rust continua WHIP; a interface/Electron usam o protocolo de sinalização
do SDK do Fluxer. Os espectadores dos dois usam o mesmo SFU LiveKit. O status combina os dois motores e o player escolhe o transporte
pela transmissão. O buffer de clips do servidor recebe somente streams
MediaMTX; não grava as streams LiveKit. O botão de clip já estava oculto na
interface. Uma futura gravação LiveKit exige integrar egress/gravador próprio.

A troca de stack não garante desempenho igual em todas as redes. Os testes
anteriores em `livekit-benchmark.md` reproduziram perda/jitter entre cliente e
VPS. O teste de integração desta migração verifica mídia, troca de fonte,
remoção/republicação de áudio e presença; não substitui teste de jogo/vídeo
real com o app do usuário e espectadores em outras redes.
