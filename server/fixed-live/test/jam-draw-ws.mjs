// Teste de integração das anotações da live no WebSocket do jam: sobe o index.js
// numa porta efêmera (mesmo esqueleto do chat.mjs, com o /api/status falso) e liga
// dois clientes numa sala watch.
//
//   node test/jam-draw-ws.mjs
//
// - traço da caneta (begin/points/end) chega aos outros com o remetente, sem eco
// - quem entra depois recebe o sync com os traços já guardados
// - allow é privilégio do dono da live (target === nick); espectador é ignorado
// - resync devolve um alvo específico com o estado corrente
// - clear do dono apaga tudo; sala sem watch=1 ignora draw
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { createServer as createHttp } from 'node:http'
import { WebSocket } from 'ws'

const freePort = () => new Promise((res, rej) => {
  const srv = createServer()
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => res(port)) })
  srv.on('error', rej)
})

const bb = createHttp((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify([]))
})
await new Promise(res => bb.listen(0, '127.0.0.1', res))
const BB_PORT = bb.address().port

const dataDir = mkdtempSync(join(tmpdir(), 'fockytv-draw-test-'))
const PORT = await freePort()
const child = spawn('node', ['index.js'], {
  cwd: new URL('..', import.meta.url).pathname,
  env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, BB_URL: `http://127.0.0.1:${BB_PORT}` },
  stdio: ['ignore', 'pipe', 'pipe'],
})
const bootLog = []
child.stdout.on('data', d => bootLog.push(d))
child.stderr.on('data', d => bootLog.push(d))
const diedEarly = once(child, 'exit')
diedEarly.catch(() => {})

const killChild = () => { try { child.kill('SIGKILL') } catch {} }
process.on('exit', () => { killChild(); rmSync(dataDir, { recursive: true, force: true }) })
process.on('SIGINT', () => { killChild(); process.exit(130) })
process.on('SIGTERM', () => { killChild(); process.exit(143) })

await new Promise((res, rej) => {
  const check = () => {
    if (bootLog.join('').includes(`fixed-live na porta ${PORT}`)) return res()
    if (child.exitCode !== null || child.signalCode) return rej(new Error(bootLog.join('')))
    setTimeout(check, 100)
  }
  check()
})

// sala watch: o dono da live é o 999999; ana e bruno assistem com o plugin
const ROOM = 'watch:123456'
const connect = async nick => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/fixed/ws/jam?room=${ROOM}&nick=${nick}&watch=1`)
  const buf = []
  const waiters = []
  ws.on('message', d => {
    let m
    try { m = JSON.parse(d) } catch { return }
    const i = waiters.findIndex(w => Object.entries(w.match).every(([k, v]) => m[k] === v))
    if (i >= 0) waiters.splice(i, 1)[0].res(m)
    else buf.push(m)
  })
  await once(ws, 'open')
  const recv = (match, timeoutMs = 6000) => new Promise((res, rej) => {
    const i = buf.findIndex(m => Object.entries(match).every(([k, v]) => m[k] === v))
    if (i >= 0) return res(buf.splice(i, 1)[0])
    const w = { match, res }
    waiters.push(w)
    setTimeout(() => {
      const j = waiters.indexOf(w)
      if (j >= 0) waiters.splice(j, 1)
      rej(new Error('timeout esperando ' + JSON.stringify(match)))
    }, timeoutMs)
  })
  return { ws, recv }
}
const noMsg = (c, match) => c.recv(match, 700).then(
  () => { throw new Error('recebeu ' + JSON.stringify(match)) },
  () => {})
const send = (ws, obj) => ws.send(JSON.stringify(obj))

let failed = 0
const ok = (cond, what) => { console.log(cond ? `  ✓ ${what}` : `  ✗ ${what}`); if (!cond) failed++ }

try {
  const OWNER = '999999'
  const ana = await connect('111111')
  const bruno = await connect('222222')
  const owner = await connect(OWNER) // o dono da live também está na call
  await ana.recv({ type: 'draw', action: 'sync' }) // join já devolve o estado (vazio)
  await bruno.recv({ type: 'draw', action: 'sync' }) // drena o sync de boas-vindas dele também

  // traço completo: chega ao outro com o remetente, sem eco pro autor
  send(ana.ws, { type: 'draw', target: OWNER, action: 'begin', id: 's1', color: 0 })
  send(ana.ws, { type: 'draw', target: OWNER, action: 'points', id: 's1', pts: [0.1, 0.2, 0.3, 0.4] })
  send(ana.ws, { type: 'draw', target: OWNER, action: 'end', id: 's1' })
  const begin = await bruno.recv({ type: 'draw', action: 'begin', from: '111111', id: 's1' })
  ok(begin.target === OWNER && begin.color === 0, 'begin espelhado com o remetente e o alvo')
  await bruno.recv({ type: 'draw', action: 'points', from: '111111', id: 's1' })
  await bruno.recv({ type: 'draw', action: 'end', from: '111111', id: 's1' })
  ok(true, 'pontos e fim do traço chegam na ordem')
  await noMsg(ana, { type: 'draw', action: 'end', id: 's1' })
  ok(true, 'remetente não recebe o próprio traço de volta')

  // quem entra depois recebe o traço guardado
  const bruna = await connect('333333')
  const sync = await bruna.recv({ type: 'draw', action: 'sync' })
  const entry = sync.targets.find(t => t.target === OWNER)
  ok(entry && entry.strokes.length === 1 && entry.strokes[0].pts.length === 4 && entry.allowed === true,
     'sync de boas-vindas traz o traço e o toggle ligado')

  // allow: espectador é ignorado; dono desliga e o estado propaga
  send(bruna.ws, { type: 'draw', target: OWNER, action: 'allow', on: false })
  await noMsg(bruno, { type: 'draw', action: 'allow', from: '333333' })
  ok(true, 'allow de espectador não espelha')
  send(owner.ws, { type: 'draw', target: OWNER, action: 'allow', on: false })
  await bruno.recv({ type: 'draw', action: 'allow', from: OWNER, on: false })
  ok(true, 'allow do dono espelha')
  send(bruna.ws, { type: 'draw', action: 'resync', target: OWNER })
  ok((await bruna.recv({ type: 'draw', action: 'sync' })).targets[0].allowed === false,
     'resync devolve o alvo com o toggle desligado')

  // clear do dono apaga tudo
  send(owner.ws, { type: 'draw', target: OWNER, action: 'clear' })
  await bruno.recv({ type: 'draw', action: 'clear', from: OWNER })
  send(bruno.ws, { type: 'draw', action: 'resync', target: OWNER })
  const cleared = await bruno.recv({ type: 'draw', action: 'sync' })
  ok(cleared.targets[0].strokes.length === 0, 'clear do dono esvazia o quadro')
  bruna.ws.close()
  bruno.ws.close()
  ana.ws.close()
  owner.ws.close()

  // sala comum (sem watch=1) ignora draw
  const plain = async nick => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/fixed/ws/jam?room=call:555&nick=${nick}`)
    await once(ws, 'open')
    const buf = []
    ws.on('message', d => buf.push(String(d)))
    return { ws, buf }
  }
  const p1 = await plain('111111')
  const p2 = await plain('222222')
  send(p1.ws, { type: 'draw', target: OWNER, action: 'begin', id: 'x', color: 0 })
  await new Promise(res => setTimeout(res, 400))
  ok(p2.buf.every(text => !text.includes('"draw"')), 'sala sem watch não espelha draw')
  p1.ws.close()
  p2.ws.close()
} catch (error) {
  failed++
  console.log('  ✗', error.message)
}

console.log(failed ? 'jam-draw-ws: falhou' : 'jam-draw-ws: tudo verde')
process.exit(failed ? 1 : 0)
