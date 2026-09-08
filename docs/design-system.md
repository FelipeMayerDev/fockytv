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
  `--radius-card` (18px) em miniatura e card, `--radius-pill` em pílulas.
- **Profundidade**: `--shadow-card` no hover da miniatura; `--glow-top` é
  o brilho âmbar no topo da grade.

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
- **Feedback**: erro no `#toast` (borda esquerda vermelha), info no mesmo
  toast em âmbar. Diálogo só para decisão do usuário.

## Ao adicionar tela nova

1. Consuma tokens; não invente cor.
2. Flex/grid com `gap` — nada de margem entre irmãos.
3. Um acento por tela, um CTA primário por tela.
4. Alvo de clique ≥ 36px (44px onde é toque, como o player).
5. Copy em português, minúsculo e direto, no tom do resto do app.
