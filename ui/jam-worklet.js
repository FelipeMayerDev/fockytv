// AudioWorklets da sala de músicos. Dois processadores:
//
//  jam-tap: na captura — puxa o áudio do microfone fora da pipeline de voz do
//  Chromium e entrega blocos interleaved de 480 frames (10ms @48k) pro main
//  thread, que alimenta o AudioEncoder (WebCodecs).
//
//  jam-mix: na saída — um ring buffer por músico remoto, consumido no ritmo do
//  relógio de som da máquina. É o jitter buffer da sala: alvo configurável,
//  underrun vira silêncio (e é contado), excesso é podado de volta ao alvo
//  (que é onde o drift de relógio entre peers é absorvido).

const FRAME = 128   // quantum do render (samples por canal)

// ── captura ─────────────────────────────────────────────────────────────
class JamTap extends AudioWorkletProcessor {
  constructor () {
    super()
    this.acc = null   // Float32Array interleaved acumulando 480 frames
    this.pos = 0
  }

  process (inputs) {
    const chs = inputs[0]
    if (!chs || !chs.length) return true
    const n = chs[0].length
    const nch = Math.min(chs.length, 2)
    if (!this.acc || this.acc.length / 2 !== 480 * 2) this.acc = new Float32Array(480 * 2)
    let peak = 0
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < 2; c++) {
        const v = nch === 2 ? chs[Math.min(c, nch - 1)][i] : chs[0][i]
        this.acc[this.pos++] = v
        const a = v < 0 ? -v : v
        if (a > peak) peak = a
      }
      if (this.pos === this.acc.length) {
        const out = new Float32Array(this.acc)   // cópia: acc volta a encher
        this.pos = 0
        this.port.postMessage(out, [out.buffer])
      }
    }
    // nível local ~5x/s: pro detector de voz da UI (pílula acesa = falando)
    this.blockPeak = Math.max(this.blockPeak ?? 0, peak)
    if (currentTime - (this.levelAt ?? 0) > 0.2) {
      this.levelAt = currentTime
      this.port.postMessage({ type: 'level', v: this.blockPeak })
      this.blockPeak = 0
    }
    return true
  }
}

// ── mixagem de recepção ─────────────────────────────────────────────────
class JamMix extends AudioWorkletProcessor {
  constructor () {
    super()
    this.peers = new Map()   // id -> {ring: Float32Array[], r: read, w: write, cap, gain, underruns, peak}
    this.target = 1440       // 30ms @48k
    this.meterAt = 0
    this.port.onmessage = e => {
      const m = e.data
      if (m.type === 'add') {
        const cap = 16384 // ~340ms por canal: teto de folga, poda traz de volta
        this.peers.set(m.id, {
          ring: [new Float32Array(cap), new Float32Array(cap)],
          r: 0, w: 0, cap, gain: 1, underruns: 0, peak: 0,
          // carência na entrada: underrun antes do primeiro pacote chegar é
          // o buffer enchendo, não falha de rede — não conta
          graceUntil: currentTime + 0.6,
        })
      } else if (m.type === 'remove') this.peers.delete(m.id)
      else if (m.type === 'gain') { const p = this.peers.get(m.id); if (p) p.gain = m.v }
      else if (m.type === 'target') this.target = Math.max(FRAME, m.ms * 48 | 0)
      else if (m.type === 'audio') {
        const p = this.peers.get(m.id)
        if (p) this.write(p, m.data)
      }
    }
  }

  write (p, data) {
    const frames = data.length / 2
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < 2; c++) p.ring[c][p.w % p.cap] = data[i * 2 + c]
      p.w++
    }
    // poda: buffer acima do alvo+margem volta pro alvo (drift + bolso de rede)
    const held = p.w - p.r
    const excess = held - (this.target + 960)
    if (excess > 0) p.r += excess
  }

  process (_inputs, outputs) {
    const out = outputs[0]
    const n = out[0].length
    for (const p of this.peers.values()) {
      let peak = 0
      let starved = false
      for (let i = 0; i < n; i++) {
        if (p.w - p.r < 1) { starved = true; continue }
        for (let c = 0; c < 2; c++) {
          const s = p.ring[c][p.r % p.cap] * p.gain
          out[c][i] += s
          const a = s < 0 ? -s : s
          if (a > peak) peak = a
        }
        p.r++
      }
      if (starved && currentTime > p.graceUntil) p.underruns++
      p.peak = Math.max(p.peak * 0.85, peak)
    }
    // telemetria ~2x/s: buffer de cada peer, underruns e nível
    if (currentTime - this.meterAt > 0.125) {
      this.meterAt = currentTime
      const meters = {}
      for (const [id, p] of this.peers) meters[id] = {
        bufferMs: (p.w - p.r) / 48 | 0,
        underruns: p.underruns,
        level: p.peak,
      }
      this.port.postMessage({ type: 'meters', meters })
    }
    return true
  }
}

registerProcessor('jam-tap', JamTap)
registerProcessor('jam-mix', JamMix)
