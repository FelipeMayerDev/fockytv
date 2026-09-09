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
`)

// faixa que começou a tocar de fato no canal de música (playCurrent no "live")
export const logTrackPlayed = t =>
  db.prepare(`INSERT INTO music_history (video_id, title, thumb, added_by, played_at)
              VALUES (@video_id, @title, @thumb, @added_by, @played_at)`).run(t)

// últimas faixas desde `since` (ms epoch), mais novas primeiro
export const musicHistory = (since, limit = 200) =>
  db.prepare(`SELECT video_id AS id, title, thumb, added_by AS addedBy, played_at AS playedAt
              FROM music_history WHERE played_at >= ? ORDER BY played_at DESC LIMIT ?`)
    .all(since, limit)
