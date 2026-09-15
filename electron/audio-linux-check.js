// Smoke test do áudio por aplicativo no Linux (precisa de PipeWire rodando):
//   node electron/audio-linux-check.js
// Sobe o mesmo nó de captura do main.js, liga um "app" (seno) nele com
// pw-link e cobra PCM com energia na saída. Falha = o caminho do filtro
// (exclusão do Discord) está mudo.
const { spawn, execFile } = require('node:child_process')
const assert = require('node:assert')

const RATE = 48000, secs = 6
const tone = Buffer.alloc(RATE * secs * 2 * 4)
for (let i = 0; i < RATE * secs; i++) {
  const v = Math.sin(2 * Math.PI * 440 * i / RATE) * 0.3
  tone.writeFloatLE(v, i * 8); tone.writeFloatLE(v, i * 8 + 4)
}
const pwcat = (...args) => spawn('pw-cat', ['--raw', '--format', 'f32', '--rate', String(RATE), '--channels', '2', ...args])

const tag = 'check-' + process.pid
const app = pwcat('--playback', '-P', `{ node.name=faketone-${tag} }`, '-')
app.stdin.end(tone)
const cap = pwcat('--record', '-P', `{ node.autoconnect=false node.name=fockytv-capture-${tag} }`, '-')

let bytes = 0, energy = 0
cap.stdout.on('data', d => {
  bytes += d.length
  for (let i = 0; i + 4 <= d.length; i += 4) energy += Math.abs(d.readFloatLE(i))
})

setTimeout(() => execFile('pw-dump', { maxBuffer: 1 << 24 }, (_e, out) => {
  const nodes = JSON.parse(out).filter(o => o.type === 'PipeWire:Interface:Node')
  // por nome único: o pw-cat não publica o próprio PID nas props, e órfão de
  // execução anterior tem o mesmo nome genérico
  const byName = n => nodes.find(x => x.info?.props?.['node.name'] === n)?.id
  execFile('pw-link', [String(byName(`faketone-${tag}`)), String(byName(`fockytv-capture-${tag}`))], err => {
    assert(!err, 'pw-link falhou: ' + err?.message)
    const before = energy
    setTimeout(() => {
      assert(bytes > RATE * 8 * 0.5, 'saiu pouco PCM: ' + bytes + ' bytes')
      assert(energy - before > 1000, 'nó ligado mas mudo (energia ' + Math.round(energy - before) + ')')
      console.log('ok — pcm', bytes, 'bytes, energia', Math.round(energy - before))
      app.kill(); cap.kill(); process.exit(0)
    }, 1500)
  })
}), 1200)
