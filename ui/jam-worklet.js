// AudioWorklets da sala de músicos. Dois processadores:
//
//  jam-tap: na captura — puxa o áudio do microfone fora da pipeline de voz do
//  Chromium e entrega blocos interleaved de 240 frames (5ms @48k) pro main
//  thread, que alimenta o AudioEncoder (WebCodecs).
//
//  jam-mix: na saída — um ring buffer por músico remoto, consumido no ritmo do
//  relógio de som da máquina. É o jitter buffer da sala: alvo configurável,
//  underrun vira silêncio (e é contado), excesso é podado de volta ao alvo
//  (que é onde o drift de relógio entre peers é absorvido).

const FRAME = 128   // quantum do render (samples por canal)

// ── biquad RBJ (forma direta II transposta) ──────────────────────────────
// Usado no corte de graves/agudos do sinal e no sidechain do portão. Estado
// por canal: o mesmo objeto filtra os dois sem vazar um no outro.
class Biquad {
  constructor () {
    this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0
    this.z1 = [0, 0]; this.z2 = [0, 0]
  }
  set (kind, f, q = 0.7071) {
    const w = 2 * Math.PI * Math.min(f, sampleRate * 0.45) / sampleRate
    const cw = Math.cos(w), alpha = Math.sin(w) / (2 * q)
    const a0 = 1 + alpha
    if (kind === 'hp') {
      this.b0 = (1 + cw) / 2 / a0; this.b1 = -(1 + cw) / a0; this.b2 = this.b0
    } else {
      this.b0 = (1 - cw) / 2 / a0; this.b1 = (1 - cw) / a0; this.b2 = this.b0
    }
    this.a1 = -2 * cw / a0; this.a2 = (1 - alpha) / a0
    return this
  }
  run (x, c) {
    const y = this.b0 * x + this.z1[c]
    this.z1[c] = this.b1 * x - this.a1 * y + this.z2[c]
    this.z2[c] = this.b2 * x - this.a2 * y
    return y
  }
}

// ── portão de ruído ─────────────────────────────────────────────────────
// Por que não um gate de amplitude simples: estalar de dedos, clique de mouse
// e tecla são ALTOS — passam por qualquer threshold que ainda deixe você
// falar baixo. O que os separa da fala são duas coisas, e o portão usa as
// duas:
//
//  1. Espectro. O estalo mora em 2–8kHz; a fala tem o corpo em 300–3000Hz.
//     O portão mede as DUAS bandas e exige que a de voz esteja por cima
//     (`tiltDb`). Medir só a banda de voz não bastava: o estalo é tão alto
//     que o pouco que vaza pra lá já cruzava qualquer threshold utilizável
//     (é o caso 1 de ui/test/noise-gate.mjs, que falhava exatamente assim).
//     A comparação entre bandas é imune ao volume — é a forma do espectro
//     que decide, não o tamanho.
//  2. Duração. Estalo/clique é transiente de 5–20ms; sílaba se sustenta por
//     50ms ou mais. O portão só abre depois de `confirmMs` CONTÍNUOS com as
//     duas condições satisfeitas.
//
// Sibilante ("sss") é aguda e sozinha não abre o portão — mas o hold de
// 180ms cobre as que vêm no meio da frase. Só uma palavra COMEÇADA em "s"
// depois de silêncio perde o ataque.
//
// O preço da exigência de duração seria comer o começo da palavra. Por isso
// o sinal sai atrasado de exatamente `confirmMs` (lookahead): quando a
// decisão de abrir sai, o áudio que a causou ainda está na linha de atraso.
// Latência é igual ao confirm (12ms no padrão) e só existe com o portão
// ligado — o modo Estúdio passa reto.
const DELAY_CAP = 2400   // 50ms @48k: teto do lookahead
const dB = v => 20 * Math.log10(v + 1e-9)

class JamGate extends AudioWorkletProcessor {
  constructor () {
    super()
    this.on = false          // desligado = passa-reto (Estúdio)
    this.cut = true          // corte de graves/agudos no sinal
    this.openDb = -45        // abre acima disso (sidechain, não sinal)
    this.hystDb = 8          // fecha `hystDb` abaixo: evita tremular na borda
    this.tiltDb = 0          // banda de voz tem que estar `tiltDb` acima da aguda
    this.confirmMs = 12      // duração mínima com as condições satisfeitas
    this.holdMs = 180        // segura aberto depois que a voz cai
    this.attackMs = 5
    this.releaseMs = 120

    this.hp = new Biquad(); this.lp = new Biquad()         // sinal
    this.scHp = new Biquad(); this.scLp = new Biquad()     // sidechain: voz
    this.scHi = new Biquad(); this.scHi2 = new Biquad()    // sidechain: agudo
    this.setCut(90, 8000)
    this.scHp.set('hp', 300); this.scLp.set('lp', 3000)
    // 4ª ordem no agudo: com 2ª ordem a saia deixava graves demais vazarem
    // pra banda "aguda" e a comparação entre as duas perdia contraste
    this.scHi.set('hp', 3500); this.scHi2.set('hp', 3500)

    this.delay = [new Float32Array(DELAY_CAP), new Float32Array(DELAY_CAP)]
    this.w = 0
    this.env = 0
    this.hiEnv = 0
    this.gain = 0
    this.open = false
    this.confirm = 0     // samples contínuos acima do threshold
    this.hold = 0        // samples restantes de hold
    this.meterAt = 0
    this.peakDb = -120

    this.port.onmessage = e => {
      const m = e.data
      if (m.type !== 'config') return
      for (const k of ['on', 'cut', 'openDb', 'hystDb', 'tiltDb', 'confirmMs', 'holdMs', 'attackMs', 'releaseMs'])
        if (m[k] !== undefined) this[k] = m[k]
      if (m.hpHz !== undefined || m.lpHz !== undefined)
        this.setCut(m.hpHz ?? this.hpHz, m.lpHz ?? this.lpHz)
    }
  }

  setCut (hpHz, lpHz) {
    this.hpHz = hpHz; this.lpHz = lpHz
    this.hp.set('hp', hpHz); this.lp.set('lp', lpHz)
  }

  // constante de um polo: tempo pra percorrer ~63% da distância até o alvo
  coef (ms) { return Math.exp(-1 / (Math.max(ms, 0.1) * 0.001 * sampleRate)) }

  process (inputs, outputs) {
    const inp = inputs[0], out = outputs[0]
    if (!inp || !inp.length || !out || !out.length) return true
    const n = out[0].length
    const nch = out.length

    if (!this.on) {
      // passa-reto: nem filtro nem atraso. O nó fica no grafo de qualquer
      // jeito pra não ter cirurgia de conexão em cima de um mic vivo.
      for (let c = 0; c < nch; c++) out[c].set(inp[Math.min(c, inp.length - 1)].subarray(0, n))
      return true
    }

    const delaySamples = Math.min(this.confirmMs * sampleRate / 1000 | 0, DELAY_CAP - FRAME - 1)
    const confirmNeed = this.confirmMs * sampleRate / 1000 | 0
    const holdSamples = this.holdMs * sampleRate / 1000 | 0
    const envDecay = this.coef(30)
    const atk = this.coef(this.attackMs)
    const rel = this.coef(this.releaseMs)
    const closeDb = this.openDb - this.hystDb

    for (let i = 0; i < n; i++) {
      // 1. filtra o SINAL e guarda na linha de atraso
      let mono = 0
      for (let c = 0; c < nch; c++) {
        let x = inp[Math.min(c, inp.length - 1)][i]
        if (this.cut) x = this.lp.run(this.hp.run(x, c), c)
        this.delay[c][this.w] = x
        mono += x
      }
      mono /= nch

      // 2. sidechain: duas bandas, mesma constante de tempo — decaindo
      // juntas, a RAZÃO entre elas sobrevive ao decaimento do transiente
      const sc = this.scLp.run(this.scHp.run(mono, 0), 0)
      const hi = this.scHi2.run(this.scHi.run(mono, 1), 1)
      const a = sc < 0 ? -sc : sc
      const ah = hi < 0 ? -hi : hi
      this.env = a > this.env ? a : a + (this.env - a) * envDecay
      this.hiEnv = ah > this.hiEnv ? ah : ah + (this.hiEnv - ah) * envDecay
      const lvl = dB(this.env)
      if (lvl > this.peakDb) this.peakDb = lvl
      // forma do espectro: fala tem o corpo no meio, estalo/clique no agudo
      const voz = lvl - dB(this.hiEnv) > this.tiltDb

      // 3. máquina de estados: abrir exige nível + forma + duração;
      // fechar exige hold (a forma não é reexigida: uma vez dentro da frase,
      // sibilante e consoante surda não podem picotar a palavra)
      if (!this.open) {
        if (lvl > this.openDb && voz) {
          if (++this.confirm >= confirmNeed) { this.open = true; this.hold = holdSamples }
        } else this.confirm = 0
      } else {
        if (lvl > closeDb) this.hold = holdSamples
        else if (--this.hold <= 0) { this.open = false; this.confirm = 0 }
      }

      // 4. ganho suave até o alvo e saída atrasada do lookahead
      const target = this.open ? 1 : 0
      const k = target > this.gain ? atk : rel
      this.gain = target + (this.gain - target) * k
      const r = (this.w - delaySamples + DELAY_CAP) % DELAY_CAP
      for (let c = 0; c < nch; c++) out[c][i] = this.delay[c][r] * this.gain
      this.w = (this.w + 1) % DELAY_CAP
    }

    // telemetria ~8x/s: é dela que sai o medidor ao lado do threshold — sem
    // ver onde o ruído da sala bate, escolher o valor é chute.
    if (currentTime - this.meterAt > 0.125) {
      this.meterAt = currentTime
      this.port.postMessage({ type: 'gate', db: this.peakDb, open: this.open })
      this.peakDb = -120
    }
    return true
  }
}

// ── captura ─────────────────────────────────────────────────────────────
class JamTap extends AudioWorkletProcessor {
  constructor () {
    super()
    this.acc = null   // Float32Array interleaved acumulando 240 frames
    this.pos = 0
    this.gain = 1     // ganho do músico: sem AGC do navegador, entrada de
                      // instrumento (DI, interface) precisa de boost manual
    this.port.onmessage = e => { if (e.data.type === 'gain') this.gain = e.data.v }
  }

  process (inputs) {
    const chs = inputs[0]
    if (!chs || !chs.length) return true
    const n = chs[0].length
    const nch = Math.min(chs.length, 2)
    if (!this.acc || this.acc.length !== 240 * 2) this.acc = new Float32Array(240 * 2)
    let peak = 0
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < 2; c++) {
        const v = (nch === 2 ? chs[Math.min(c, nch - 1)][i] : chs[0][i]) * this.gain
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
          // pré-buffer: só começa a consumir quando enche até o alvo
          started: false,
        })
      } else if (m.type === 'remove') this.peers.delete(m.id)
      else if (m.type === 'gain') { const p = this.peers.get(m.id); if (p) p.gain = m.v }
      else if (m.type === 'target') {
        this.target = Math.max(FRAME, m.ms * 48 | 0)
        // alvo mudou: todo mundo re-preenche (troca de modo de sala)
        for (const p of this.peers.values()) p.started = false
      }
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
      // pré-buffer: fica mudo até o ring encher até o alvo (80ms voz, 30ms
      // música). Perdeu pacote e secou: volta a encher antes de retomar.
      if (!p.started) {
        if (p.w - p.r < this.target) continue
        p.started = true
      }
      let peak = 0
      let starved = false
      for (let i = 0; i < n; i++) {
        if (p.w - p.r < 1) { starved = true; continue }
        for (let c = 0; c < 2; c++) {
          const s = p.ring[c][p.r % p.cap] * p.gain
          out[c][i] += s
          const av = s < 0 ? -s : s
          if (av > peak) peak = av
        }
        p.r++
      }
      if (starved && currentTime > p.graceUntil) {
        p.underruns++
        p.started = false   // secou de verdade: re-preenche antes de retomar
      }
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

registerProcessor('jam-gate', JamGate)
registerProcessor('jam-tap', JamTap)
registerProcessor('jam-mix', JamMix)
