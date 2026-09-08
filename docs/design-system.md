# Design system — "Sala de Vidro"

A direção visual do FockyTV: violeta profundo com brilhos de violeta e
ciano no fundo, painéis de vidro fosco, controles em pílula e um par de
acentos em gradiente. A sala é o produto — chat, quem está junto e a fila
de música ficam sempre à vista.

## Onde mexer

| Arquivo | O que é | Regra |
|---|---|---|
| `ui/assets/theme.css` | **tokens** — cor, tipo, raio, sombra | único lugar que *define* valor |
| `ui/assets/app.css` | **componentes** — header, grade, player, sala, diálogos | só *consome* `var(--…)` |
| `ui/index.html` | markup + lógica | sem `<style>`; classes já existentes |

Mudar a identidade inteira = editar só `theme.css`. Se você precisou
escrever um hex ou um `hsl(…)` literal em `app.css`, o token está
faltando — crie em `theme.css`.

Os arquivos vivem em `ui/assets/` de propósito: `server/docker-compose.yml`
monta os arquivos de `ui/` **um a um**, mas `ui/assets` inteiro como
diretório. CSS novo ali não pede mount novo nem `docker compose restart`
por causa do gotcha de inode (ver `AGENTS.md`).

## Tokens

Cor é tripla HSL sem `hsl()` — permite alfa: `hsl(var(--accent) / .4)`.

- **Superfícies**: `--background` (fundo, com `--glow-top` fixo atrás de
  tudo) → **vidro** (`--glass`, `--glass-strong`, `--glass-border`,
  `--blur`) em painel, card, pílula, toast e diálogo → `--muted` para o
  que precisa ser opaco (hover de lista, fundo de miniatura).
  Os tokens de vidro já vêm com alfa: entram como `var(--glass)`, sem
  `hsl()` em volta. Vidro sempre acompanhado de `backdrop-filter:var(--blur)`
  e da borda `--glass-border` — sem a borda ele some no fundo.
- **Texto**: `--foreground` (off-white quente), `--muted-foreground`
  (secundário). Nada entre os dois.
- **Acento**: par `--accent` (violeta) e `--accent-2` (ciano), combinados
  em `--grad-accent` sempre a 120deg, no mesmo sentido. O gradiente é do
  CTA primário, do avatar, do play principal e do seu balão no chat. Cor
  chapada (`hsl(var(--accent))`) é para link, foco, progresso e a faixa
  tocando. Um CTA em gradiente por tela.
- **Estados**: `--destructive` (AO VIVO, parar, erro), `--success` (voz
  detectada na sala), `--warning` (avisos da sala de músicos).
- **Tipo**: `--font-sans` (Public Sans) em tudo; `--font-display` (Outfit,
  peso 600/700) em marca, títulos de painel e de diálogo.
- **Forma**: `--radius-pill` em botão, input, pílula e avatar (controles
  têm 40px de altura); `--radius-card` (22px) em painel, card, miniatura e
  diálogo; `--radius` (14px) em linha de lista e chip; `--radius-media`
  (14px) em thumb de lista.
- **Profundidade**: `--shadow-card` no diálogo, no toast, no hover da
  miniatura e na capa da música; `--glow-top` são os dois brilhos
  (violeta em cima à esquerda, ciano embaixo à direita) fixos no `body`;
  `--scrim` é o véu sobre vídeo (overlay de play, loading, backdrop de
  diálogo) — um só, não três pretos.

Único literal permitido: `background:#000` atrás de vídeo e thumbnail
(letterbox), que é preto de verdade, não cor de tema.

As fontes vêm do Google Fonts (`ui/index.html`, `<head>`). Sem rede o
fallback é `system-ui` — o layout não quebra, só perde caráter.

## Padrões

- **Botão**: altura 40px, `--radius-pill`, `gap:8px`, ícone 16px stroke.
  `primary` (gradiente, só um por tela) · `outline` (vidro) · `ghost` ·
  `destructive`.
- **Pílula** (`.pill`): 32px de vidro; leitura passiva (no ar, viewers,
  qualidade). Nunca clicável.
- **Card de live** (`.vid`): miniatura 16/9 com `--radius-card` e hairline;
  hover acende a borda em âmbar e sobe a sombra. Badge AO VIVO embaixo à
  esquerda, duração à direita.
- **Painel lateral** 360px (`#fixed-panel`, `#jam-panel`): vidro com blur,
  borda só à esquerda, sem raio.
- **Chat da sala**: balões — os dos outros em vidro alinhados à esquerda,
  os seus em `--grad-accent` à direita; nick em cima, dentro do balão.
- **Ícones**: SVG inline, grade 24, `stroke:currentColor`, `stroke-width:2`,
  pontas arredondadas. Sem emoji na interface.
- **Progresso e seek** são violeta chapado; o play principal é o gradiente.
- **Diálogo**: `--radius-card`, `--shadow-card`, backdrop `--scrim` com
  blur; título em `--font-display` 22px; ações à direita, primário âmbar
  por último. Só para decisão do usuário.
- **Toast**: fundo `--surface-2`, borda esquerda de 3px — vermelha em erro,
  âmbar em `.info`. Nunca mais de um por vez.
- **Overlay sobre vídeo** (play bloqueado, loading, dock do /yt): `--scrim`,
  texto em `--foreground`. Nada de preto solto com alfa.
- **Painel lateral** de 360px: `--surface-2`, título em `--font-display` 17px.
- **Marcação de "agora"** (fila de música): fundo `hsl(var(--accent) / .16)`
  e título violeta — nunca fundo sólido.

## Ao adicionar tela nova

1. Consuma tokens; não invente cor.
2. Flex/grid com `gap` — nada de margem entre irmãos.
3. Um CTA em gradiente por tela; o resto é vidro.
4. Alvo de clique ≥ 40px (44px onde é toque, como o player).
5. Vidro custa GPU: no máximo duas camadas com blur sobrepostas.
6. Copy em português, minúsculo e direto, no tom do resto do app.
