// Persistência do fixed-live: SQLite num volume (DATA_DIR, montado pelo
// compose). Antes daqui tudo era memória — reinício apagava chat, histórico.
import Database from "better-sqlite3"
import { mkdirSync } from "node:fs"
import { join } from "node:path"

const dir = process.env.DATA_DIR ?? "/app/data"
mkdirSync(dir, { recursive: true })
const db = new Database(join(dir, "fockytv.db"))
db.pragma("journal_mode = WAL")

db.exec(`
CREATE TABLE IF NOT EXISTS music_history (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id  TEXT NOT NULL,
  title     TEXT NOT NULL,
  thumb     TEXT,
  added_by  TEXT,
  played_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_music_played ON music_history(played_at);

CREATE TABLE IF NOT EXISTS chat (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  nick TEXT NOT NULL,
  text TEXT NOT NULL,
  at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS clips (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  vod_id     INTEGER NOT NULL,
  file       TEXT NOT NULL,
  at         REAL DEFAULT 0,
  duration   REAL DEFAULT 30,
  created_at INTEGER NOT NULL
);
`)
// tabela criada antes de existir sala por stream: coluna entra por ALTER
try { db.exec(`ALTER TABLE chat ADD COLUMN room TEXT NOT NULL DEFAULT ''`) } catch {}
// scrollback filtra por room ordenando por id: sem índice vira full scan
db.exec(`CREATE INDEX IF NOT EXISTS idx_chat_room ON chat(room, id)`)

// chat v2 (estilo Fluxer/Discord): resposta, edição e apagado (soft) entram
// por ALTER — bancos existentes migram sem migration. sys = linha de evento
// ("subiu ao ar"), que nenhum nick de usuário produz (nick não tem coluna
// própria porque o autor dela é o sistema, não uma pessoa).
try { db.exec(`ALTER TABLE chat ADD COLUMN reply_to INTEGER`) } catch {}
try { db.exec(`ALTER TABLE chat ADD COLUMN edited_at INTEGER`) } catch {}
try { db.exec(`ALTER TABLE chat ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0`) } catch {}
try { db.exec(`ALTER TABLE chat ADD COLUMN sys INTEGER NOT NULL DEFAULT 0`) } catch {}

db.exec(`
CREATE TABLE IF NOT EXISTS chat_reaction (
  msg_id INTEGER NOT NULL,
  emoji  TEXT NOT NULL,
  nick   TEXT NOT NULL,
  at     INTEGER NOT NULL,
  PRIMARY KEY (msg_id, emoji, nick)
);
`)

// poda no boot: chat e histórico não têm valor depois de uns meses e o volume
// é pequeno. Sem isto as tabelas só crescem.
const KEEP_DAYS = +(process.env.KEEP_DAYS ?? 90)
const cutoff = Date.now() - KEEP_DAYS * 86_400_000
db.prepare(`DELETE FROM chat WHERE at < ?`).run(cutoff)
db.prepare(`DELETE FROM music_history WHERE played_at < ?`).run(cutoff)
// reações órfãs (mensagem podada por idade ou apagada de verdade não existe:
// o delete é soft, então órfão aqui é só msg fora da janela de retenção)
db.prepare(`DELETE FROM chat_reaction WHERE msg_id NOT IN (SELECT id FROM chat)`).run()


// tabela criada antes de existir histórico por canal: coluna entra por ALTER
try { db.exec(`ALTER TABLE music_history ADD COLUMN kind TEXT NOT NULL DEFAULT 'music'`) } catch {}
try { db.exec(`ALTER TABLE clips ADD COLUMN stream_key TEXT`) } catch {}

// faixa/vídeo que começou a tocar de fato no canal (playCurrent/tvPlay no "live")
export const logTrackPlayed = (t, kind = "music") =>
  db.prepare(`INSERT INTO music_history (video_id, title, thumb, added_by, played_at, kind)
              VALUES (@video_id, @title, @thumb, @added_by, @played_at, @kind)`)
    .run({ ...t, kind })

// últimos itens do canal `kind` desde `since` (ms epoch), mais novos primeiro
export const mediaHistory = (kind, since, limit = 200) =>
  db.prepare(`SELECT video_id AS id, title, thumb, added_by AS addedBy, played_at AS playedAt
              FROM music_history WHERE kind = ? AND played_at >= ? ORDER BY played_at DESC LIMIT ?`)
    .all(kind, since, limit)

// chat por sala (streamKey): insert + página de scrollback (mais antigas
// primeiro). As linhas já saem enriquecidas (reply resolvido, reações
// agregadas) — a UI não monta nada: o que ela recebe é o que ela mostra.
const CHAT_SELECT = `
  SELECT c.id, c.nick AS "from", c.text, c.at, c.sys, c.deleted,
         c.edited_at AS editedAt, c.reply_to AS replyTo,
         p.nick AS replyFrom, p.deleted AS replyDeleted,
         substr(p.text, 1, 140) AS replyText
  FROM chat c LEFT JOIN chat p ON p.id = c.reply_to`

const chatReactionsFor = ids => {
  const map = new Map()
  if (!ids.length) return map
  const rows = db.prepare(
    `SELECT msg_id, emoji, nick FROM chat_reaction WHERE msg_id IN (${ids.map(() => "?").join(",")}) ORDER BY at`
  ).all(...ids)
  for (const r of rows) {
    const list = map.get(r.msg_id) ?? []
    const entry = list.find(e => e.emoji === r.emoji)
    if (entry) entry.nicks.push(r.nick)
    else list.push({ emoji: r.emoji, nicks: [r.nick] })
    map.set(r.msg_id, list)
  }
  return map
}

const chatDecorate = rows => {
  const reactions = chatReactionsFor(rows.map(r => r.id))
  for (const r of rows) {
    r.reactions = reactions.get(r.id) ?? []
    r.replyDeleted = !!r.replyDeleted
    if (r.replyDeleted) r.replyText = null   // apagada: a UI mostra placeholder
  }
  return rows
}

export const addChatMsg = (nick, text, at, room, { replyTo = null, sys = 0 } = {}) =>
  db.prepare(`INSERT INTO chat (nick, text, at, room, reply_to, sys) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(nick, text, at, room, replyTo, sys)
export const chatGet = (room, id) =>
  chatDecorate([db.prepare(`${CHAT_SELECT} WHERE c.room = ? AND c.id = ?`).get(room, id)]
    .filter(Boolean))[0]
export const chatPage = (room, beforeId, limit = 50) =>
  chatDecorate(db.prepare(`${CHAT_SELECT}
              WHERE c.room = ? AND c.id < ? ORDER BY c.id DESC LIMIT ?`)
    .all(room, beforeId, limit).reverse())
export const chatLatest = (room, limit = 50) =>
  chatDecorate(db.prepare(`${CHAT_SELECT}
              WHERE c.room = ? ORDER BY c.id DESC LIMIT ?`).all(room, limit).reverse())

// edit/apagar: só o autor — WHERE leva o nick e o changedness decide
export const editChatMsg = (room, id, nick, text, editedAt) =>
  db.prepare(`UPDATE chat SET text = ?, edited_at = ? WHERE room = ? AND id = ? AND nick = ? AND deleted = 0 AND sys = 0`)
    .run(text, editedAt, room, id, nick).changes > 0
export const deleteChatMsg = (room, id, nick) =>
  db.prepare(`UPDATE chat SET deleted = 1 WHERE room = ? AND id = ? AND nick = ? AND deleted = 0 AND sys = 0`)
    .run(room, id, nick).changes > 0

// reação é toggle: um (msg, emoji, nick) existe no máximo uma vez
export const toggleChatReaction = (room, id, emoji, nick, at) => {
  const msg = db.prepare(`SELECT id FROM chat WHERE room = ? AND id = ? AND deleted = 0`).get(room, id)
  if (!msg) return null
  const has = db.prepare(`SELECT 1 FROM chat_reaction WHERE msg_id = ? AND emoji = ? AND nick = ?`).get(id, emoji, nick)
  if (has) db.prepare(`DELETE FROM chat_reaction WHERE msg_id = ? AND emoji = ? AND nick = ?`).run(id, emoji, nick)
  else db.prepare(`INSERT INTO chat_reaction (msg_id, emoji, nick, at) VALUES (?, ?, ?, ?)`).run(id, emoji, nick, at)
  return chatReactionsFor([id]).get(id) ?? []
}

// clips: trechos de 30s de uma gravação, com link compartilhável
export const addClip = c =>
  db.prepare(`INSERT INTO clips (vod_id, stream_key, file, at, duration, created_at)
              VALUES (@vod_id, @stream_key, @file, @at, @duration, @created_at)`).run(c)
export const getClip = id =>
  db.prepare(`SELECT id, vod_id AS vodId, stream_key AS streamKey, file, at, duration, created_at AS createdAt
              FROM clips WHERE id = ?`).get(id)
export const updateClipFile = (id, file, at, duration) =>
  db.prepare(`UPDATE clips SET file = ?, at = ?, duration = ? WHERE id = ?`).run(file, at, duration, id)
export const delClip = id => db.prepare(`DELETE FROM clips WHERE id = ?`).run(id)
export const listClips = (vodId, limit = 100) =>
  (vodId
    ? db.prepare(`SELECT id, vod_id AS vodId, stream_key AS streamKey, at, duration, created_at AS createdAt
                  FROM clips WHERE vod_id = ? ORDER BY id DESC LIMIT ?`).all(vodId, limit)
    : db.prepare(`SELECT id, vod_id AS vodId, stream_key AS streamKey, at, duration, created_at AS createdAt
                  FROM clips ORDER BY id DESC LIMIT ?`).all(limit))
