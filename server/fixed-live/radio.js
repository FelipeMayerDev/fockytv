// Player de música por call do Discord (plugin FockyTV): uma fila por canal de voz,
// o relógio fica aqui e cada plugin toca o mesmo trecho localmente. O áudio vem do
// yt-dlp e vive só em memória: a faixa atual e a próxima; o resto é baixado na vez.
//
//   WS   /api/fixed/ws/radio?room=<canal>&user=<id>&name=<nome>   estado + comandos
//   GET  /api/fixed/radio/<canal>/<uid>                          bytes da faixa
//
// Todo plugin na call abre o WS (o botão pulsa para quem ainda não entrou);
// "ouvindo" é só quem entrou no player. Identidade sem autenticação, como a
// presença: o "só quem adicionou remove" é contra engano, não contra má-fé.
import { randomUUID } from "node:crypto"
import { WebSocketServer } from "ws"

const MAX_QUEUE = 100
// ponytail: faixa inteira em memória (~1 MB/min); teto de 2 h. Disco se mixes longos pesarem.
const MAX_DURATION = 2 * 60 * 60
const EMPTY_MS = 60_000
const ID = /^\d{5,25}$/

export function createRadio ({ download, log = () => {}, emptyMs = EMPTY_MS }) {
  const rooms = new Map() // canal -> sala
  const wss = new WebSocketServer({ noServer: true })
  wss.on("error", e => log("[radio] wss error:", e.message))

  const current = room => room.queue[room.index]
  const running = room => !room.paused && room.ready
  const position = room => running(room) ? (Date.now() - room.startedAt) / 1000 : room.offset

  const send = (ws, obj) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)) }
  const broadcast = room => {
    const state = {
      type: "state",
      queue: room.queue.map(({ audio, ...track }) => track),
      index: room.index,
      playing: !room.paused,
      ready: room.ready,
      position: position(room),
      listeners: [...new Set([...room.clients.values()].filter(c => c.listening).map(c => c.name))],
    }
    for (const ws of room.clients.keys()) send(ws, state)
  }

  // Só a atual e a próxima ficam baixadas; as outras soltam o buffer.
  const prefetch = room => {
    room.queue.forEach((track, i) => {
      if (i !== room.index && i !== room.index + 1) track.audio = undefined
      else if (!track.audio) (track.audio = download(track.id)).catch(() => {}) // a falha é tratada na vez dela
    })
  }

  const schedule = room => {
    clearTimeout(room.timer)
    const track = current(room)
    if (track && running(room))
      room.timer = setTimeout(() => start(room, room.index + 1), Math.max(0, track.duration - position(room)) * 1000)
  }

  // Troca a faixa atual; o relógio só anda quando o áudio terminou de baixar,
  // para todos começarem juntos do zero.
  function start (room, index) {
    clearTimeout(room.timer)
    room.index = Math.min(Math.max(0, index), room.queue.length)
    room.offset = 0
    room.ready = false
    prefetch(room)
    const track = current(room)
    broadcast(room)
    if (!track) return
    track.audio.then(() => {
      if (current(room) !== track) return
      room.ready = true
      room.startedAt = Date.now()
      schedule(room)
      broadcast(room)
    }, error => {
      if (current(room) !== track) return
      log(`[radio] ${track.id}:`, error.message)
      for (const ws of room.clients.keys()) send(ws, { type: "error", message: `Não deu para tocar "${track.title}".` })
      start(room, room.index + 1)
    })
  }

  const commands = {
    add (room, client, { track }) {
      if (room.queue.length >= MAX_QUEUE) throw new Error("Fila cheia.")
      const id = String(track?.id ?? "")
      const duration = Number(track?.duration)
      if (!/^[\w-]{11}$/.test(id)) throw new Error("Vídeo inválido.")
      if (!(duration > 0 && duration <= MAX_DURATION)) throw new Error("Só faixas de até 2 h (sem lives).")
      room.queue.push({
        uid: randomUUID(), id, duration,
        title: String(track.title ?? id).slice(0, 200),
        channel: String(track.channel ?? "").slice(0, 100),
        thumb: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
        by: client.user, byName: client.name,
      })
      // Fila parada no fim: a nova faixa já começa a tocar.
      if (room.index === room.queue.length - 1) { room.paused = false; start(room, room.index) }
      else { prefetch(room); broadcast(room) }
    },
    remove (room, client, { uid }) {
      const i = room.queue.findIndex(track => track.uid === uid)
      if (i < 0) return
      if (room.queue[i].by !== client.user) throw new Error("Só quem adicionou pode remover.")
      room.queue.splice(i, 1)
      if (i < room.index) room.index--
      if (i === room.index) start(room, room.index)
      else { prefetch(room); broadcast(room) }
    },
    play (room, client, { uid }) {
      const i = room.queue.findIndex(track => track.uid === uid)
      if (i < 0) return
      room.paused = false
      start(room, i)
    },
    next (room) { if (current(room)) start(room, room.index + 1) },
    pause (room) {
      if (room.paused) return
      room.offset = position(room)
      room.paused = true
      schedule(room)
      broadcast(room)
    },
    resume (room) {
      if (!room.paused) return
      room.paused = false
      room.startedAt = Date.now() - room.offset * 1000
      schedule(room)
      broadcast(room)
    },
    listen (room, client, { on }) { client.listening = !!on; broadcast(room) },
  }

  wss.on("connection", (ws, req) => {
    ws.on("error", e => log("[radio] ws error:", e.message))
    const u = new URL(req.url, "http://x")
    const id = u.searchParams.get("room") ?? ""
    const user = u.searchParams.get("user") ?? ""
    const name = (u.searchParams.get("name") ?? "").trim().slice(0, 32) || user
    if (!ID.test(id) || !ID.test(user)) return ws.close(4001, "room e user obrigatórios")
    let room = rooms.get(id)
    if (!room) rooms.set(id, room = { queue: [], index: 0, paused: false, ready: false, offset: 0, startedAt: 0, clients: new Map() })
    clearTimeout(room.emptyTimer)
    const client = { user, name, listening: false }
    room.clients.set(ws, client)
    broadcast(room)

    ws.on("message", data => {
      let msg
      try { msg = JSON.parse(data) } catch { return }
      if (!Object.hasOwn(commands, msg?.type)) return
      try { commands[msg.type](room, client, msg) } catch (e) { send(ws, { type: "error", message: e.message }) }
    })
    ws.on("close", () => {
      room.clients.delete(ws)
      broadcast(room)
      // Sala vazia some depois de um tempo (recarregar o Discord não perde a fila).
      if (!room.clients.size) room.emptyTimer = setTimeout(() => {
        if (room.clients.size) return
        clearTimeout(room.timer)
        rooms.delete(id)
      }, emptyMs)
    })
  })

  return {
    upgrade: (req, sock, head) => wss.handleUpgrade(req, sock, head, ws => wss.emit("connection", ws, req)),
    // Bytes da faixa, só enquanto ela é a atual ou a próxima da sala.
    async audio (roomId, uid) {
      const track = rooms.get(roomId)?.queue.find(entry => entry.uid === uid)
      return track?.audio ? await track.audio : null
    },
  }
}
