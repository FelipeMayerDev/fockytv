import assert from 'node:assert/strict'
import test from 'node:test'
import { jamDraw } from '../jam-draw.js'

test('draw: traço completo fica no estado e sai com o remetente', () => {
  const draw = jamDraw()
  assert.deepEqual(draw.sync(), { type: 'draw', action: 'sync', targets: [] })
  let relay = draw.apply({ type: 'draw', target: '222222', action: 'begin', id: 's1', color: 0 }, '111111')
  assert.equal(relay.from, '111111')
  relay = draw.apply({ type: 'draw', target: '222222', action: 'points', id: 's1', pts: [0, 0, 1.234, -5] }, '111111')
  assert.equal(relay.from, '111111')
  draw.apply({ type: 'draw', target: '222222', action: 'end', id: 's1' }, '111111')
  const sync = draw.sync()
  assert.equal(sync.targets.length, 1)
  assert.deepEqual(sync.targets[0], { target: '222222', allowed: true, strokes: [{ id: 's1', from: '111111', color: 0, pts: [0, 0, 1, 0] }] })
})

test('draw: undo remove o último do remetente, clear respeita o papel', () => {
  const draw = jamDraw()
  draw.apply({ type: 'draw', target: '222222', action: 'begin', id: 'a', color: 0 }, '111111')
  draw.apply({ type: 'draw', target: '222222', action: 'begin', id: 'b', color: 1 }, '999999')
  draw.apply({ type: 'draw', target: '222222', action: 'undo' }, '999999')
  let strokes = draw.sync().targets[0].strokes
  assert.deepEqual(strokes.map(s => s.id), ['a'], 'undo do espectador não alcança traço alheio')
  draw.apply({ type: 'draw', target: '222222', action: 'clear' }, '999999')
  strokes = draw.sync().targets[0].strokes
  assert.deepEqual(strokes.map(s => s.id), ['a'], 'clear de espectador apaga só o próprio')
  draw.apply({ type: 'draw', target: '222222', action: 'clear' }, '222222')
  assert.equal(draw.sync().targets[0].strokes.length, 0, 'dono apaga tudo')
})

test('draw: allow é privilégio do dono e o sync carrega o estado', () => {
  const draw = jamDraw()
  assert.equal(draw.apply({ type: 'draw', target: '222222', action: 'allow', on: false }, '999999'), null)
  assert.equal(draw.sync().targets.length, 0, 'allow negado nem cria estado')
  assert.equal(draw.apply({ type: 'draw', target: '222222', action: 'allow', on: false }, '222222').on, false)
  assert.equal(draw.sync().targets[0].allowed, false)
})

test('draw: laser só espelha, nunca guarda', () => {
  const draw = jamDraw()
  const relay = draw.apply({ type: 'draw', target: '222222', action: 'laser', pts: [0.5, 0.5] }, '111111')
  assert.deepEqual([relay.from, relay.pts], ['111111', [0.5, 0.5]])
  assert.deepEqual(draw.sync().targets[0].strokes, [])
  assert.equal(draw.apply({ type: 'draw', target: '222222', action: 'laser', pts: [0.5] }, '111111'), null)
  assert.equal(draw.apply({ type: 'draw', target: '222222', action: 'laser', pts: ['a', 1] }, '111111'), null)
})

test('draw: limites e validação', () => {
  const draw = jamDraw()
  // 65º traço derruba o mais antigo
  for (let i = 0; i < 65; i++)
    draw.apply({ type: 'draw', target: '222222', action: 'begin', id: `s${i}`, color: 4 }, '111111')
  const strokes = draw.sync().targets[0].strokes
  assert.equal(strokes.length, 64)
  assert.equal(strokes[0].id, 's1')
  // pontos além do teto são cortados, não rejeitados (três lotes válidos de 200 números)
  draw.apply({ type: 'draw', target: '222222', action: 'begin', id: 'g', color: 0 }, '111111')
  for (let i = 0; i < 3; i++)
    draw.apply({ type: 'draw', target: '222222', action: 'points', id: 'g', pts: Array.from({ length: 200 }, (_, j) => ((i * 200 + j) % 100) / 100) }, '111111')
  assert.equal(draw.sync().targets[0].strokes.find(s => s.id === 'g').pts.length, 250)
  // lote acima do teto por mensagem é rejeitado inteiro
  draw.apply({ type: 'draw', target: '222222', action: 'points', id: 'g', pts: Array.from({ length: 202 }, (_, j) => (j % 100) / 100) }, '111111')
  assert.equal(draw.sync().targets[0].strokes.find(s => s.id === 'g').pts.length, 250)
  // inválidos: cor fora da paleta, id longo, pts ímpar, pts não numérico, action desconhecida
  assert.equal(draw.apply({ type: 'draw', target: '222222', action: 'begin', id: 'x', color: 9 }, '111111'), null)
  assert.equal(draw.apply({ type: 'draw', target: '222222', action: 'begin', id: 'x'.repeat(41), color: 0 }, '111111'), null)
  draw.apply({ type: 'draw', target: '222222', action: 'begin', id: 'y', color: 0 }, '111111')
  assert.equal(draw.apply({ type: 'draw', target: '222222', action: 'points', id: 'y', pts: [0.5] }, '111111'), null)
  assert.equal(draw.apply({ type: 'draw', target: '222222', action: 'points', id: 'y', pts: [0.5, 'a'] }, '111111'), null)
  assert.equal(draw.apply({ type: 'draw', target: '222222', action: 'wipe', id: 'y' }, '111111'), null)
  assert.equal(draw.apply({ type: 'draw', target: 'não-numérico', action: 'begin', id: 'z', color: 0 }, '111111'), null)
  // begin duplicado do mesmo autor é ignorado
  assert.equal(draw.apply({ type: 'draw', target: '222222', action: 'begin', id: 'y', color: 0 }, '111111'), null)
})

test('draw: resync devolve um alvo sem criar estado novo', () => {
  const draw = jamDraw()
  draw.apply({ type: 'draw', target: '222222', action: 'begin', id: 'a', color: 2 }, '111111')
  const sync = draw.resync('222222')
  assert.deepEqual(sync.targets, [{ target: '222222', allowed: true, strokes: [{ id: 'a', from: '111111', color: 2, pts: [] }] }])
  assert.equal(draw.resync('abc'), null)
  // alvo inexistente volta vazio e não entra no mapa da sala
  assert.deepEqual(draw.resync('888888').targets, [{ target: '888888', allowed: true, strokes: [] }])
  assert.equal(draw.sync().targets.length, 1)
})

test('draw: sala com muitos alvos esquece o menos ativo', () => {
  let clock = 1000
  const draw = jamDraw(() => clock)
  for (let i = 0; i < 8; i++) draw.apply({ type: 'draw', target: `${1000000 + i}`, action: 'begin', id: `s${i}`, color: 0 }, '111111')
  clock += 5000
  draw.apply({ type: 'draw', target: '9999999', action: 'begin', id: 'novo', color: 0 }, '111111')
  const targets = draw.sync().targets.map(entry => entry.target)
  assert.equal(targets.length, 8)
  assert.equal(targets.includes('1000000'), false, 'alvo mais antigo sai')
  assert.equal(targets.includes('9999999'), true)
})
