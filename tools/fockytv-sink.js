#!/usr/bin/env node
// Áudio da transmissão SEM o Discord, para quem transmite pelo NAVEGADOR
// (no app FockyTV isso já é automático — veja electron/main.js).
//
//   node tools/fockytv-sink.js     (deixa rodando enquanto transmite)
//
// Cria um sink virtual "FockyTV" e liga nele todo app que toca som, menos os
// da lista de exclusão. O sink não rouba o áudio de ninguém: o pw-link
// ADICIONA um caminho, então tudo continua saindo nos alto-falantes igual.
// No navegador, "Monitor of FockyTV" aparece como microfone — é isso que o
// diálogo de compartilhar oferece como fonte de som.
// Relink a cada 1s: app que abriu o som no meio da transmissão entra sozinho.
const { execFile, execFileSync, spawn } = require('node:child_process')

const SINK = 'FockyTV'
// mesma regra do app (electron/main.js): a conversa do Discord é privada, e o
// som do próprio FockyTV voltaria pra stream em eco
const NEVER = /^(discord|fockytv)/i

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' }).trim()

let moduleId = null
const sinkExists = () => sh('pactl', ['list', 'short', 'sinks']).split('\n').some(l => l.split('\t')[1] === SINK)
if (sinkExists()) console.log(`sink "${SINK}" já existe, reaproveitando`)
else {
  moduleId = sh('pactl', ['load-module', 'module-null-sink', `sink_name=${SINK}`,
    `sink_properties=device.description="FockyTV (sem Discord)"`])
  console.log(`sink "${SINK}" criado (módulo ${moduleId})`)
}
console.log('no navegador, escolha "Monitor of FockyTV" como som da transmissão. Ctrl+C para desfazer.')

const linked = new Set()   // object.serial (nunca reusado)
const tick = () => execFile('pw-dump', { maxBuffer: 16 << 20 }, (err, out) => {
  if (err) return
  let nodes
  try { nodes = JSON.parse(out).filter(o => o.type === 'PipeWire:Interface:Node') } catch { return }
  const sink = nodes.find(n => n.info?.props?.['node.name'] === SINK)
  if (!sink) return
  for (const n of nodes) {
    const p = n.info?.props ?? {}
    if (p['media.class'] !== 'Stream/Output/Audio') continue
    if (NEVER.test(p['application.process.binary'] ?? '')) continue
    const serial = +(p['object.serial'] ?? 0)
    if (!serial || linked.has(serial)) continue
    linked.add(serial)
    const who = p['application.process.binary'] ?? p['node.name'] ?? '?'
    execFile('pw-link', [String(n.id), String(sink.id)], e =>
      console.log(e ? `  ${who}: link falhou (${e.message.trim().split('\n').pop()})` : `  + ${who}`))
  }
})
tick()
const timer = setInterval(tick, 1000)

const bye = () => {
  clearInterval(timer)
  if (moduleId) { try { sh('pactl', ['unload-module', moduleId]); console.log('\nsink removido') } catch {} }
  process.exit(0)
}
process.on('SIGINT', bye)
process.on('SIGTERM', bye)
