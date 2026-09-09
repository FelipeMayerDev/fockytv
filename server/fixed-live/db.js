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
`)
// tabela criada antes de existir sala por stream: coluna entra por ALTER
try { db.exec(`ALTER TABLE chat ADD COLUMN room TEXT NOT NULL DEFAULT ''`) } catch {}


// faixa que começou a tocar de fato no canal de música (playCurrent no "live")
export const logTrackPlayed = t =>
  db.prepare(`INSERT INTO music_history (video_id, title, thumb, added_by, played_at)
              VALUES (@video_id, @title, @thumb, @added_by, @played_at)`).run(t)

// últimas faixas desde `since` (ms epoch), mais novas primeiro
export const musicHistory = (since, limit = 200) =>
  db.prepare(`SELECT video_id AS id, title, thumb, added_by AS addedBy, played_at AS playedAt
              FROM music_history WHERE played_at >= ? ORDER BY played_at DESC LIMIT ?`)
    .all(since, limit)

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
