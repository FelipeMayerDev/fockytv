// Player de música das calls (radio.js) com download falso: fila, avanço
// automático, pausa/retomada, permissão de remover e o áudio só da atual/próxima.
//
//   npm test
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { WebSocket } from 'ws'
import { createRadio } from '../radio.js'

const downloads = []
const radio = createRadio({
  emptyMs: 50,
  download: id => { downloads.push(id); return id === 'falhaaaaaaa' ? Promise.reject(new Error('x')) : Promise.resolve(Buffer.from(id)) },
})
const server = createServer().listen(0, '127.0.0.1')
server.on('upgrade', radio.upgrade)
await once(server, 'listening')
const base = `ws://127.0.0.1:${server.address().port}/api/fixed/ws/radio?room=111111&`

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function connect (user, name) {
  const ws = new WebSocket(`${base}user=${user}&name=${name}`)
  const inbox = []
  ws.on('message', data => inbox.push(JSON.parse(data)))
  await once(ws, 'open')
  return {
    ws,
    send: obj => ws.send(JSON.stringify(obj)),
    // próxima mensagem que satisfaz o teste (as anteriores são descartadas)
    async until (test, ms = 2000) {
      const end = Date.now() + ms
      while (Date.now() < end) {
        const i = inbox.findIndex(test)
        if (i >= 0) return inbox.splice(0, i + 1).pop()
        await sleep(5)
      }
      throw new Error(`timeout; última: ${JSON.stringify(inbox.at(-1))}`)
    },
  }
}
const track = (id, duration = 60) => ({ type: 'add', track: { id, title: `t-${id}`, duration } })

try {
  const ana = await connect('22222222', 'Ana')
  const bia = await connect('33333333', 'Bia')
  await ana.until(m => m.type === 'state' && m.queue.length === 0)

  ana.send({ type: 'listen', on: true })
  await bia.until(m => m.type === 'state' && m.listeners.join() === 'Ana')

  ana.send(track('aaaaaaaaaaa'))
  let s = await bia.until(m => m.type === 'state' && m.ready)
  assert.equal(s.queue[0].byName, 'Ana')
  assert.equal(s.index, 0)
  assert.ok(s.playing)

  ana.send(track('bbbbbbbbbbb'))
  ana.send(track('ccccccccccc'))
  s = await bia.until(m => m.type === 'state' && m.queue.length === 3)
  assert.deepEqual(downloads, ['aaaaaaaaaaa', 'bbbbbbbbbbb'], 'só a atual e a próxima baixam')
  assert.equal(await radio.audio('111111', s.queue[2].uid), null, 'terceira faixa ainda sem áudio')
  assert.equal(String(await radio.audio('111111', s.queue[0].uid)), 'aaaaaaaaaaa')

  // só quem adicionou remove
  bia.send({ type: 'remove', uid: s.queue[1].uid })
  assert.match((await bia.until(m => m.type === 'error')).message, /adicionou/)
  ana.send({ type: 'remove', uid: s.queue[1].uid })
  s = await bia.until(m => m.type === 'state' && m.queue.length === 2)
  assert.equal(s.queue[1].id, 'ccccccccccc')

  // pausa congela a posição; retomar continua dela
  await sleep(200)
  bia.send({ type: 'pause' })
  s = await ana.until(m => m.type === 'state' && !m.playing)
  const frozen = s.position
  assert.ok(frozen >= 0.15 && frozen < 1, `posição ${frozen}`)
  await sleep(150)
  bia.send({ type: 'resume' })
  s = await ana.until(m => m.type === 'state' && m.playing)
  assert.ok(Math.abs(s.position - frozen) < 0.05, 'retoma de onde parou')

  // qualquer um pula; o fim da faixa avança sozinho e a fila para no fim
  bia.send({ type: 'next' })
  s = await ana.until(m => m.type === 'state' && m.index === 1 && m.ready)
  bia.send(track('ddddddddddd', 0.2))
  ana.send({ type: 'play', uid: (await ana.until(m => m.type === 'state' && m.queue.length === 3)).queue[2].uid })
  s = await ana.until(m => m.type === 'state' && m.index === 3, 3000)
  assert.equal(s.queue.length, 3, 'fim da fila: nada tocando')

  // faixa que falha no download é pulada com aviso
  bia.send(track('falhaaaaaaa'))
  assert.match((await ana.until(m => m.type === 'error')).message, /t-falhaaaaaaa/)

  // sala vazia some depois do tempo de graça
  ana.ws.close(); bia.ws.close()
  await sleep(150)
  const carla = await connect('44444444', 'Carla')
  s = await carla.until(m => m.type === 'state')
  assert.equal(s.queue.length, 0, 'sala nova depois de vazia')
  carla.ws.close()
  console.log('radio: ok')
} finally {
  server.close()
  setTimeout(() => process.exit(process.exitCode ?? 0), 100).unref()
}
