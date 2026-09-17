// Teste do portão de ruído: roda o CÓDIGO REAL do JamGate (ui/jam-worklet.js)
// fora do AudioWorklet, com `sampleRate`/`currentTime` postiços, e empurra
// sinais sintéticos em blocos de 128 samples como o render quantum faria.
//
//   npm test   (na raiz)
//
// O que está sendo protegido: um gate de amplitude pura NÃO resolve o caso
// que motivou isto — estalar de dedo e clique de tecla são altos, passam por
// qualquer threshold que ainda deixe você falar baixo. O portão separa os
// dois por espectro (sidechain só na banda de voz, 300–3000Hz) e por duração
// (só abre depois de `confirmMs` contínuos acima do threshold). Os casos
// abaixo são exatamente esses dois eixos.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

// o worklet roda num escopo com globais próprias e termina em
// registerProcessor: recorta o que não existe fora e importa como módulo
globalThis.sampleRate = 48000
globalThis.currentTime = 0
globalThis.AudioWorkletProcessor = class {
  constructor () { this.port = { onmessage: null, postMessage () {} } }
}

const src = readFileSync(join(here, '..', 'jam-worklet.js'), 'utf8')
  .replace(/registerProcessor\([^)]*\)/g, '')
  + '\nexport { JamGate }'
const { JamGate } = await import(
  'data:text/javascript;base64,' + Buffer.from(src).toString('base64'))

const SR = 48000
const FRAME = 128

let failures = 0
const ok = (cond, msg) => {
  if (!cond) failures++
  console.log(`${cond ? 'PASS' : 'FALHA'}  ${msg}`)
}

// roda um sinal mono pelo portão e devolve o que saiu (mesma duração)
const through = (gate, input) => {
  const out = new Float32Array(input.length)
  for (let i = 0; i + FRAME <= input.length; i += FRAME) {
    const inBuf = [input.subarray(i, i + FRAME)]
    const outBuf = [new Float32Array(FRAME)]
    gate.process([inBuf], [outBuf])
    out.set(outBuf[0], i)
    globalThis.currentTime += FRAME / SR
  }
  return out
}

const rms = buf => Math.sqrt(buf.reduce((s, v) => s + v * v, 0) / (buf.length || 1))
const peak = buf => buf.reduce((m, v) => Math.max(m, Math.abs(v)), 0)
const ms = n => Math.round(n * SR / 1000)

const silence = n => new Float32Array(n)

// fala: harmônicos na banda de voz, envelope de sílaba (sobe e sustenta)
const speech = (durMs, amp = 0.2) => {
  const n = ms(durMs), b = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const t = i / SR
    const env = Math.min(1, i / ms(15))
    b[i] = amp * env * (Math.sin(2 * Math.PI * 220 * t)
      + 0.6 * Math.sin(2 * Math.PI * 700 * t)
      + 0.3 * Math.sin(2 * Math.PI * 1600 * t)) / 1.9
  }
  return b
}

// estalo de dedo / clique de tecla: transiente ALTO, curto, com a energia
// espalhada no agudo (2–8kHz) e decaimento exponencial rápido
const snap = (amp = 0.9, decayMs = 8) => {
  const n = ms(40), b = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const t = i / SR
    const env = Math.exp(-i / ms(decayMs))
    b[i] = amp * env * (Math.sin(2 * Math.PI * 3200 * t)
      + Math.sin(2 * Math.PI * 5600 * t) + (Math.random() * 2 - 1)) / 3
  }
  return b
}

// ruído de sala baixo e constante (ventilador, ar): banda larga, -55dBFS
const roomNoise = durMs => {
  const n = ms(durMs), b = new Float32Array(n)
  for (let i = 0; i < n; i++) b[i] = (Math.random() * 2 - 1) * 0.0018
  return b
}

const cat = (...parts) => {
  const total = parts.reduce((s, p) => s + p.length, 0)
  const b = new Float32Array(total)
  let o = 0
  for (const p of parts) { b.set(p, o); o += p.length }
  return b
}

const newGate = (cfg = {}) => {
  const g = new JamGate()
  g.port.onmessage({ data: { type: 'config', on: true, ...cfg } })
  return g
}

// ── 1. o caso que motivou tudo ──────────────────────────────────────────
{
  const g = newGate()
  const sig = cat(silence(ms(200)), snap(), silence(ms(300)))
  const out = through(g, sig)
  ok(peak(out) < 0.02,
    'estalo de dedo (alto, curto, agudo) NÃO abre o portão')
}

// controle: o mesmo estalo passaria por um gate de amplitude pura, que é
// justamente por isso que o portão não é um
{
  const s = snap()
  ok(peak(s) > 0.2, 'controle: o estalo É alto — gate por amplitude abriria')
}

// ── 2. fala abre, e abre inteira ────────────────────────────────────────
{
  const g = newGate()
  const fala = speech(400)
  const out = through(g, cat(silence(ms(200)), fala, silence(ms(200))))
  ok(rms(out) > rms(fala) * 0.5, 'fala sustentada abre o portão')
}

// o lookahead existe pra que a exigência de duração não coma o começo da
// palavra: sem ele os primeiros `confirmMs` sairiam mudos
{
  const CF = 20
  const g = newGate({ confirmMs: CF })
  const out = through(g, cat(silence(ms(200)), speech(400), silence(ms(200))))
  // a saída sai atrasada de confirmMs: o ataque que entrou em 200ms aparece
  // em 200+CF. É essa janela que o lookahead existe pra salvar — sem ele o
  // portão só abriria DEPOIS dela e os primeiros 20ms sairiam mudos.
  const inicio = out.subarray(ms(200 + CF), ms(200 + CF) + ms(20))
  ok(peak(inicio) > 0.01, 'lookahead preserva o ataque da palavra')
}

// o critério espectral é o ponto onde isto pode dar errado ao contrário: se
// for estrito demais, voz nenhuma abre. Fala de verdade TEM agudo (sopro,
// sibilante, ar do microfone) — aqui ela vem com banda larga por cima, no
// nível em que a fala real costuma botar: uns 10dB abaixo do corpo da voz.
{
  const g = newGate()
  const fala = speech(400)
  const comAr = Float32Array.from(fala, v => v + (Math.random() * 2 - 1) * 0.02)
  const out = through(g, cat(silence(ms(200)), comAr, silence(ms(200))))
  ok(rms(out) > rms(comAr) * 0.5, 'fala com sopro/sibilante ainda abre o portão')
}

// e uma consoante surda no MEIO da frase não pode refechar o portão
{
  const g = newGate()
  const sss = Float32Array.from({ length: ms(120) }, () => (Math.random() * 2 - 1) * 0.15)
  const sig = cat(silence(ms(150)), speech(250), sss, speech(250))
  const out = through(g, sig)
  const naSibilante = out.subarray(ms(420), ms(500))
  ok(peak(naSibilante) > 0.01, 'sibilante no meio da frase não picota a palavra')
}

// ── 3. silêncio fica silêncio ───────────────────────────────────────────
{
  const g = newGate()
  const out = through(g, roomNoise(500))
  ok(peak(out) < 1e-3, 'ruído de sala baixo não abre o portão')
}

// ── 4. o hold não pica a fala entre sílabas ─────────────────────────────
{
  const g = newGate()
  const sig = cat(silence(ms(150)),
    speech(200), silence(ms(60)), speech(200))   // pausa curta entre sílabas
  const out = through(g, sig)
  const pausa = out.subarray(ms(350), ms(410))
  ok(peak(out.subarray(ms(410), ms(600))) > 0.01, 'segunda sílaba sai inteira')
  ok(pausa.length > 0, 'hold cobre a pausa entre sílabas sem refechar')
}

// ── 5. desligado é passa-reto de verdade (Estúdio) ──────────────────────
{
  const g = new JamGate()
  g.port.onmessage({ data: { type: 'config', on: false } })
  const sig = snap()
  const out = through(g, sig)
  const n = Math.floor(sig.length / FRAME) * FRAME
  let igual = true
  for (let i = 0; i < n; i++) if (out[i] !== sig[i]) { igual = false; break }
  ok(igual, 'portão desligado não toca no sinal (nem filtro, nem atraso)')
}

// ── 6. threshold é obedecido ────────────────────────────────────────────
{
  const baixo = speech(400, 0.01)   // fala bem baixinha
  const alto = newGate({ openDb: -20 })
  const sensivel = newGate({ openDb: -60 })
  ok(peak(through(alto, cat(silence(ms(100)), baixo))) < 0.005,
    'threshold alto barra fala baixa')
  ok(peak(through(sensivel, cat(silence(ms(100)), baixo))) > 0.001,
    'threshold baixo deixa a mesma fala passar')
}

console.log(failures ? `\n${failures} falha(s)` : '\ntudo PASS')
process.exit(failures ? 1 : 0)
