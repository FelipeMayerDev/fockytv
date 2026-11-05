// Anotações (caneta/laser) das salas watch: o traço é relay puro — efêmero,
// só vê quem está na sala na hora. O único estado guardado é o toggle
// "Permitir anotações" de cada alvo (dono da live), reenviado a quem entra depois.
const LIMITS = { targets: 8, colors: 5, message: 200 }

export function jamDraw (now = Date.now) {
  const targets = new Map() // alvo -> { allowed, at }
  const round = v => Math.round(v * 100) / 100
  const clamp = v => Math.min(1, Math.max(0, v))
  const state = target => {
    let entry = targets.get(target)
    if (!entry) {
      entry = { allowed: true, at: now() }
      targets.set(target, entry)
      // Sala com muitos alvos de uma vez: esquece o sem atividade há mais tempo.
      if (targets.size > LIMITS.targets) {
        const oldest = [...targets.entries()].sort((a, b) => a[1].at - b[1].at)[0]
        targets.delete(oldest[0])
      }
    }
    entry.at = now()
    return entry
  }
  const snapshot = target => ({ target, allowed: targets.get(target)?.allowed ?? true })
  // Traço e laser só atravessam: valida a forma, normaliza as coordenadas e espelha.
  const relay = (msg, from) => {
    if (!msg || typeof msg.action !== 'string' || typeof msg.target !== 'string' || !/^\d{5,25}$/.test(msg.target)) return null
    if (!['laser', 'begin', 'points', 'end', 'undo', 'clear'].includes(msg.action)) return null
    const pts = Array.isArray(msg.pts) ? msg.pts.map(v => round(clamp(v))) : undefined
    if (msg.action === 'laser' && (!pts || pts.length !== 2 || !msg.pts.every(v => Number.isFinite(v)))) return null
    if (msg.action === 'begin' && (typeof msg.id !== 'string' || !msg.id || msg.id.length > 40 ||
        !Number.isInteger(msg.color) || msg.color < 0 || msg.color >= LIMITS.colors)) return null
    if (msg.action === 'points' && (!pts || pts.length > LIMITS.message || pts.length % 2 ||
        !msg.pts.every(v => Number.isFinite(v)))) return null
    if (msg.action === 'end' && typeof msg.id !== 'string') return null
    return { ...msg, from, ...(pts && (msg.action === 'laser' || msg.action === 'points') ? { pts } : {}) }
  }
  return {
    // Só o estado do toggle viaja no sync — traços não são replayados.
    sync () { return { type: 'draw', action: 'sync', targets: [...targets.keys()].map(snapshot) } },
    resync (target) {
      if (typeof target !== 'string' || !/^\d{5,25}$/.test(target)) return null
      return { type: 'draw', action: 'sync', targets: [snapshot(target)] }
    },
    // Valida e devolve a mensagem pra retransmitir (ou null se inválida).
    apply (msg, from) {
      if (msg?.action === 'allow') {
        if (typeof msg.target !== 'string' || !/^\d{5,25}$/.test(msg.target) ||
            msg.target !== from || typeof msg.on !== 'boolean') return null
        state(msg.target).allowed = msg.on
        return { ...msg, from }
      }
      return relay(msg, from)
    }
  }
}
