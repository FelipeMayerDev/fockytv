// Teste de integração do canal de presença (/api/fixed/ws/presence) e do
// protocolo do hub jam que ele espelha. Sobe o próprio index.js numa porta
// efêmera (BB_URL aponta pro vazio: o WHIP do broadcast-box falha calado em
// background sem atrapalhar) e valida o contrato da issue #5:
//
//   npm test
//
// - observador que nunca entra em sala recebe snapshot + member-joined/left
// - membros seguem recebendo peer-joined/peer-left (mesh P2P intacto)
// - saída abrupta (socket destruído sem frame de close) também emite member-left
// - takeover de nick emite member-joined sem member-left falso
// - GET /api/fixed/jam (fallback do poll) segue batendo
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { WebSocket } from 'ws'

const freePort = () => new Promise((res, rej) => {
  const srv = createServer()
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => res(port)) })
  srv.on('error', rej)
})

const dataDir = mkdtempSync(join(tmpdir(), 'fockytv-presence-test-'))
const PORT = await freePort()
const child = spawn('node', ['index.js'], {
  cwd: new URL('..', import.meta.url).pathname,
  env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, BB_URL: 'http://127.0.0.1:1' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
const bootLog = []
child.stdout.on('data', d => bootLog.push(d))
child.stderr.on('data', d => bootLog.push(d))
const diedEarly = once(child, 'exit')
diedEarly.catch(() => {})   // exit no teardown não vira unhandled rejection

// garantia de morte: se o teste morrer fora do try (crash no boot do próprio
// teste), o filho não pode ficar órfão segurando porta e DATA_DIR. SIGKILL
// porque o servidor não trata sinais — não há grace period a respeitar.
const killChild = () => { try { child.kill('SIGKILL') } catch {} }
process.on('exit', killChild)
process.on('SIGINT', () => { killChild(); process.exit(130) })
process.on('SIGTERM', () => { killChild(); process.exit(143) })

// pronto quando o log de listen aparece (ou o processo morre antes disso)
await new Promise((res, rej) => {
  const check = () => {
    if (bootLog.join('').includes(`fixed-live na porta ${PORT}`)) return res()
    if (child.exitCode !== null) return rej(new Error('servidor morreu no boot:\n' + bootLog.join('')))
    setTimeout(check, 100)
  }
  check()
})

const base = `ws://127.0.0.1:${PORT}`
const jamUrl = (room, nick) => `${base}/api/fixed/ws/jam?room=${encodeURIComponent(room)}&nick=${encodeURIComponent(nick)}`

let failures = 0
const ok = (cond, name) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`)
  if (!cond) failures++
}

const next = (ws, pred, timeout = 3000) => new Promise(resolve => {
  const t = setTimeout(() => { ws.off('message', on); resolve(null) }, timeout)
  const on = raw => {
    let m
    try { m = JSON.parse(raw) } catch { return }
    if (!pred(m)) return
    clearTimeout(t); ws.off('message', on); resolve(m)
  }
  ws.on('message', on)
})

// asserção negativa: nada que case com pred pode chegar na janela
const none = (ws, pred, ms) => new Promise(resolve => {
  let bad = false
  const on = raw => {
    try { if (pred(JSON.parse(raw))) bad = true } catch {}
  }
  ws.on('message', on)
  setTimeout(() => { ws.off('message', on); resolve(!bad) }, ms)
})

const opened = ws => new Promise((res, rej) => { ws.on('open', () => res(ws)); ws.on('error', rej) })
const snapshotOf = async () => {
  const p = await opened(new WebSocket(`${base}/api/fixed/ws/presence`))
  const snap = await next(p, m => m.type === 'presence')
  p.close()
  return snap
}

try {
  // presença: o observador que nunca entra em sala nenhuma
  const p1 = await opened(new WebSocket(`${base}/api/fixed/ws/presence`))
  const snap1 = await next(p1, m => m.type === 'presence')
  ok(snap1 && Array.isArray(snap1.rooms) && 'total' in snap1, 'snapshot tem rooms[] e total')

  // membro entra: presença aprende na hora, sem poll
  const ana = await opened(new WebSocket(jamUrl('geral', 'ana')))
  const mj1 = await next(p1, m => m.type === 'member-joined')
  ok(mj1?.room === 'geral' && mj1?.nick === 'ana', 'member-joined traz room+nick certos')

  const snap2 = await snapshotOf()
  ok(snap2?.rooms?.some(r => r.room === 'geral' && r.members.includes('ana')),
    'snapshot lista geral:[ana] pra quem chega depois')

  // segundo membro: presença + o peer-joined clássico da ana (mesh intacto)
  // (listeners registrados ANTES de abrir a conexão: evento não se perde)
  const mjAna = next(ana, m => m.type === 'peer-joined')
  const mjBeto = next(p1, m => m.type === 'member-joined' && m.nick === 'beto')
  const beto = await opened(new WebSocket(jamUrl('geral', 'beto')))
  ok((await mjAna)?.nick === 'beto', 'peer-joined beto pra ana (mesh intacto)')
  ok(await mjBeto, 'member-joined beto pro observador')

  const api = await fetch(`http://127.0.0.1:${PORT}/api/fixed/jam`).then(r => r.json())
  ok(api.rooms?.some(r => r.room === 'geral' && r.members.length === 2) && api.total === 2,
    'GET /api/fixed/jam (fallback do poll) com jamSnapshot()')

  // saída limpa: presença recebe member-left; membro antigo recebe peer-left
  const ml1 = next(p1, m => m.type === 'member-left' && m.nick === 'beto')
  const plAna = next(ana, m => m.type === 'peer-left')
  beto.close()
  ok((await ml1)?.room === 'geral', 'member-left beto no observador')
  ok((await plAna)?.nick === 'beto', 'peer-left beto na ana (mesh intacto)')

  // saída abrupta (queda de rede: socket destruído sem frame de close)
  const beto2 = await opened(new WebSocket(jamUrl('geral', 'beto')))
  await next(p1, m => m.type === 'member-joined' && m.nick === 'beto')
  const ml2 = next(p1, m => m.type === 'member-left' && m.nick === 'beto')
  beto2.terminate()
  ok(await ml2, 'queda abrupta também emite member-left')

  const snap3 = await snapshotOf()
  ok(snap3?.rooms?.some(r => r.room === 'geral' && r.members.length === 1 && r.members[0] === 'ana'),
    'snapshot pós-saída: geral:[ana]')

  // takeover de nick: member-joined sim, member-left falso NÃO
  const ana2 = await opened(new WebSocket(jamUrl('geral', 'ana')))
  ok(await next(p1, m => m.type === 'member-joined' && m.nick === 'ana'),
    'member-joined no takeover')
  ok(await none(p1, m => m.type === 'member-left', 800),
    'takeover não emite member-left (guard de reconexão)')

  // ping/pong no canal de presença
  p1.send(JSON.stringify({ type: 'ping', t: 42 }))
  ok((await next(p1, m => m.type === 'pong'))?.t === 42, 'pong ecoa o t')

  // esvazia tudo: sala some do snapshot da próxima conexão
  const lastLeft = next(p1, m => m.type === 'member-left' && m.nick === 'ana')
  ana.close(); ana2.close()
  ok(await lastLeft, 'member-left quando o último sai')
  const snap4 = await snapshotOf()
  ok(!snap4?.rooms?.length && snap4?.total === 0 && snap4?.status === 'idle',
    'sala vazia desaparece do snapshot')

  p1.close()
} finally {
  killChild()
  // espera o filho sumir antes de apagar o DATA_DIR (SQLite deixa fds abertos)
  const gone = new Promise(res => child.exitCode !== null ? res() : child.on('exit', res))
  await Promise.race([gone, new Promise(res => setTimeout(res, 2000))])
  rmSync(dataDir, { recursive: true, force: true })
}

console.log(failures ? `\n${failures} falha(s)` : '\ntudo PASS')
process.exit(failures ? 1 : 0)
