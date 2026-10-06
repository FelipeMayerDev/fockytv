// Teste de integração do chat v2 (/api/fixed/ws/chat): protocolo estilo
// Fluxer/Discord sobre o mesmo relay com persistência de antes. Sobe o
// index.js numa porta efêmera — o BB_URL aponta pra um /api/status falso,
// que liga/desliga uma stream pra exercitar o evento de sistema ("subiu/
// saiu do ar") no chat da sala.
//
//   node test/chat.mjs
//
// - mensagem vai pro ar pelo eco do servidor (remetente incluído)
// - reply resolve o pai (nick + trecho) e não aninha (resposta de resposta
//   sobe pro root)
// - edit/apagar só o dono; apagado é soft (histórico mostra "apagada")
// - reação é toggle por nick, com conjunto fechado de emoji no servidor
// - "digitando" é relay puro, sem persistência
// - evento de sistema entra no histórico da sala
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

// falso mediamtx/live-api: /api/status devolve o conjunto corrente de streams
let bbLive = []
const bb = createHttp((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(bbLive))
})
await new Promise(res => bb.listen(0, '127.0.0.1', res))
const BB_PORT = bb.address().port

const dataDir = mkdtempSync(join(tmpdir(), 'fockytv-chat-test-'))
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
diedEarly.catch(() => {})   // exit no teardown não vira unhandled rejection

const killChild = () => { try { child.kill('SIGKILL') } catch {} }
process.on('exit', killChild)
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

// socket com buffer: o servidor fala logo no open (history, count) — nada
// pode se perder entre o open e o primeiro recv
const connect = async (nick, room) => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/fixed/ws/chat?nick=${nick}&room=${room}`)
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
// espera a AUSÊNCIA de uma mensagem (recusas do servidor não falam nada)
const noMsg = (c, match) => c.recv(match, 700).then(
  () => { throw new Error('recebeu ' + JSON.stringify(match)) },
  () => {})
const send = (ws, obj) => ws.send(JSON.stringify(obj))
const sleep = ms => new Promise(res => setTimeout(res, ms))

let failed = 0
const ok = (cond, what) => { console.log(cond ? `  ✓ ${what}` : `  ✗ ${what}`); if (!cond) failed++ }

try {
  const ana = await connect('ana', 't')
  const bruno = await connect('bruno', 't')

  // handshake: histórico vazio + contagem
  const hist = await ana.recv({ type: 'history' })
  ok(hist.msgs.length === 0, 'histórico inicial vazio')
  ok(await bruno.recv({ type: 'count', n: 2 }), 'contagem com 2 pessoas')

  // eco: o remetente também recebe a própria mensagem (fonte única de verdade)
  send(ana.ws, { type: 'chat', text: 'oi **galera** `código`' })
  const m1 = await bruno.recv({ type: 'chat', from: 'ana' })
  ok(m1.text === 'oi **galera** `código`' && typeof m1.id === 'number' && !m1.sys,
     'mensagem no ar pelo eco, com id')

  // reply: resolve pai; resposta de resposta sobe pro root (sem aninhar)
  send(bruno.ws, { type: 'chat', text: 'bem-vinda!', replyTo: m1.id })
  const m2 = await ana.recv({ type: 'chat', from: 'bruno' })
  ok(m2.replyTo === m1.id && m2.replyFrom === 'ana' && m2.replyText === 'oi **galera** `código`',
     'reply carrega nick e trecho do pai')
  await sleep(350)   // gate anti-spam de 300ms
  send(bruno.ws, { type: 'chat', text: 'de novo', replyTo: m2.id })
  const m3 = await ana.recv({ type: 'chat', from: 'bruno', text: 'de novo' })
  ok(m3.replyTo === m1.id, 'resposta de resposta cita o root')

  // edit: dono edita; outro não
  send(bruno.ws, { type: 'edit', id: m2.id, text: 'bem-vinda! **editada**' })
  const ed = await ana.recv({ type: 'edit', id: m2.id })
  ok(typeof ed.editedAt === 'number', 'edição broadcast com editedAt')
  try { await noMsg(ana, { type: 'edit', id: m2.id }); ok(true, 'edição por não-dono rejeitada') }
  catch (e) { ok(false, e.message) }

  // reação: toggle por nick — o broadcast inclui o remetente, então os dois
  // sockets consomem a cada rodada (o buffer não pode guardar eco velho)
  let r
  send(bruno.ws, { type: 'react', id: m1.id, emoji: '👍' })
  r = await ana.recv({ type: 'reactions', id: m1.id })
  await bruno.recv({ type: 'reactions', id: m1.id })
  ok(r.list.length === 1 && r.list[0].nicks.length === 1, 'reação registrada')
  send(ana.ws, { type: 'react', id: m1.id, emoji: '👍' })
  r = await ana.recv({ type: 'reactions', id: m1.id })
  await bruno.recv({ type: 'reactions', id: m1.id })
  ok(r.list[0].nicks.length === 2, 'segunda pessoa na mesma reação')
  await sleep(350)   // gate anti-spam do react (300ms) — rede local é rápida demais
  send(bruno.ws, { type: 'react', id: m1.id, emoji: '👍' })
  r = await ana.recv({ type: 'reactions', id: m1.id })
  await bruno.recv({ type: 'reactions', id: m1.id })
  ok(r.list[0].nicks.length === 1 && r.list[0].nicks[0] === 'ana', 'toggle remove o nick')
  try { await noMsg(bruno, { type: 'reactions', id: m1.id }); ok(true, 'emoji fora da lista recusado') }
  catch (e) { ok(false, e.message) }

  // digitando: relay sem estado
  send(ana.ws, { type: 'typing', on: true })
  ok(await bruno.recv({ type: 'typing', from: 'ana', on: true }), 'digitando relay')

  // apagar: soft — o histórico mantém a linha, a UI mostra "apagada"
  send(bruno.ws, { type: 'delete', id: m3.id })
  await ana.recv({ type: 'delete', id: m3.id })
  send(ana.ws, { type: 'chat', text: 'fim' })
  await bruno.recv({ type: 'chat', from: 'ana', text: 'fim' })

  // scrollback REST: mesmas formas do WS (página + reações + reply)
  const page = await (await fetch(`http://127.0.0.1:${PORT}/api/fixed/chat?room=t`)).json()
  const pageM1 = page.find(x => x.id === m1.id)
  const pageM3 = page.find(x => x.id === m3.id)
  ok(pageM1.reactions.length === 1 && pageM1.reactions[0].nicks.includes('ana'),
     'REST: reações na página do histórico')
  ok(pageM3.deleted === 1 && pageM3.replyTo === m1.id, 'REST: apagada mantém reply')

  // evento de sistema: stream sobe depois da 1ª varredura (que só povoa) e
  // depois sai — a sala "x" recebe "subiu ao ar" e "saiu do ar"
  const carol = await connect('carol', 'x')
  await carol.recv({ type: 'history' })
  await sleep(6000)                     // 1ª varredura fecha o conjunto
  bbLive = [{ streamKey: 'x', videoTracks: [{}] }]
  const up = await carol.recv({ type: 'chat', sys: 1, text: 'subiu ao ar' }, 10000)
  ok(typeof up.id === 'number', 'sistema: subiu ao ar')
  await sleep(6000)
  bbLive = []
  await carol.recv({ type: 'chat', sys: 1, text: 'saiu do ar' }, 10000)
  ok(true, 'sistema: saiu do ar')

  // o evento persistiu: quem abre a sala depois vê no histórico
  const dave = await connect('dave', 'x')
  const dh = await dave.recv({ type: 'history' })
  ok(dh.msgs.some(x => x.sys && x.text === 'subiu ao ar'), 'evento de sistema no histórico')

  ana.ws.close(); bruno.ws.close(); carol.ws.close(); dave.ws.close()
} catch (e) {
  failed++
  console.error('  ✗ exceção:', e.message)
}

killChild()
rmSync(dataDir, { recursive: true, force: true })
bb.close()
console.log(failed ? `chat.mjs: ${failed} falha(s)` : 'chat.mjs: tudo verde')
process.exit(failed ? 1 : 0)
