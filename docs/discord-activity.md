# FockyTV como Discord Activity

O app já é servido na web pelo broadcast-box; a Activity só embute essa mesma
página num iframe dentro do canal de voz. Nada de backend novo — só HTTPS
público, registro no Discord e o módulo `ui/discord.js` (que é inerte fora do
iframe do Discord).

## 1. Expor o servidor com HTTPS (Cloudflare)

O Discord exige HTTPS em domínio público. Como já usamos Cloudflare, o caminho
curto pra teste é um túnel `cloudflared` apontando pro broadcast-box:

    cloudflared tunnel --url http://localhost:8080

(pra algo duradouro, criar um tunnel nomeado com DNS `fockytv.example.com` →
`http://broadcast-box:8080` e rodar como serviço).

## 2. Registrar a aplicação

1. <https://discord.com/developers/applications> → New Application.
2. Na aba **Activities → URL Mappings**, adicionar o domínio do túnel
   (ex.: `https://fockytv.example.com`).
3. Em **Activities → General**, marcar "Publicly visible" quando pronto pra
   testar fora do servidor de dev.

## 3. Testar

Num servidor de teste, com alguém (ou só você) num canal de voz, rodar o
comando `/activity` e escolher a aplicação. O Discord abre a URL mapeada com
query params (`frame_id`, `channel_id`, ...) — é o `frame_id` que o
`ui/discord.js` usa pra detectar o ambiente.

Primeira vez num servidor, o lançamento via **Developer Activity** no portal
também funciona (disponível só para o time de dev).

## 4. Como a integração se comporta

- **Fora do Discord** (Electron/navegador): nada muda; o `discord.js` nem é
  importado (a página carrega sem requisitar o esm.sh).
- **Dentro do Discord**: o SDK inicializa após `ready()` e o nick é
  pré-preenchido com o username do Discord (charset `a-z 0-9 . _` casa com a
  validação de nick/stream key do app).
- O `serverUrl` cai no fallback `location.origin` — ou seja, a URL do túnel.
  O WHIP/WHEP atravessa o Cloudflare (WebRTC sobre HTTPS funciona; verificar
  se o proxy do túnel deixa o tráfego passar sem timeout).

## Pendências conhecidas

- **Captura de tela no iframe**: `getDisplayMedia` dentro da Activity depende
  da permissão do iframe (`allow="display-capture"`) e do suporte do client.
  Quem transmite pode precisar continuar pelo app desktop; assistir pela
  Activity deve funcionar direto. A testar com client real.
- **SDK via CDN**: hoje `https://esm.sh/@discord/embedded-app-sdk`. Se a
  estabilidade incomodar, fixar versão ou vendor do arquivo no `ui/assets/`.
- **Sincronização de sala**: cada participante da Activity pode ver o player
  independente; o estado compartilhado (o que está tocando) hoje já vem do
  servidor, então deve bastar. Os SDK commands do Discord ficam como opção
  futura.
