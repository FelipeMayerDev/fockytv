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

// poda no boot: chat e histórico não têm valor depois de uns meses e o volume
// é pequeno. Sem isto as tabelas só crescem.
const KEEP_DAYS = +(process.env.KEEP_DAYS ?? 90)
const cutoff = Date.now() - KEEP_DAYS * 86_400_000
db.prepare(`DELETE FROM chat WHERE at < ?`).run(cutoff)
db.prepare(`DELETE FROM music_history WHERE played_at < ?`).run(cutoff)


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

// chat por sala (streamKey): insert + página de scrollback (mais antigas primeiro)
export const addChatMsg = (nick, text, at, room) =>
  db.prepare(`INSERT INTO chat (nick, text, at, room) VALUES (?, ?, ?, ?)`)
    .run(nick, text, at, room)
export const chatPage = (room, beforeId, limit = 50) =>
  db.prepare(`SELECT id, nick AS "from", text, at FROM chat
              WHERE room = ? AND id < ? ORDER BY id DESC LIMIT ?`)
    .all(room, beforeId, limit).reverse()
export const chatLatest = (room, limit = 50) =>
  db.prepare(`SELECT id, nick AS "from", text, at FROM chat
              WHERE room = ? ORDER BY id DESC LIMIT ?`).all(room, limit).reverse()

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
