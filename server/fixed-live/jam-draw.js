// Estado das anotações (caneta/laser) das salas watch, um registro por alvo
// (dono da live). Os traços ficam guardados para quem entrar depois; o laser
// é só broadcast. O alvo "allow" só aceita do próprio dono (msg.target === nick).
const LIMITS = { strokes: 64, points: 250, targets: 8, colors: 5, message: 200 }

export function jamDraw (now = Date.now) {
  const targets = new Map() // alvo -> { allowed, strokes: [{ id, from, color, pts }], at }
  const round = v => Math.round(v * 100) / 100
  const clamp = v => Math.min(1, Math.max(0, v))
  const state = target => {
    let entry = targets.get(target)
    if (!entry) {
      entry = { allowed: true, strokes: [], at: now() }
      targets.set(target, entry)
      // Sala com muitas lives ao mesmo tempo: esquece o alvo sem atividade há mais tempo.
      if (targets.size > LIMITS.targets) {
        const oldest = [...targets.entries()].sort((a, b) => a[1].at - b[1].at)[0]
        targets.delete(oldest[0])
      }
    }
    entry.at = now()
    return entry
  }
  const snapshot = target => {
    const entry = targets.get(target)
    return { target, allowed: entry?.allowed ?? true, strokes: entry ? entry.strokes.map(s => ({ id: s.id, from: s.from, color: s.color, pts: s.pts })) : [] }
  }
  return {
    // Estado completo da sala, enviado a quem acabou de entrar.
    sync () { return { type: 'draw', action: 'sync', targets: [...targets.keys()].map(snapshot) } },
    // Um alvo específico: o cliente pede ao montar o tile de uma live.
    resync (target) {
      if (typeof target !== 'string' || !/^\d{5,25}$/.test(target)) return null
      return { type: 'draw', action: 'sync', targets: [snapshot(target)] }
    },
    // Valida e aplica; devolve a mensagem pra retransmitir (ou null se inválida).
    apply (msg, from) {
      if (!msg || typeof msg.action !== 'string' || typeof msg.target !== 'string' || !/^\d{5,25}$/.test(msg.target)) return null
      if (!['laser', 'allow', 'begin', 'points', 'end', 'undo', 'clear'].includes(msg.action)) return null
      // Allow é do dono da live: negado nem cria registro.
      if (msg.action === 'allow' && (msg.target !== from || typeof msg.on !== 'boolean')) return null
      const entry = state(msg.target)
      switch (msg.action) {
        case 'laser': {
          if (!Array.isArray(msg.pts) || msg.pts.length !== 2 || !msg.pts.every(v => Number.isFinite(v))) return null
          return { ...msg, from, pts: msg.pts.map(v => round(clamp(v))) }
        }
        case 'allow': {
          entry.allowed = msg.on
          return { ...msg, from }
        }
        case 'begin': {
          if (typeof msg.id !== 'string' || !msg.id || msg.id.length > 40 ||
              !Number.isInteger(msg.color) || msg.color < 0 || msg.color >= LIMITS.colors) return null
          if (entry.strokes.some(s => s.id === msg.id && s.from === from)) return null
          entry.strokes.push({ id: msg.id, from, color: msg.color, pts: [] })
          if (entry.strokes.length > LIMITS.strokes) entry.strokes.shift()
          return { ...msg, from }
        }
        case 'points': {
          const stroke = typeof msg.id === 'string' && entry.strokes.find(s => s.id === msg.id && s.from === from)
          if (!stroke || !Array.isArray(msg.pts) || msg.pts.length > LIMITS.message || msg.pts.length % 2 ||
              !msg.pts.every(v => Number.isFinite(v))) return null
          for (let i = 0; i + 1 < msg.pts.length && stroke.pts.length < LIMITS.points; i += 2)
            stroke.pts.push(round(clamp(msg.pts[i])), round(clamp(msg.pts[i + 1])))
          return { ...msg, from }
        }
        case 'end': {
          const stroke = typeof msg.id === 'string' && entry.strokes.find(s => s.id === msg.id && s.from === from)
          if (stroke && !stroke.pts.length) entry.strokes.splice(entry.strokes.indexOf(stroke), 1)
          return { ...msg, from }
        }
        case 'undo': {
          for (let i = entry.strokes.length - 1; i >= 0; i--)
            if (entry.strokes[i].from === from) { entry.strokes.splice(i, 1); break }
          return { ...msg, from }
        }
        case 'clear': {
          // O dono da live apaga tudo; espectador apaga só o próprio.
          entry.strokes = msg.target === from ? [] : entry.strokes.filter(s => s.from !== from)
          return { ...msg, from }
        }
        default: return null
      }
    }
  }
}
