# Comparação MediaMTX e LiveKit

Página: `/benchmark.html`. Publica pelo SDK LiveKit diretamente, sem WHIP,
ou pelo WHIP atual do FockyTV. O player usa o SDK ou WHEP correspondente.
Este teste é somente de vídeo; áudio filtrado, chat e client Rust continuam
no caminho atual. Não é uma migração de produção.

## Preparar localmente

Na raiz do projeto:

```bash
npm ci
npm run build:benchmark
export LIVEKIT_API_KEY=fockytv-benchmark
export LIVEKIT_API_SECRET="$(openssl rand -hex 32)"
docker compose -p fockytv-benchmark -f server/docker-compose.benchmark.yml up -d
```

O compose é independente e publica portas somente em `127.0.0.1`.
O serviço LiveKit usa a versão pinada `v1.13.9`. O SDK JS é `2.22.3`,
copiado de `node_modules` para `ui/vendor` com sua licença; sem CDN.
Execute o build novamente quando atualizar o SDK.

Com o FockyTV local já rodando, abra `http://localhost:8180/benchmark.html`.
A página é servida pelo mount do diretório `ui/`; não exige reiniciar o
live-api. Sem o FockyTV local, seu compose pode ser iniciado separadamente
conforme o procedimento do projeto, com candidato ICE da máquina local.

Gere um token para cada função **no mesmo terminal dos exports**:

```bash
node tools/livekit-benchmark-token.mjs compare-1080p60 publisher
node tools/livekit-benchmark-token.mjs compare-1080p60 viewer
```

Cole somente o token da função da aba. Os tokens expiram em duas horas,
permitem entrar somente nessa sala e não permitem publicar dados. O segredo
do servidor nunca vai para a página, nem os tokens para o JSON de medições.
Use uma sala `compare-...` diferente para cada comparação independente.
Um token por função admite um publicador e um espectador simultâneos;
reutilizar o token em outra aba da mesma função substitui a sessão anterior.

## Comparar

1. Abra duas abas, uma para transmitir e outra para assistir. Um teste na
   mesma máquina verifica a integração; a decisão de migração exige um
   espectador em outra máquina e o servidor na mesma rota do atual.
2. Na aba do publicador, escolha tela/janela ou a animação e clique em
   **Preparar fonte**. Prefira um vídeo/jogo em movimento; tela parada
   não comprova fluidez. Mantenha a aba visível: o navegador pode limitar
   a animação de canvas em segundo plano.
3. Escolha MediaMTX nas duas abas e a mesma sala. Clique em **Transmitir**
   e depois **Assistir** na outra aba. Colete pelo menos 60 segundos.
4. Pare as duas sessões com **Parar teste**, preservando a fonte. Troque
   as duas abas para LiveKit, cole os respectivos tokens e repita.
5. Baixe as medições em ambas as abas. Inverta a ordem dos caminhos e
   repita com o mesmo trecho de movimento para reduzir viés.

Os dois publicam H.264 com alvo 1920×1080/60, `motion`,
`maintain-framerate` e sem simulcast. O teto padrão é 16 Mbps e o buffer
alvo padrão é 150 ms; os seletores permitem testar 6/8/16 Mbps e
150/300/500 ms. Escolha valores iguais nas duas pontas e entre servidores.
O teto não é garantia de bitrate mínimo; o buffer solicitado também não
garante o tempo real de reprodução, que é medido separadamente.
O profile H.264 negociado aparece no JSON e pode diferir entre servidores.
A captura não amplia uma janela menor até Full HD; confira a resolução real.
Simulcast fica para uma segunda comparação, depois de medir uma camada igual.

## Ler as medições

- FPS enviado/recebido e Mbps usam diferenças de contadores e timestamps
  reais, não assumem que o timer sempre dispara no prazo.
- Publicador: tempo médio de encode por quadro, motivo da limitação
  (`cpu`/`bandwidth`) e retransmissões, quando o navegador informa.
- Espectador: perda no intervalo, quadros descartados, número/duração de
  congelamentos, tempo de decode e tempo médio no jitter buffer.
- Codec/profile, transporte ICE, tipo de candidato e RTT quando disponíveis.
- `null` significa indisponível ou ausência de uma amostra anterior.
  RTT é ida e volta até o servidor; o buffer é só uma etapa. Nenhum deles
  mede a latência total. Compare visualmente uma fonte com relógio para isso.

Desconsidere a primeira amostra e os primeiros vinte segundos de estabilização.
Compare períodos de mesma duração e atividade. O caminho vencedor precisa
manter resolução próxima de 1920×1080, FPS próximo de 60 e menos congelamentos,
sem depender de reduzir a resolução. A animação mede fluidez, mas não substitui
avaliação visual de jogos/vídeos com detalhe fino.

## Resultado local inicial

Teste em 9 de outubro de 2026 (UTC), com dois processos Chromium 152 separados,
fonte de animação 1080p60 reutilizada, transporte UDP e cerca de 65 segundos por
caminho. Após excluir os primeiros 20 segundos, restaram 45 segundos medidos:

| Caminho | Resolução em todas as amostras | FPS médio recebido | Mbps médio | Congelamentos | Quadros descartados | Perda |
|---|---|---|---|---|---|---|
| LiveKit SDK | 1920×1080 | 59,58 | 6,44 | 0 | 0 | 0% |
| MediaMTX WHIP/WHEP | 1920×1080 | 59,96 | 6,55 | 0 | 0 | 0% |

Ambos reduziram resolução durante a subida inicial de banda e chegaram a
Full HD depois. O teste confirma publicação, reprodução, medições, exportação
sem tokens e preservação da fonte ao trocar de caminho. Não reproduziu o
problema da internet/VPS nem demonstrou vantagem do LiveKit. Uma primeira
tentativa com duas abas no mesmo processo limitou a animação em segundo plano
a cerca de 1 fps; esse resultado foi descartado, e os processos separados
mantiveram a fonte visível.

## Teste entre máquinas e VPS

O compose fornecido é deliberadamente local. Um teste externo exige endereço
ICE alcançável, portas de mídia e endpoint LiveKit `wss://` com TLS válido,
além da página FockyTV em HTTPS para captura de tela. Não basta encaminhar
somente o WebSocket pelo proxy. O domínio precisa alcançar o servidor; mídia
UDP não trafega pelo proxy HTTP da Cloudflare.

Se servir a página em um host e apontar o campo **Servidor FockyTV** para
outro, use o live-api desta revisão: ele expõe `Location` no CORS para que
o navegador possa encerrar a sessão WHIP/WHEP. Uma versão anterior pode
conectar a mídia mas ocultar esse cabeçalho, e o teste recusará a sessão.

Para uma comparação útil, coloque LiveKit e MediaMTX na mesma VPS, com a mesma
fonte e espectadores. Isso é um deploy separado e deve ser pedido explicitamente
conforme `AGENTS.md`; preserve as alterações locais do compose de produção.

## Resultado na VPS

Teste em 9 de outubro de 2026 (UTC), na VPS `192.3.176.195`, com dois
processos Chromium 152 nesta máquina (publicador e espectador). A mídia
atravessou a internet diretamente por UDP: MediaMTX em 8180 e LiveKit
temporário em 7882. Somente a sinalização passou por túneis SSH, para
dispensar mudança de TLS/Caddy. A página foi servida localmente com proxy
para o live-api da VPS, evitando alterações no servidor de produção.

Foram duas rodadas completas, com ordem invertida, mesma fonte de animação
reutilizada dentro de cada rodada e os mesmos parâmetros do teste local.
Cada caminho rodou cerca de 65 segundos; excluindo os primeiros 20,
restaram 45–47 segundos por trecho. Percentual de Full HD é aproximado,
calculado pelo tempo das amostras de cerca de um segundo:

| Rodada/ordem | Caminho | FPS médio recebido | Tempo em 1920×1080 | Congelamentos | Duração dos congelamentos |
|---|---|---|---|---|---|
| 1 / primeiro | LiveKit SDK | 60,00 | 26% | 0 | 0 s |
| 1 / segundo | MediaMTX WHIP/WHEP | 59,26 | 100% | 2 | 0,405 s |
| 2 / primeiro | MediaMTX WHIP/WHEP | 42,16 | 64% | 6 | 7,182 s |
| 2 / segundo | LiveKit SDK | 59,03 | 0% | 9 | 3,829 s |

O RTT médio foi 122–160 ms. O receptor registrou picos de perda de até 15%
em intervalos de cerca de um segundo no LiveKit e 8% no MediaMTX; esses
picos não são a perda média da transmissão, nem medem a perda no upload.
O publicador retransmitiu pacotes nos dois caminhos. O navegador reportou
limitação por banda em parte dos trechos e nenhuma amostra limitada por CPU.
Isso aponta para investigar perdas, jitter e estimativa de banda na rota;
não identifica sozinho o segmento ou equipamento responsável.

A rota real reproduziu quedas e congelamentos. LiveKit não sustentou o
objetivo de Full HD a 60 fps; média de FPS próxima de 60 também ocorreu
com resolução reduzida e congelamentos. Esses resultados não justificam
migrar a produção como solução confirmada. Ainda faltam fonte de vídeo/jogo
real, o app/sistema usado pelos publicadores e espectadores em outras redes.

Uma tentativa inicial foi descartada porque WHEP foi aberto antes de o
MediaMTX receber RTP. O benchmark agora espera `/api/status` confirmar a
trilha de vídeo antes de liberar o publicador; há teste para disponibilidade
e timeout com encerramento da sessão.

O container LiveKit temporário, sua configuração com segredo e os túneis
foram removidos ao terminar. O repositório e o compose da VPS não foram
alterados, e os containers de produção não foram reiniciados. Medições
completas e resumo ficaram em `.cache/vps-benchmark/` nesta máquina,
sem tokens nos arquivos de resultado.

Ao terminar o serviço local:

```bash
docker compose -p fockytv-benchmark -f server/docker-compose.benchmark.yml down
unset LIVEKIT_API_KEY LIVEKIT_API_SECRET
```

Referências: [LiveKit — configuração de publicação](https://docs.livekit.io/transport/media/advanced/),
[self hosting](https://docs.livekit.io/transport/self-hosting/deployment/),
[autenticação](https://docs.livekit.io/frontends/build/authentication/).

## Diagnóstico de rede e ajustes do MediaMTX

Executado em 9 de outubro de 2026 (UTC). A rota desta máquina passa pelo
Wi-Fi de 5 GHz; o sinal observado foi -68 dBm. Não houve teste por cabo.
Os testes UDP usaram iperf3 3.19.1, datagramas de 1200 bytes e 15 segundos
por caso, em porta temporária restrita ao IP do cliente. Foram executados
separadamente das transmissões, sem WHIP, MediaMTX ou túnel de mídia.

| Carga UDP | Recebido no upload | Perda upload | Recebido no download | Perda download |
|---|---|---|---|---|
| 8 Mbps, um sentido por vez | 7,94 Mbps | 0% | 7,99 Mbps | 0,063% |
| 16 Mbps, um sentido por vez | 15,87 Mbps | 0% | 15,99 Mbps | 0,095% |
| 8 Mbps por sentido, simultâneo | 7,81 Mbps | 1,560% | 7,80 Mbps | 1,762% |
| 8 Mbps por sentido, simultâneo, pacing de 16,667 ms | 7,93 Mbps | 0% | 7,85 Mbps | 0,840% |

O último caso aumenta o intervalo do pacing do iperf para aproximar envio
em rajadas; não reproduz exatamente os tamanhos/tempos dos quadros RTP.
A ordem e as condições variáveis impedem concluir que esse pacing melhorou
a conexão. O jitter estimado pelo iperf ao final dos casos foi 0,18–1,53 ms;
essa estimativa não representa picos ou percentis de atraso.
Uma tentativa de download a 16 Mbps falhou na conexão de controle e foi
descartada; a repetição completou os 15 segundos e forneceu a linha válida.

Ping em repouso: VPS 122,32 ms em média, máximo 167,56 ms, perda 0/60;
roteador local 1,14 ms em média, máximo 3,00 ms, perda 0/30.
Durante a matriz de vídeo: VPS máximo 503,38 ms e roteador 192,59 ms,
sem perda ICMP em 650 pacotes por destino. Durante a repetição: VPS
133,32 ms em média e máximo 557,16 ms; roteador 4,33 ms em média e
máximo 181,16 ms, sem perda em 350 pacotes por destino. Alguns picos
apareceram simultaneamente nos dois destinos. Isso indica variação no
acesso local, sem identificar se a causa é rádio, driver ou roteador;
não exclui contribuição da rota externa. Perda ICMP não mede perda RTP.
O MTR teve saltos que limitaram respostas; suas perdas intermediárias
não comprovam perda no encaminhamento.

### Matriz de vídeo

Dois processos Chromium, fonte de animação H.264 1080p60, mesma captura
reutilizada por grupo, sem áudio/simulcast, mídia UDP direta na VPS.
65 segundos após começar a reprodução por trecho; após excluir os primeiros
20 segundos da sessão, 46–50 segundos úteis. Valores abaixo são do espectador:

| Grupo/ordem | Teto / buffer solicitado | FPS médio | Tempo em Full HD | Congelamentos | Duração total |
|---|---|---|---|---|---|
| Matriz / 1 | 16 Mbps / 150 ms | 59,99 | 100% | 0 | 0 s |
| Matriz / 2 | 8 Mbps / 150 ms | 41,12 | 43% | 6 | 9,455 s |
| Matriz / 3 | 16 Mbps / 300 ms | 59,87 | 100% | 2 | 0,389 s |
| Matriz / 4 | 8 Mbps / 300 ms | 60,01 | 100% | 0 | 0 s |
| Repetição / 1 | 8 Mbps / 300 ms | 31,57 | 0% | 5 | 9,839 s |
| Repetição / 2 | 16 Mbps / 150 ms | 17,22 | 0% | 24 | 28,357 s |

As médias usam duração das amostras; 60,01 decorre dos intervalos do
relatório, não comprova captura acima do alvo. O buffer real médio nos
bons trechos de 300 ms foi 277–283 ms. No trecho ruim de 8 Mbps / 300 ms,
foi 195 ms: pedir mais buffer não garantiu esse valor nem preservou Full HD.
O atraso completo de ponta a ponta não foi medido.

O socket WebRTC do MediaMTX tinha 1.009.097 descartes históricos por falta
de buffer de recepção e buffer alocado de 212.992 bytes. O contador foi
lido dentro do namespace de rede do container, não somente no host.
**Não cresceu em nenhum dos seis trechos**, e não houve novos erros de
envio UDP do container. Os contadores globais de erro de buffer UDP desta
máquina também não cresceram durante os trechos de vídeo. Logo, os valores
históricos não demonstram esse gargalo nas rodadas atuais.
Nos trechos ruins o publicador registrou retransmissões e limitação por
banda; não houve amostras classificadas como limitação por CPU.
Snapshots de CPU/memória são pontuais e não descartam picos transitórios.

### Recomendação após esses testes

Manter o MediaMTX enquanto se verifica a conexão por cabo e com espectador
em outra rede. Há perda mensurável no teste UDP independente da stack de
vídeo; diminuir o teto e aumentar o buffer não sustentou 1080p60 nas
repetições. Ainda não há um perfil vencedor ou prova de que mudar WHIP/SFU
resolva a qualidade. Se o teste por cabo continuar ruim, comparar uma rota
ou VPS de menor RTT mantendo fonte e espectadores iguais.

A página de benchmark permite escolher teto e buffer e exporta os valores
usados; o teste unitário confere a configuração do sender, do receiver e
os metadados. Os parâmetros de produção não foram alterados nesta etapa.
Uma tentativa inicial de reutilizar imediatamente a sala foi recusada
porque o host anterior ainda estava ativo; foi descartada, e os trechos
seguintes usaram salas independentes por perfil.

Resultados completos: `.cache/network-benchmark/`, incluindo JSONs por
função/perfil, resumo, iperf, pings e snapshots. Os containers de diagnóstico,
as regras temporárias de firewall, o proxy local e o túnel SSH foram
removidos. O repo e o compose da VPS permanecem sem alterações; nenhum
container de produção foi reiniciado.

Referências: [iperf3 — opções de teste UDP e sentidos](https://software.es.net/iperf/invoking.html),
[MDN — jitterBufferTarget](https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpReceiver/jitterBufferTarget).
