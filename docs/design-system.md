# Design system — "Cinema Escuro"

A direção visual do FockyTV: preto quente, um acento âmbar, tipografia
display na marca, miniaturas grandes. A grade ao vivo é vitrine; a
telemetria é discreta.

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

- **Superfícies**: `--background` (fundo) → `--surface-2`/`--card` (barras,
  cards) → `--muted` (chip, hover). `--border` é hairline, nunca fundo.
- **Texto**: `--foreground` (off-white quente), `--muted-foreground`
  (secundário). Nada entre os dois.
- **Acento**: `--accent` (= `--primary`, `--ring`). Âmbar é CTA, link,
  progresso e foco — **nada mais**. Se aparecer em três lugares na mesma
  tela, um deles está errado.
- **Estados**: `--destructive` (AO VIVO, parar, erro), `--success` (voz
  detectada na sala), `--warning` (avisos da sala de músicos).
- **Tipo**: `--font-sans` (IBM Plex Sans) em tudo; `--font-display`
  (Bricolage Grotesque) só em marca e números grandes.
- **Forma**: `--radius` em controles (botão, input, chip, 36px de altura),
  `--radius-card` (18px) em miniatura, card e diálogo, `--radius-media`
  (10px) em thumb de lista, `--radius-pill` em pílulas.
- **Profundidade**: `--shadow-card` no hover da miniatura, no diálogo, no
  toast e na capa da música; `--glow-top` é o brilho âmbar no topo da
  grade e dos canais música/sala; `--scrim` é o véu sobre vídeo (overlay
  de play, loading, backdrop de diálogo) — um só, não três pretos.

Único literal permitido: `background:#000` atrás de vídeo e thumbnail
(letterbox), que é preto de verdade, não cor de tema.

As fontes vêm do Google Fonts (`ui/index.html`, `<head>`). Sem rede o
fallback é `system-ui` — o layout não quebra, só perde caráter.

## Padrões

- **Botão**: altura 36px, `var(--radius)`, `gap:8px`, ícone 16px stroke.
  `primary` (âmbar, só um por tela) · `outline` · `ghost` · `destructive`.
- **Pílula** (`.pill`): 30px, borda hairline, arredondada; leitura passiva
  (no ar, viewers, qualidade). Nunca clicável.
- **Card de live** (`.vid`): miniatura 16/9 com `--radius-card` e hairline;
  hover acende a borda em âmbar e sobe a sombra. Badge AO VIVO embaixo à
  esquerda, duração à direita.
- **Painel lateral** 360px (`#fixed-panel`, `#jam-panel`): fundo `--card`,
  borda só à esquerda, sem raio.
- **Ícones**: SVG inline, grade 24, `stroke:currentColor`, `stroke-width:2`,
  pontas arredondadas. Sem emoji na interface.
- **Progresso e seek** são âmbar; o play principal é branco sólido.
- **Diálogo**: `--radius-card`, `--shadow-card`, backdrop `--scrim` com
  blur; título em `--font-display` 20px; ações à direita, primário âmbar
  por último. Só para decisão do usuário.
- **Toast**: fundo `--surface-2`, borda esquerda de 3px — vermelha em erro,
  âmbar em `.info`. Nunca mais de um por vez.
- **Overlay sobre vídeo** (play bloqueado, loading, dock do /yt): `--scrim`,
  texto em `--foreground`. Nada de preto solto com alfa.
- **Painel lateral** de 360px: `--surface-2`, título em `--font-display` 17px.
- **Marcação de "agora"** (fila de música): fundo `hsl(var(--accent) / .12)`
  e título âmbar — nunca fundo âmbar sólido.

## Ao adicionar tela nova

1. Consuma tokens; não invente cor.
2. Flex/grid com `gap` — nada de margem entre irmãos.
3. Um acento por tela, um CTA primário por tela.
4. Alvo de clique ≥ 36px (44px onde é toque, como o player).
5. Copy em português, minúsculo e direto, no tom do resto do app.
