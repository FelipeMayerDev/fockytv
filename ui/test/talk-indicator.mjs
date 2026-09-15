// Teste do indicador de fala (issue #3): a luz de "falando" não pode piscar.
// Roda o CÓDIGO REAL de ui/index.html (renderVoice + jamLevels + histerese)
// num DOM jsdom com relógio fake, simulando a cadência do worklet
// (ticks a cada ~125–200ms com pico da janela) e os re-renders do
// poll/presença que recriam as linhas da sidebar.
//
//   npm test   (na raiz)
//
// Os dois flickers da issue:
//   1. re-render (replaceChildren) apagava a classe talking até o próximo
//      tick de nível — agora renderVoice aplica o estado do mapa de histerese
//   2. limiar seco sobre pico de janela curta — agora histerese temporal:
//      acende acima de TALK_ON, apaga só TALK_HOLD depois do último pico alto
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { JSDOM } from 'jsdom'

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.html'), 'utf8')

// extrai uma função por contagem de chaves (as funções testadas não têm
// chaves dentro de strings — se um dia tiverem, o teste quebra alto, que é
// melhor do que testar silêncio errado). A primeira chave depois do parêntese
// de fechamento dos parâmetros é o corpo (jamLevels destructura `{self, peers}`)
const extractFn = (src, name) => {
  const start = src.indexOf(`function ${name}`)
  if (start < 0) throw new Error(`função ${name} não encontrada em ui/index.html`)
  let par = src.indexOf('(', start), pdepth = 0
  let i = start
  for (; i < src.length; i++) {
    if (src[i] === '(') pdepth++
    else if (src[i] === ')') { if (--pdepth === 0) break }
  }
  i = src.indexOf('{', i)
  let depth = 0
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1)
  }
  throw new Error(`${name}: chave de fechamento não encontrada`)
}

// bloco de constantes da histerese: de TALK_ON até o fim da linha do jamTalking
const extractBlock = (src, from, to) => {
  const a = src.indexOf(from)
  if (a < 0) throw new Error(`bloco ${from} não encontrado`)
  const b = src.indexOf(to, a)
  if (b < 0) throw new Error(`bloco ${to} não encontrado`)
  return src.slice(a, src.indexOf('\n', b) + 1)
}

const code = [
  extractBlock(html, 'const TALK_ON', 'const jamTalking'),
  extractFn(html, 'renderVoice'),
  extractFn(html, 'jamLevels'),
].join('\n')

const dom = new JSDOM(`<!doctype html><body>
  <div id="jam-pills"></div>
  <div id="voice-chans"></div>
  <button id="dock-mic"></button>
  <div id="jam-selfmeter"></div>
</body>`)
const { window } = dom

let now = 0
const sandbox = {
  document: window.document,
  CSS: window.CSS,
  Date: { now: () => now },
  Map, Set, Math, Object, String, Number, JSON, console,
  $: sel => window.document.querySelector(sel),
}
vm.createContext(sandbox)

// prelude + código extraído: estado global que as funções tocam
vm.runInContext(`
  let nick = 'ana'
  let jamJoined = false, jamRoom = null, jamPending = null, dockMuted = false
  const jamLeft = new Map()
  let voiceState = []
  const tiles = new Map()
  const VOICE_MAIN = 'geral', ESTUDIO_ROOM = 'sala'
  const jamToggleJoin = () => {}
  const toast = () => {}
${code}
`, sandbox)

let failures = 0
const ok = (cond, name) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`)
  if (!cond) failures++
}
const run = js => vm.runInContext(js, sandbox)
const talking = who => {
  const el = window.document.querySelector(`#voice-chans .vmem[data-peer="${who}"]`)
  return !!el?.classList.contains('talking')
}
const dock = () => window.document.querySelector('#dock-mic').classList.contains('talking')

// cena: eu (ana) e beto no canal geral, eu conectada
run(`voiceState = [{ room: 'geral', members: ['ana', 'beto'] }]
     jamJoined = true; jamRoom = 'geral'; renderVoice()`)
ok(window.document.querySelectorAll('#voice-chans .vmem').length === 2,
  'renderVoice lista ana e beto na sidebar')

// fala alta nos dois: acende na hora
now = 1000
run(`jamLevels({ self: 0.5, peers: { beto: { level: 0.4 } } })`)
ok(talking('ana') && talking('beto') && dock(),
  'pico acima de TALK_ON acende ana, beto e dock')

// pausa curta entre palavras (150ms de silêncio): NÃO pode apagar (flicker #2)
now = 1150
run(`jamLevels({ self: 0.001, peers: { beto: { level: 0.002 } } })`)
ok(talking('ana') && talking('beto'),
  'pausa de 150ms entre palavras mantém a luz acesa')

// ana segue falando; beto parou de verdade
now = 1300
run(`jamLevels({ self: 0.5, peers: { beto: { level: 0.001 } } })`)
ok(talking('ana'), 'ana reacende com novo pico')
ok(talking('beto'), 'beto ainda aceso dentro do hold (300ms < 350ms)')

// beto passa do hold; e chega o re-render do poll/presença no meio da fala
now = 1420
run(`jamLevels({ self: 0.001, peers: { beto: { level: 0.001 } } })`)
ok(!talking('beto'), 'beto apaga após 350ms+ sem pico alto')
ok(talking('ana'), 'ana segue acesa (renovou em 1300)')
now = 1500
run('renderVoice()')
ok(talking('ana'), 're-render (poll/presença) preserva talking de quem fala (flicker #1)')
ok(!talking('beto'), 're-render não acende quem não está falando')

// ana para: apaga só depois do hold
now = 1700
run(`jamLevels({ self: 0.001, peers: {} })`)
ok(!talking('ana') && !dock(), 'ana apaga após o hold; dock junto')

// pico abaixo do limiar não acende
now = 2100
run(`jamLevels({ self: 0.02, peers: {} })`)
ok(!talking('ana'), 'pico 0.02 (abaixo de TALK_ON) não acende')

// mic mutado pelo dock: linha acende, botão não
now = 2200
run(`dockMuted = true; jamLevels({ self: 0.5, peers: {} })`)
ok(talking('ana') && !dock(), 'dock mutado não acende, mesmo com pico alto')
run('dockMuted = false')

// sair da sala limpa o estado: nada de luz sobrando
now = 2300
run(`jamLevels({ self: 0.5, peers: {} }); jamLoudAt.clear(); renderVoice()`)
ok(!talking('ana') && !talking('beto'), 'sair da sala apaga a luz de todo mundo')

console.log(failures ? `\n${failures} falha(s)` : '\ntudo PASS')
process.exit(failures ? 1 : 0)
