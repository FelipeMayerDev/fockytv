import { randomUUID } from 'node:crypto'

// Relógio da watch party no mesmo protocolo yt do jam. Nunca usa o relógio do cliente.
export function jamYtState (now = Date.now) {
  let state = null
  let queue = []
  const viewers = new Set()
  const members = () => ({ type: 'yt', action: 'members', viewers: [...viewers] })
  const snapshot = () => state && ({ ...state, queue, action: 'state', pos: state.pos + (state.playing ? Math.max(0, now() - state.at) / 1000 : 0), at: now() })
  const start = (track, from) => { state = { type: 'yt', action: 'state', uid: track.uid, videoId: track.id, playing: true, pos: 0, at: now(), from } }
  return {
    snapshot,
    members,
    listen (nick, on) { if (on) viewers.add(nick); else viewers.delete(nick); return members() },
    command (msg, from) {
      if (msg.action === 'add' || msg.action === 'load') {
        if (typeof msg.videoId !== 'string' || !/^[\w-]{11}$/.test(msg.videoId) || msg.action === 'add' && queue.length >= 100) return null
        const track = { uid: randomUUID(), id: msg.videoId, title: typeof msg.title === 'string' ? msg.title.slice(0, 200) : msg.videoId }
        if (msg.action === 'load' || state?.finished) queue = []
        queue.push(track)
        if (!state || queue.length === 1) start(track, from)
      } else if (msg.action === 'next') {
        // Vários players terminam juntos: só a primeira mensagem avança a fila.
        if (!state || msg.uid !== state.uid) return null
        if (queue.length > 1) { queue.shift(); start(queue[0], from) }
        else state = { ...state, pos: snapshot().pos, playing: false, finished: true, at: now() }
      } else {
        if (!state || msg.videoId !== state.videoId || !['state', 'seek'].includes(msg.action) ||
            typeof msg.playing !== 'boolean' || !Number.isFinite(msg.pos) || msg.pos < 0 || msg.pos > 86400) return null
        state = { ...state, pos: msg.pos, playing: msg.playing, finished: false, at: now(), from }
      }
      return snapshot()
    }
  }
}
