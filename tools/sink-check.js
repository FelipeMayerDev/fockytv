// prova: app comum entra no monitor do sink FockyTV, "discord" não entra
const { spawn, execFileSync } = require('node:child_process')
const assert = require('node:assert')
const RATE = 48000
const tone = f => { const b = Buffer.alloc(RATE * 8 * 8); for (let i = 0; i < RATE * 8; i++) { const v = Math.sin(2*Math.PI*f*i/RATE)*0.3; b.writeFloatLE(v, i*8); b.writeFloatLE(v, i*8+4) } return b }
const play = name => { const p = spawn('pw-cat', ['--playback','--raw','--format','f32','--rate',String(RATE),'--channels','2','-P',`{ node.name=${name} application.process.binary=${name} }`,'-']); p.stdin.end(tone(440)); return p }

const good = play('faketone'), bad = play('discord')       // binary=discord: tem que ficar de fora
const sinkd = spawn('node', [require('node:path').join(__dirname, 'fockytv-sink.js')], { stdio: 'inherit' })
setTimeout(() => {
  const rec = spawn('pw-cat', ['--record','--raw','--format','f32','--rate',String(RATE),'--channels','2','--target','FockyTV.monitor','-'])
  let energy = 0
  rec.stdout.on('data', d => { for (let i = 0; i + 4 <= d.length; i += 4) energy += Math.abs(d.readFloatLE(i)) })
  setTimeout(() => {
    // quem está ligado no sink, pelos objetos Link do pw-dump
    const dump = JSON.parse(execFileSync('pw-dump', { encoding: 'utf8', maxBuffer: 1 << 24 }))
    const nodes = new Map(dump.filter(o => o.type.endsWith('Node')).map(o => [o.id, o.info?.props ?? {}]))
    const sinkId = [...nodes].find(([, p]) => p['node.name'] === 'FockyTV')?.[0]
    const into = dump.filter(o => o.type.endsWith('Link') && o.info?.['input-node-id'] === sinkId)
      .map(o => nodes.get(o.info['output-node-id'])?.['node.name'])
    console.log('energia no monitor:', Math.round(energy), '| ligados:', [...new Set(into)].join(', '))
    assert(nodes.size && [...nodes.values()].some(p => p['node.name'] === 'discord'), 'o "discord" de teste nem subiu')
    assert(energy > 1000, 'monitor do sink mudo — app não foi ligado')
    assert(into.includes('faketone'), 'app comum não entrou no sink')
    assert(!into.includes('discord'), 'discord foi ligado no sink!')
    console.log('ok — app entra, discord fica de fora')
    for (const p of [good, bad, rec]) p.kill()
    sinkd.kill('SIGINT'); setTimeout(() => process.exit(0), 500)
  }, 2500)
}, 2500)
